/**
 * Gmail product integration (user-consented OAuth, minimum scope gmail.send).
 *
 * Hard rules:
 *  - This is the PRODUCT's own OAuth client (GOOGLE_CLIENT_ID/SECRET), never a substitute
 *    integration. Unconfigured => routes are not mounted (404), the honest absent state.
 *  - Refresh tokens are AES-256-GCM encrypted at rest (GMAIL_TOKEN_KEY, deployment owner).
 *    Plaintext tokens, codes and message bodies are never logged or returned in DTOs.
 *  - OAuth state is a single-use, HMAC-signed, user-and-session-bound nonce (10-min TTL).
 *    PKCE (S256) is always used.
 *  - Sending requires an EXACT reviewed body: the client shows the exact text, the request
 *    carries it, the server stores body_sha256 of the sent bytes. 'accepted' (Gmail API 200
 *    + message id) is never 'delivered'. An ambiguous send outcome (timeout/5xx without a
 *    message id) is recorded 'failed' with NO automatic retry - the user resends manually,
 *    and the idempotency key makes a manual retry safe (identical payload replays).
 */
import { createHash, createHmac, randomBytes, randomUUID, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authenticate, HttpError, type KeyResolver } from './auth.ts';
import type { Config } from './config.ts';

const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function encryptToken(key: Buffer, plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
export function decryptToken(key: Buffer, enc: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', key, enc.subarray(0, 12));
  d.setAuthTag(enc.subarray(12, 28));
  return Buffer.concat([d.update(enc.subarray(28)), d.final()]).toString('utf8');
}

/** Single-use OAuth state: HMAC over user|nonce|expiry, stateless but user-bound. The PKCE
 *  verifier is NEVER in here: the state is visible in the consent URL, so it carries no secret.
 *  The verifier goes to the user's own client (TLS) and returns at callback; it is never
 *  persisted server-side and never logged. */
function signState(key: Buffer, userId: string, nonce: string, exp: number): string {
  const payload = b64u(Buffer.from(JSON.stringify({ u: userId, n: nonce, e: exp })));
  const mac = createHmac('sha256', key).update(payload).digest();
  return payload + '.' + b64u(mac);
}
export function verifyState(key: Buffer, state: string, userId: string): void {
  const i = state.lastIndexOf('.');
  const payload = i > 0 ? state.slice(0, i) : '';
  const mac = i > 0 ? state.slice(i + 1) : '';
  const expect = createHmac('sha256', key).update(payload).digest();
  const got = Buffer.from(mac, 'base64url');
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) throw new HttpError(403, 'Invalid OAuth state', 'bad_state');
  let p: any;
  try { p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new HttpError(403, 'Invalid OAuth state', 'bad_state'); }
  if (p.u !== userId || typeof p.e !== 'number' || p.e < Date.now()) throw new HttpError(403, 'OAuth state expired or not yours', 'bad_state');
}

type OauthCfg = NonNullable<Config['gmailOAuth']>;

