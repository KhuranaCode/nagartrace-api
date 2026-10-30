/** Gmail product OAuth + exact-body authority send (src/gmail.ts, real module, real PG).
 *  All Google endpoints are intercepted by an injected fetchImpl: NO real Google calls. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, sign, client, reportBody, P_NOROAD, type World } from './helpers.ts';
import { encryptToken, decryptToken, verifyState } from '../src/gmail.ts';
import { randomBytes } from 'node:crypto';

const KEY = randomBytes(32).toString('base64');
const GCFG = { gmailOAuth: { clientId: 'cid-test', clientSecret: 'csec-test', redirectUri: 'https://app.test/gmail/callback' }, gmailTokenKey: KEY };
const uniq = () => Math.random().toString(36).slice(2, 10);

let w: World;
const google: any = { tokenCalls: 0, sendCalls: 0, userinfoCalls: 0, revokeCalls: 0 };
const fetchImpl = (async (url: any, init: any) => {
  const u = String(url);
  if (u === 'https://oauth2.googleapis.com/token') {
    google.tokenCalls++;
    const params = new URLSearchParams(init.body);
    if (params.get('grant_type') === 'authorization_code') {
      // Honest Google stand-in: it issued 'code-ok' only for the challenge of the verifier it saw.
      if (params.get('code') !== 'code-ok' || params.get('code_verifier') !== google.validVerifier)
        return { status: 400, json: async () => ({}) } as any;
      const ex = google.exchange ?? { access_token: 'at-1', refresh_token: 'rt-1', scope: 'openid email https://www.googleapis.com/auth/gmail.send' };
      return { status: ex.error ? 400 : 200, json: async () => ex } as any;
    }
    return { status: 200, json: async () => google.refresh ?? { access_token: 'at-2' } } as any;
  }
  if (u === 'https://www.googleapis.com/oauth2/v3/userinfo') {
    google.userinfoCalls++;
    return { status: 200, json: async () => google.userinfo ?? { sub: 'gsub-1', email: 'citizen@gmail.com', email_verified: true } } as any;
  }
  if (u === 'https://oauth2.googleapis.com/revoke') { google.revokeCalls++; return { status: google.revokeStatus ?? 200, json: async () => ({}) } as any; }
  if (u === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
    google.sendCalls++;
    return google.sendPlan ? google.sendPlan() : ({ status: 200, json: async () => ({ id: 'gmsg-1', threadId: 'gthr-1' }) } as any);
  }
  throw new Error('unexpected URL ' + u);
}) as any;

before(async () => { w = await newWorld(GCFG, undefined, undefined, { fetchImpl }); });
after(() => w.close());
const mk = () => sign('u-' + uniq()).then((t) => client(w, t));
/** The honest client flow: start -> keep state+verifier locally -> callback returns BOTH. */
const connect = async (c: ReturnType<typeof client>) => {
  google.exchange = undefined; google.sendPlan = undefined; // no leakage between tests
  google.userinfo = { sub: 'gsub-' + uniq(), email: `c-${uniq()}@gmail.com`, email_verified: true }; // one Google account per user
  const s = await c.post('/v1/integrations/gmail/start', {});
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const { state, code_verifier } = s.json;
  assert.ok(/^[A-Za-z0-9\-._~]{43,128}$/.test(code_verifier), 'verifier returned to the client');
  google.validVerifier = code_verifier; // Google stand-in binds the code to this challenge
  const bad = await c.post('/v1/integrations/gmail/callback', { state, code: 'code-ok', code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-000000' });
  assert.equal(bad.status, 502, 'a wrong verifier must fail at Google (exchange 400 -> honest 502)');
  const ok = await c.post('/v1/integrations/gmail/callback', { state, code: 'code-ok', code_verifier });
  return { state, code_verifier, ok };
};

test('token crypto: AES-256-GCM roundtrip, wrong key fails, ciphertext differs', () => {
  const k = randomBytes(32); const enc = encryptToken(k, 'rt-secret');
  assert.notEqual(enc.toString('utf8'), 'rt-secret');
  assert.equal(decryptToken(k, enc), 'rt-secret');
  assert.throws(() => decryptToken(randomBytes(32), enc));
});

test('unconfigured deployment: routes not mounted (404)', async () => {
  const w2 = await newWorld();
  try {
    const c = client(w2, await sign('u-x'));
    assert.equal((await c.post('/v1/integrations/gmail/start', {})).status, 404);
    assert.equal((await c.get('/v1/integrations/gmail/status')).status, 404);
  } finally { await w2.close(); }
});

test('start: consent URL carries PKCE S256, minimum scope, offline access, bound state', async () => {
  const c = await mk();
  const r = await c.post('/v1/integrations/gmail/start', {});
  assert.equal(r.status, 200);
  const u = new URL(r.json.consent_url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(u.searchParams.get('code_challenge'));
  assert.equal(u.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('client_id'), 'cid-test');
  // State bound to THIS user: another user cannot redeem it.
  const other = await mk();
  const cb = await other.post('/v1/integrations/gmail/callback', { state: r.json.state, code: 'x', code_verifier: 'stolen-verifier-stolen-verifier-stolen-verifier-000' });
  assert.equal(cb.status, 403);
});

test('state forgery rejected', () => {
  const k = Buffer.from(KEY, 'base64');
  assert.throws(() => verifyState(k, 'AAAA.BBBB', 'u-1'));
});

test('callback: honest failures (exchange 400, missing refresh token, unverified email)', async () => {
  const c = await mk();
  const s1 = (await c.post('/v1/integrations/gmail/start', {})).json;
  google.validVerifier = s1.code_verifier;
  google.exchange = { error: 'invalid_grant' }; // Google-side failure
  assert.equal((await c.post('/v1/integrations/gmail/callback', { state: s1.state, code: 'code-ok', code_verifier: s1.code_verifier })).status, 502);
  const s2 = (await c.post('/v1/integrations/gmail/start', {})).json;
  google.validVerifier = s2.code_verifier; google.exchange = { access_token: 'at-1' }; // no refresh_token
  assert.equal((await c.post('/v1/integrations/gmail/callback', { state: s2.state, code: 'code-ok', code_verifier: s2.code_verifier })).status, 409);
  const s3 = (await c.post('/v1/integrations/gmail/start', {})).json;
  google.validVerifier = s3.code_verifier; google.exchange = undefined; google.userinfo = { sub: 'gsub-9', email: 'v@gmail.com', email_verified: false };
  assert.equal((await c.post('/v1/integrations/gmail/callback', { state: s3.state, code: 'code-ok', code_verifier: s3.code_verifier })).status, 502);
  google.userinfo = undefined;
});

test('connect stores ONLY an encrypted token; status shows the connection', async () => {
  const c = await mk();
  const { ok: cb } = await connect(c);
  assert.equal(cb.status, 200, JSON.stringify(cb.json));
  const row = (await w.adminDb.query(`SELECT google_sub, email, refresh_token_enc FROM gmail_connection WHERE email=$1`, [cb.json.email])).rows[0];
  assert.ok(row.google_sub.startsWith('gsub-'));
  const enc: Buffer = row.refresh_token_enc;
  assert.ok(!enc.includes(Buffer.from('rt-1')), 'plaintext refresh token never stored');
  assert.equal(decryptToken(Buffer.from(KEY, 'base64'), enc), 'rt-1');
  const st2 = await c.get('/v1/integrations/gmail/status');
  assert.equal(st2.json.connected, true);
});

test('authority send: exact body sha stored, accepted-never-delivered, replay/idempotency, unknown/failed truth, no-autoretry', async () => {
  const c = await mk();
  await connect(c);
  const rep = await c.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.11, lon: P_NOROAD.lon + 0.11 }));
  const issueId = rep.json.issue.id;
  const key = 'gm-' + uniq();
  const body = { to: 'mc@example.gov.in', subject: 'Road hazard NT-000001', body_text: 'Exact reviewed text.', idempotency_key: key };
  const sendsBefore = google.sendCalls;
  const s1 = await c.post(`/v1/issues/${issueId}/authority-emails`, body);
  assert.equal(s1.status, 201, JSON.stringify(s1.json));
  assert.equal(s1.json.status, 'accepted'); // NEVER 'delivered'
  assert.equal(s1.json.gmail_message_id, 'gmsg-1');
  assert.equal(google.sendCalls, sendsBefore + 1);
  const row = (await w.adminDb.query(`SELECT body_sha256, status FROM authority_email WHERE id=$1`, [s1.json.email_id])).rows[0];
  assert.equal(row.status, 'accepted');
  // identical replay: 200, no second send
  const s2 = await c.post(`/v1/issues/${issueId}/authority-emails`, body);
  assert.equal(s2.status, 200); assert.equal(s2.json.replayed, true);
  assert.equal(google.sendCalls, sendsBefore + 1);
  // changed payload, same key: 409
  const s3 = await c.post(`/v1/issues/${issueId}/authority-emails`, { ...body, body_text: 'Changed.' });
  assert.equal(s3.status, 409);
  // Gmail 500: outcome AMBIGUOUS -> recorded 'unknown', NO automatic retry (exactly one send call for this key)
  google.sendPlan = () => ({ status: 500, json: async () => ({}) });
  const sendsBefore2 = google.sendCalls;
  const s4 = await c.post(`/v1/issues/${issueId}/authority-emails`, { ...body, idempotency_key: 'gm-' + uniq() });
  assert.equal(s4.status, 502); assert.equal(s4.json.status, 'unknown');
  assert.equal(google.sendCalls, sendsBefore2 + 1);
  const unk = (await w.adminDb.query(`SELECT status, gmail_message_id FROM authority_email WHERE id=$1`, [s4.json.email_id])).rows[0];
  assert.equal(unk.status, 'unknown'); assert.equal(unk.gmail_message_id, null);
  // Gmail definitive rejection (4xx): recorded 'failed'
  google.sendPlan = () => ({ status: 403, json: async () => ({}) });
  const s5 = await c.post(`/v1/issues/${issueId}/authority-emails`, { ...body, idempotency_key: 'gm-' + uniq() });
  assert.equal(s5.status, 502); assert.equal(s5.json.status, 'failed');
  // Transport failure (timeout): Gmail may have received it -> 'unknown'
  google.sendPlan = () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); };
  const sendsBefore3 = google.sendCalls;
  const s6 = await c.post(`/v1/issues/${issueId}/authority-emails`, { ...body, idempotency_key: 'gm-' + uniq() });
  assert.equal(s6.status, 502); assert.equal(s6.json.status, 'unknown');
  assert.equal(google.sendCalls, sendsBefore3 + 1, 'one attempt, never an automatic retry');
  const unk2 = (await w.adminDb.query(`SELECT status, error FROM authority_email WHERE id=$1`, [s6.json.email_id])).rows[0];
  assert.equal(unk2.status, 'unknown'); assert.equal(unk2.error, 'gmail_timeout');
  google.sendPlan = undefined;
});

