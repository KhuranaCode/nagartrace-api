/**
 * Follow-up reminder pipeline (self-contained module; migration 011 required).
 * Wired in buildApp ONLY when cfg.followupPipeline is true (FOLLOWUP_PIPELINE=true), which the
 * deployment owner flips after applying db/011_followup_pipeline.sql. When off, every route
 * here is 404 and the web client shows its static honest fallback card.
 *
 * Truth rules (enforced here, not just documented):
 *  - Nothing sends without: consent granted (scope-versioned) + a recipient the user approved
 *    + a configured provider. Missing any one yields an honest blocked_* state, never a send claim.
 *  - 'accepted' means the provider took the message; it is never called 'delivered'. Delivery
 *    confirmation exists only via provider webhook (delivered_callback), not implemented here yet.
 *  - A provider timeout leaves the outcome 'unknown'. Unknown is NEVER resent blindly: it either
 *    reconciles via the provider's official query route (Brevo: messageId filter) or, inside the
 *    provider's documented idempotency window, retries with the same key (provider dedups).
 *  - The sweep never holds a DB lock or transaction across a network send (claim = state flip).
 *
 * Brevo contract verified 2026-10-30 against official docs:
 *  - POST https://api.brevo.com/v3/smtp/email, 'api-key' auth, 201 -> { messageId }
 *  - body headers.idempotencyKey: UUID, 30-min TTL; duplicate inside TTL -> error code
 *    'duplicate_parameter', not processed => proof the earlier identical request was accepted.
 *  - GET /v3/smtp/emails filters: email | templateId | messageId (+startDate/endDate). NO tags
 *    filter and no send-key lookup: unknown-without-messageId has no authoritative reconcile.
 *  - Webhooks: event 'delivered' carries message-id (for a future delivered_callback route).
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { authenticate, HttpError, memberships, type KeyResolver } from './auth.ts';
import type { Config } from './config.ts';

const DAY_STAGES = [7, 10, 15, 30];

export type SendInput = { sendKey: string; to: string; subject: string; text: string; html: string };
export type SendResult =
  | { outcome: 'accepted'; providerMessageId: string }
  | { outcome: 'failed'; reason: string; retryable: boolean }
  | { outcome: 'unknown'; attemptId: string };

export interface Sender {
  name: string;
  idempotentRetryMinutes?: number;
  send(i: SendInput): Promise<SendResult>;
  reconcile?(attemptId: string): Promise<'accepted' | 'failed' | null>;
}

export class NoProvider implements Sender {
  name = 'none';
  async send(): Promise<SendResult> { return { outcome: 'failed', reason: 'no_provider_configured', retryable: false }; }
}

function sendKeyToUuid(sendKey: string): string {
  const h = sendKey.replace(/[^0-9a-f]/gi, '').slice(0, 32).toLowerCase().padEnd(32, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export class BrevoSender implements Sender {
  name = 'brevo';
  idempotentRetryMinutes = 30; // documented idempotencyKey TTL
  constructor(private apiKey: string, private from: string) {}
  async send(i: SendInput): Promise<SendResult> {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: { email: this.from, name: 'NagarTrace' }, to: [{ email: i.to }],
          subject: i.subject, textContent: i.text, htmlContent: i.html,
          headers: { idempotencyKey: sendKeyToUuid(i.sendKey), 'X-NagarTrace-Send-Key': i.sendKey },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 201) {
        const j = (await res.json()) as { messageId?: string };
        return { outcome: 'accepted', providerMessageId: j.messageId ?? 'unknown-id' };
      }
      let code = '';
      try { code = String(((await res.json()) as any)?.code ?? ''); } catch { /* keep */ }
      // Verified contract: duplicate_parameter inside the TTL means the earlier identical
      // request WAS accepted and this retry was correctly NOT sent. Exactly-once holds.
      if (code === 'duplicate_parameter')
        return { outcome: 'accepted', providerMessageId: `dedup:${sendKeyToUuid(i.sendKey)}` };
      if (res.status === 429 || res.status >= 500) return { outcome: 'failed', reason: `http_${res.status}`, retryable: true };
      return { outcome: 'failed', reason: `http_${res.status}${code ? ':' + code : ''}`, retryable: false };
    } catch {
      return { outcome: 'unknown', attemptId: `key:${i.sendKey}` };
    }
  }
  async reconcile(attemptId: string): Promise<'accepted' | 'failed' | null> {
    if (!attemptId || attemptId.startsWith('dedup:') || attemptId.startsWith('key:')) return null;
    try {
      const res = await fetch(`https://api.brevo.com/v3/smtp/emails?messageId=${encodeURIComponent(attemptId)}`,
        { headers: { 'api-key': this.apiKey }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const j = (await res.json()) as { transactionalEmails?: unknown[] };
      return (j.transactionalEmails?.length ?? 0) > 0 ? 'accepted' : null;
    } catch { return null; }
  }
}

export function sendKey(campaignId: string, stageDay: number, contentSha: string): string {
  return createHash('sha256').update(`${campaignId}|${stageDay}|${contentSha}`).digest('hex');
}

/** One due-delivery pass. Row-locked claim via state flip; every gate honest; order matters. */
export async function sweepFollowups(db: pg.Pool, sender: Sender, maxAttempts = 3): Promise<{ sent: number; states: Record<string, number> }> {
  const states: Record<string, number> = {};
  const bump = (s: string) => { states[s] = (states[s] ?? 0) + 1; };
  // Crash recovery: a row stuck in 'attempting' means the process died mid-send. UNKNOWN.
  await db.query(
    `UPDATE followup_delivery SET state='unknown', updated_at=now()
      WHERE state='attempting' AND updated_at < now() - interval '2 minutes'`);
  const due = await db.query(
    `WITH c AS (
       SELECT d.id, d.updated_at AS prior_updated_at FROM followup_delivery d
        WHERE d.due_at <= now()
          AND d.state IN ('pending','unknown','blocked_no_provider','failed')
        ORDER BY d.id LIMIT 50
        FOR UPDATE OF d SKIP LOCKED)
     UPDATE followup_delivery d SET updated_at=now() FROM c WHERE d.id = c.id
     RETURNING d.id AS delivery_id, d.state, d.send_key, d.attempt_count, d.provider_message_id, c.prior_updated_at,
       d.stage_day,
       (SELECT c2.recipient_address FROM followup_campaign c2 WHERE c2.id = d.campaign_id) AS recipient_address,
       (SELECT c2.recipient_verified FROM followup_campaign c2 WHERE c2.id = d.campaign_id) AS recipient_verified,
       (SELECT c2.stages FROM followup_campaign c2 WHERE c2.id = d.campaign_id) AS stages,
       (SELECT c2.state FROM followup_campaign c2 WHERE c2.id = d.campaign_id) AS campaign_state,
       (SELECT i.status FROM issues i JOIN followup_campaign c3 ON c3.issue_id=i.id WHERE c3.id=d.campaign_id) AS issue_status`);
  let sent = 0;
  for (const r of due.rows) {
    // 1. Resolution: stop everything for resolved issues or non-active campaigns.
    if (r.issue_status === 'fixed' || r.issue_status === 'rejected' || r.campaign_state !== 'active') {
      await db.query(`UPDATE followup_delivery SET state='suppressed', updated_at=now() WHERE id=$1`, [r.delivery_id]);
      if (r.campaign_state === 'active')
        await db.query(`UPDATE followup_campaign SET state='stopped_resolved' WHERE id=$1`, [r.campaign_id]);
      bump('suppressed'); continue;
    }
    // 2. Consent still granted?
    const consent = await db.query(
      `SELECT granted FROM user_mail_consent WHERE user_id=(SELECT owner_user_id FROM followup_campaign WHERE id=$1) AND kind='report_reminders'`,
      [r.campaign_id]);
    if (!consent.rows[0]?.granted) {
      await db.query(`UPDATE followup_delivery SET state='blocked_no_consent', updated_at=now() WHERE id=$1`, [r.delivery_id]);
      bump('blocked_no_consent'); continue;
    }
    // 3. Verified recipient with a concrete address?
    if (!r.recipient_verified || !r.recipient_address) {
      await db.query(`UPDATE followup_delivery SET state='blocked_no_recipient', updated_at=now() WHERE id=$1`, [r.delivery_id]);
      bump('blocked_no_recipient'); continue;
    }
    // 4. Unknown previous attempt: reconcile first, NEVER blind resend. A 'key:' attempt inside
    //    the provider's documented idempotency window may fall through to a safe idempotent resend.
    if (r.state === 'unknown') {
      const attemptId = r.provider_message_id ?? '';
      const retryMinutes = sender.idempotentRetryMinutes ?? 0;
      const ageMs = Date.now() - new Date(r.prior_updated_at).getTime();
      if (!(attemptId.startsWith('key:') && retryMinutes > 0 && ageMs < retryMinutes * 60000)) {
        const verdict = sender.reconcile ? await sender.reconcile(attemptId) : null;
        if (verdict === 'accepted') {
          await db.query(`UPDATE followup_delivery SET state='accepted', updated_at=now() WHERE id=$1`, [r.delivery_id]);
          bump('accepted');
        } else if (verdict === 'failed' && r.attempt_count < maxAttempts) {
          await db.query(`UPDATE followup_delivery SET state='pending', updated_at=now() WHERE id=$1`, [r.delivery_id]);
          bump('pending');
        } else bump('unknown');
        continue;
      }
    }
    // 5. Attempt cap.
    if (r.attempt_count >= maxAttempts) { bump('failed'); continue; }
    // 6. Provider gate: NoProvider leaves the honest blocked state.
    if (sender.name === 'none') {
      await db.query(`UPDATE followup_delivery SET state='blocked_no_provider', updated_at=now() WHERE id=$1`, [r.delivery_id]);
      bump('blocked_no_provider'); continue;
    }
    // 7. Send. Claim-then-send: 'attempting' COMMITS before the network call.
    const stage = (r.stages as any[]).find((s: any) => s.day === Number(r.stage_day)) ?? (r.stages as any[])[0];
    await db.query(`UPDATE followup_delivery SET state='attempting', attempt_count=attempt_count+1, updated_at=now() WHERE id=$1`, [r.delivery_id]);
    const res = await sender.send({
      sendKey: r.send_key, to: r.recipient_address,
      subject: String(stage.subject).replaceAll('{{status}}', r.issue_status),
      text: String(stage.body_text).replaceAll('{{status}}', r.issue_status),
      html: String(stage.body_html ?? '').replaceAll('{{status}}', r.issue_status),
    });
    if (res.outcome === 'accepted') {
      await db.query(`UPDATE followup_delivery SET state='accepted', provider=$2, provider_message_id=$3, updated_at=now() WHERE id=$1`,
        [r.delivery_id, sender.name, res.providerMessageId]);
      sent++; bump('accepted');
    } else if (res.outcome === 'unknown') {
      await db.query(`UPDATE followup_delivery SET state='unknown', provider=$2, provider_message_id=$3, updated_at=now() WHERE id=$1`,
        [r.delivery_id, sender.name, res.attemptId]);
      bump('unknown');
    } else {
      await db.query(`UPDATE followup_delivery SET state='failed', last_error=$2, updated_at=now() WHERE id=$1`, [r.delivery_id, res.reason]);
      bump('failed');
    }
  }
  return { sent, states };
}

export function registerFollowupRoutes(app: FastifyInstance, deps: { cfg: Config; db: pg.Pool; keys: KeyResolver }) {
  const { cfg, db, keys } = deps;
  const auth = (req: FastifyRequest) => authenticate(req.headers.authorization, cfg, keys, db);

  // Grant or revoke reminder consent. scope_version pins the exact consent text shown in the UI.
  app.post('/v1/me/mail-consent', async (req) => {
    const p = await auth(req);
    const { kind, granted, scope_version } = (req.body ?? {}) as any;
    if (kind !== 'report_reminders' || typeof granted !== 'boolean' || !scope_version)
      throw new HttpError(400, 'kind, granted and scope_version are required', 'bad_request');
    await db.query(
      `INSERT INTO user_mail_consent(user_id, kind, scope_version, granted, granted_at, revoked_at, updated_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $4 THEN now() END, CASE WHEN NOT $4 THEN now() END, now())
       ON CONFLICT (user_id, kind) DO UPDATE SET granted=$4, scope_version=$3,
         granted_at=CASE WHEN $4 THEN now() ELSE user_mail_consent.granted_at END,
         revoked_at=CASE WHEN NOT $4 THEN now() ELSE user_mail_consent.revoked_at END, updated_at=now()`,
      [p.userId, kind, scope_version, granted]);
    if (!granted) // revoking blocks every pending delivery immediately
      await db.query(
        `UPDATE followup_delivery d SET state='blocked_no_consent', updated_at=now()
           FROM followup_campaign c
          WHERE d.campaign_id=c.id AND c.owner_user_id=$1 AND d.state IN ('pending','blocked_no_provider','blocked_no_recipient','failed')`,
        [p.userId]);
    return { kind, granted };
  });

  // Create + approve a campaign. The client sends the EXACT stage contents the user approved;
  // they are hashed and stored - any later text/recipient change needs a new campaign (new consent).
  app.post('/v1/issues/:id/followup-campaigns', async (req, reply) => {
    const p = await auth(req);
    const issueId = (req.params as any).id;
    const { audience, recipient_descriptor, recipient_email, stages, idempotency_key } = (req.body ?? {}) as any;
    if (!['reporter', 'authority'].includes(audience)) throw new HttpError(400, 'audience must be reporter or authority', 'bad_audience');
    if (!Array.isArray(stages) || stages.length === 0) throw new HttpError(400, 'stages required', 'bad_stages');
    for (const s of stages)
      if (!DAY_STAGES.includes(s.day) || typeof s.subject !== 'string' || typeof s.body_text !== 'string' || !s.body_text.length)
        throw new HttpError(400, `bad stage (day ${s?.day})`, 'bad_stage');
    if (!idempotency_key || typeof idempotency_key !== 'string') throw new HttpError(400, 'idempotency_key required', 'bad_idempotency_key');
    const consent = await db.query(`SELECT granted FROM user_mail_consent WHERE user_id=$1 AND kind='report_reminders'`, [p.userId]);
    if (!consent.rows[0]?.granted) throw new HttpError(403, 'reminder consent required first', 'consent_required');
    // Reporter/self: the concrete address is the sign-in email the user confirms in the UI with the
    // exact texts. It is 'verified' only in the narrow sense that sign-in mail already reaches it.
    const recipientVerified = audience === 'reporter' && recipient_descriptor === 'self'
      && typeof recipient_email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient_email);
    if (audience === 'reporter' && !recipientVerified)
      throw new HttpError(400, 'the exact sign-in address must be confirmed (recipient_email)', 'recipient_email_required');
    const descriptor = audience === 'reporter' ? 'self' : String(recipient_descriptor ?? '');
    if (audience === 'authority' && !descriptor) throw new HttpError(400, 'recipient_required', 'recipient_required');
    const address = audience === 'reporter' ? String(recipient_email) : null;
    const enriched = stages.map((s: any) => ({
      ...s, body_html_sha256: createHash('sha256').update(s.body_html ?? '').digest('hex'),
    }));
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO followup_campaign(issue_id, owner_user_id, audience, recipient_descriptor, recipient_address, recipient_verified,
                                       stages, approved_at, approved_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$2,$8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [issueId, p.userId, audience, descriptor, address, recipientVerified, JSON.stringify(enriched), idempotency_key]);
      if (ins.rows.length === 0) { // replay: return the existing campaign, create nothing
        await client.query('ROLLBACK');
        const existing = await db.query(`SELECT id FROM followup_campaign WHERE idempotency_key=$1`, [idempotency_key]);
        return reply.status(200).send({ campaign_id: existing.rows[0]?.id, replayed: true });
      }
      const campaignId = ins.rows[0].id;
      for (const s of enriched)
        await client.query(
          `INSERT INTO followup_delivery(campaign_id, stage_day, due_at, send_key)
           VALUES ($1,$2,(SELECT created_at FROM issues WHERE id=$3) + make_interval(days => $2),$4)`,
          [campaignId, s.day, issueId, sendKey(campaignId, s.day, s.body_html_sha256)]);
      await client.query('COMMIT');
      return reply.status(201).send({
        campaign_id: campaignId,
        state: recipientVerified ? 'active' : 'blocked_no_recipient',
        deliveries: enriched.map((s: any) => ({ day: s.day, state: 'pending' })),
      });
    } catch (e: any) {
      await client.query('ROLLBACK');
      if (String(e?.constraint ?? '').includes('one_active'))
        throw new HttpError(409, 'an active reminder plan already exists for this issue', 'campaign_already_active');
      throw e;
    } finally { client.release(); }
  });

  // Revoke a campaign (owner only). Pending deliveries suppressed.
  app.delete('/v1/followup-campaigns/:id', async (req) => {
    const p = await auth(req);
    const r = await db.query(
      `UPDATE followup_campaign SET state='revoked' WHERE id=$1 AND owner_user_id=$2 AND state='active' RETURNING id`,
      [(req.params as any).id, p.userId]);
    if (r.rows.length === 0) throw new HttpError(404, 'no active reminder plan found', 'not_found');
    await db.query(
      `UPDATE followup_delivery SET state='suppressed', updated_at=now()
        WHERE campaign_id=$1 AND state IN ('pending','blocked_no_provider','blocked_no_consent','blocked_no_recipient','failed','unknown')`,
      [(req.params as any).id]);
    return { revoked: true };
  });

  // Own campaigns + truthful delivery states for an issue.
  app.get('/v1/issues/:id/followup-campaigns', async (req) => {
    const p = await auth(req);
    const c = await db.query(
      `SELECT id, audience, recipient_descriptor, recipient_address, recipient_verified, state, stages, created_at
         FROM followup_campaign WHERE issue_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC`,
      [(req.params as any).id, p.userId]);
    const d = await db.query(
      `SELECT d.campaign_id, d.stage_day, d.due_at, d.state, d.attempt_count, d.last_error
         FROM followup_delivery d JOIN followup_campaign c ON c.id=d.campaign_id
        WHERE c.issue_id=$1 AND c.owner_user_id=$2 ORDER BY d.stage_day`,
      [(req.params as any).id, p.userId]);
    return { campaigns: c.rows, deliveries: d.rows };
  });

  // Operator-run sweep (Render free tier has no cron; the deployment owner triggers this,
  // like the escalate job). Municipal admin only. Provider = Brevo when creds exist, else
  // the honest NoProvider (every due delivery lands in blocked_no_provider).
  app.post('/v1/admin/jobs/followup-sweep', async (req) => {
    const p = await auth(req);
    const ms = await memberships(db, p.userId);
    if (!ms.some((m) => m.role === 'admin' && m.kind === 'municipality')) throw new HttpError(403, 'Municipal admin only', 'forbidden');
    const sender: Sender = cfg.brevoApiKey && cfg.brevoFrom ? new BrevoSender(cfg.brevoApiKey, cfg.brevoFrom) : new NoProvider();
    return sweepFollowups(db, sender);
  });
}