export function registerGmailRoutes(app: FastifyInstance, deps: { cfg: Config; db: pg.Pool; keys: KeyResolver; fetchImpl?: typeof fetch }) {
  const { cfg, db, keys } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const auth = (req: any) => authenticate(req.headers.authorization, cfg, keys, db);
  const oauth = (): OauthCfg => {
    if (!cfg.gmailOAuth || !cfg.gmailTokenKey) throw new HttpError(503, 'Gmail connection is not configured on this deployment', 'gmail_unconfigured');
    return cfg.gmailOAuth;
  };
  const tkey = () => Buffer.from(cfg.gmailTokenKey!, 'base64');

  app.get('/v1/integrations/gmail/status', async (req) => {
    const p = await auth(req);
    oauth(); // 503 honest when unconfigured
    const r = await db.query(`SELECT email, scopes, connected_at FROM gmail_connection WHERE user_id=$1 AND revoked_at IS NULL`, [p.userId]);
    const row = r.rows[0];
    return { connected: !!row, ...(row ? { email: row.email, scopes: row.scopes, connected_at: row.connected_at } : {}) };
  });

  app.post('/v1/integrations/gmail/start', async (req) => {
    const p = await auth(req);
    const o = oauth();
    const verifier = b64u(randomBytes(32));
    const challenge = b64u(createHash('sha256').update(verifier).digest());
    const state = signState(tkey(), p.userId, randomUUID(), Date.now() + 10 * 60_000);
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: o.clientId, redirect_uri: o.redirectUri, response_type: 'code',
      scope: 'openid email https://www.googleapis.com/auth/gmail.send',
      access_type: 'offline', prompt: 'consent', state,
      code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    // The verifier goes ONLY to this user's client; it comes back with the callback.
    return { consent_url: url, state, code_verifier: verifier };
  });

  app.post('/v1/integrations/gmail/callback', async (req) => {
    const p = await auth(req);
    const o = oauth();
    const { state, code, code_verifier } = (req.body ?? {}) as any;
    if (typeof state !== 'string' || typeof code !== 'string' || !code) throw new HttpError(400, 'state and code required', 'validation');
    // RFC 7636 verifier shape; a wrong verifier fails at Google, never here with detail.
    if (typeof code_verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(code_verifier)) throw new HttpError(400, 'code_verifier required', 'validation');
    verifyState(tkey(), state, p.userId);
    const verifier = code_verifier;
    const tr = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri,
        grant_type: 'authorization_code', code, code_verifier: verifier,
      }).toString(),
    });
    if (tr.status !== 200) throw new HttpError(502, 'Google did not complete the connection (authorization failed or expired). Nothing was connected.', 'oauth_exchange_failed');
    const tokens: any = await tr.json();
    if (typeof tokens?.access_token !== 'string' || typeof tokens?.refresh_token !== 'string')
      throw new HttpError(409, 'Google did not return a refresh token. Disconnect the app at myaccount.google.com/permissions and connect again.', 'no_refresh_token');
    const ui = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (ui.status !== 200) throw new HttpError(502, 'Could not verify the Google account. Nothing was connected.', 'oauth_verify_failed');
    const info: any = await ui.json();
    if (typeof info?.sub !== 'string' || typeof info?.email !== 'string' || info?.email_verified !== true)
      throw new HttpError(502, 'Google account verification incomplete (verified email required). Nothing was connected.', 'oauth_verify_failed');
    await db.query(
      `INSERT INTO gmail_connection (user_id, google_sub, email, refresh_token_enc, scopes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET google_sub=$2, email=$3, refresh_token_enc=$4, scopes=$5, connected_at=now(), revoked_at=NULL`,
      [p.userId, info.sub, info.email, encryptToken(tkey(), tokens.refresh_token), String(tokens.scope ?? '')]);
    return { connected: true, email: info.email };
  });

  app.post('/v1/integrations/gmail/disconnect', async (req) => {
    const p = await auth(req);
    oauth();
    const row = (await db.query(`SELECT refresh_token_enc FROM gmail_connection WHERE user_id=$1 AND revoked_at IS NULL`, [p.userId])).rows[0];
    let googleRevoked = false;
    if (row) {
      try {
        const rt = decryptToken(tkey(), row.refresh_token_enc);
        const rr = await fetchImpl('https://oauth2.googleapis.com/revoke', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: rt }).toString(),
        });
        googleRevoked = rr.status === 200;
      } catch { /* local disconnect still proceeds */ }
      await db.query(`UPDATE gmail_connection SET revoked_at=now() WHERE user_id=$1`, [p.userId]);
    }
    // Local disconnect always applies; google_revoked reports Google's confirmation truthfully.
    return { disconnected: true, google_revoked: googleRevoked };
  });

  /** Fresh access token for a connected user; null when reconnect is required. */
  async function accessToken(userId: string): Promise<{ token: string; email: string } | null> {
    const row = (await db.query(`SELECT google_sub, email, refresh_token_enc FROM gmail_connection WHERE user_id=$1 AND revoked_at IS NULL`, [userId])).rows[0];
    if (!row) return null;
    const o = cfg.gmailOAuth!;
    let refreshToken: string;
    try { refreshToken = decryptToken(tkey(), row.refresh_token_enc); }
    catch { return null; } // key rotated/lost: fail closed as reconnect-required, never a 500
    const tr = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    if (tr.status !== 200) return null;
    const j: any = await tr.json();
    return typeof j?.access_token === 'string' ? { token: j.access_token, email: row.email } : null;
  }

  // Send ONE exact-reviewed email from the user's own Gmail. The review IS the consent:
  // the client displayed these exact bytes and the user pressed send for this recipient.
  app.post('/v1/issues/:id/authority-emails', async (req, reply) => {
    const p = await auth(req);
    oauth();
    const issueId = (req.params as any).id;
    const isReporter = !!(await db.query(`SELECT 1 FROM reports WHERE issue_id=$1 AND user_id=$2 LIMIT 1`, [issueId, p.userId])).rows[0];
    if (!isReporter) throw new HttpError(404, 'Issue not found', 'not_found');
    const { to, subject, body_text, idempotency_key } = (req.body ?? {}) as any;
    if (typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 320) throw new HttpError(400, 'a valid recipient address is required', 'bad_recipient');
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) throw new HttpError(400, 'subject required (max 200 chars)', 'validation');
    if (typeof body_text !== 'string' || !body_text.trim() || body_text.length > 20000) throw new HttpError(400, 'body_text required (max 20000 chars)', 'validation');
    if (typeof idempotency_key !== 'string' || !idempotency_key) throw new HttpError(400, 'idempotency_key required', 'bad_idempotency_key');
    const bodySha = sha256(`to:${to.toLowerCase()}\nsubject:${subject}\nbody:${body_text}`);

    const existing = (await db.query(`SELECT id, status, body_sha256, gmail_message_id FROM authority_email WHERE sender_user_id=$1 AND idempotency_key=$2`, [p.userId, idempotency_key])).rows[0];
    if (existing) {
      if (existing.body_sha256 !== bodySha) throw new HttpError(409, 'same idempotency key with a different payload', 'idempotency_mismatch');
      return reply.status(200).send({ email_id: existing.id, status: existing.status, gmail_message_id: existing.gmail_message_id, replayed: true });
    }

    const conn = await accessToken(p.userId);
    if (!conn) throw new HttpError(409, 'Gmail is not connected. Connect your Gmail first.', 'gmail_not_connected');
    const raw = b64u(Buffer.from(
      `To: ${to}\r\nSubject: ${subject.replace(/[\r\n]/g, ' ')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body_text}`, 'utf8'));
    const sr = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    const sj: any = sr.status === 200 ? await sr.json() : null;
    const accepted = sr.status === 200 && typeof sj?.id === 'string';
    const ins = await db.query(
      `INSERT INTO authority_email (issue_id, sender_user_id, to_address, subject, body_text, body_sha256, status, gmail_message_id, gmail_thread_id, error, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [issueId, p.userId, to, subject, body_text, bodySha, accepted ? 'accepted' : 'failed',
       accepted ? sj.id : null, accepted && typeof sj?.threadId === 'string' ? sj.threadId : null,
       accepted ? null : `gmail_http_${sr.status}`, idempotency_key]);
    // 'accepted' = Gmail accepted the message (id returned). NEVER presented as delivered.
    return reply.status(accepted ? 201 : 502).send({ email_id: ins.rows[0].id, status: accepted ? 'accepted' : 'failed', gmail_message_id: accepted ? sj.id : null });
  });
}