test('send without a connection: honest 409', async () => {
  const c = await mk();
  const rep = await c.post('/v1/reports', reportBody({ lat: P_NOROAD.lat - 0.11, lon: P_NOROAD.lon - 0.11 }));
  const r = await c.post(`/v1/issues/${rep.json.issue.id}/authority-emails`, { to: 'mc@example.gov.in', subject: 's', body_text: 'b', idempotency_key: 'gm-' + uniq() });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'gmail_not_connected');
});

test('rotated/missing token key fails closed: reconnect required, never a 500, no auto-retry', async () => {
  const c = await mk();
  await connect(c);
  const rep = await c.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.13, lon: P_NOROAD.lon + 0.13 }));
  // Simulate key rotation by re-encrypting every stored token under a different key.
  const otherKey = randomBytes(32);
  await w.adminDb.query(`UPDATE gmail_connection SET refresh_token_enc=$1`, [encryptToken(otherKey, 'rt-1')]);
  const sendsBefore = google.sendCalls;
  const r = await c.post(`/v1/issues/${rep.json.issue.id}/authority-emails`, { to: 'mc@example.gov.in', subject: 's', body_text: 'b', idempotency_key: 'gm-' + uniq() });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.error, 'gmail_not_connected');
  assert.equal(google.sendCalls, sendsBefore, 'no send attempted with an undecryptable token');
});

test('disconnect: local revoke always applies; google_revoked reported truthfully', async () => {
  const c = await mk();
  await connect(c);
  google.revokeStatus = 200;
  const d1 = await c.post('/v1/integrations/gmail/disconnect', {});
  assert.equal(d1.json.disconnected, true); assert.equal(d1.json.google_revoked, true);
  assert.equal((await c.get('/v1/integrations/gmail/status')).json.connected, false);
  await connect(c);
  google.revokeStatus = 500;
  const d2 = await c.post('/v1/integrations/gmail/disconnect', {});
  assert.equal(d2.json.disconnected, true); assert.equal(d2.json.google_revoked === false, true);
});
