/**
 * Follow-up reminder pipeline. REVIEW-SCOPE HEAD: NoProvider-only structural hard gate.
 *
 * HARD GATE: this head contains NO provider client and NO credential plumbing. The sweep
 * only ever runs with NoProvider, which resolves every due delivery to the truthful
 * 'blocked_no_provider' state. A real provider is UNREACHABLE in this head by construction,
 * not by assuming keys are absent. Provider integration is a separate future authorized scope.
 *
 * Documented constraints for that future scope (official Brevo sources, read 2026-10-30;
 * integration MUST honor them, none are implemented here):
 *  - POST /v3/smtp/email: 201 = accepted (messageId OPTIONAL - a missing id is not a proven
 *    failure, and a synthetic/unknown id is never recorded as delivered).
 *    developers.brevo.com/reference/send-transac-email
 *  - idempotencyKey: UUID, 30-min TTL, a repeated key is not processed only for an EXACT
 *    IDENTICAL request; a duplicate_parameter 400 is a blanket duplicate signal and is NOT
 *    proof the earlier request was accepted. developers.brevo.com/docs/heterogenous-versions-batch-emails
 *  - GET /v3/smtp/emails requires one of email/templateId/messageId; there is NO send-key
 *    lookup, and absence from a lookup is NOT acceptance. An 'unknown' attempt without a real
 *    messageId is manual-reconciliation only, never resent blindly.
 *    developers.brevo.com/reference/get-transac-emails-list
 *
 * Truth rules enforced here:
 *  - Nothing sends without consent (current scope version) + access-checked ownership + a
 *    recipient bound to the authenticated sign-in email + a configured provider. Missing any
 *    one yields an honest blocked_* state.
 *  - The payload a provider would see is IMMUTABLE per delivery: rendered once ({{status}}
 *    substituted) at the first attempt and persisted; every retry reuses the stored bytes.
 *  - Exclusive claim: claiming flips state to 'attempting' in the claim statement itself.
 *    A crash leaves 'attempting', recovered to 'unknown' after 2 min - never resent blindly.
 *  - 'accepted' is never called 'delivered'. Delivery confirmation is a future webhook scope.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { authenticate, HttpError, memberships, type KeyResolver } from './auth.ts';
import type { Config } from './config.ts';

const DAY_STAGES = [7, 10, 15, 30] as const;
/** The exact consent text version the current UI shows. Grants with any other version are
 *  rejected - consent is pinned to words, not to a checkbox. Bump with the UI text. */
export const FOLLOWUP_CONSENT_VERSION = 'v1-2026-10-30';

export type SendInput = { sendKey: string; to: string; subject: string; text: string; html: string };
export type SendResult =
  | { outcome: 'accepted'; providerMessageId: string }
  | { outcome: 'failed'; reason: string; retryable: boolean }
  | { outcome: 'unknown'; attemptId: string };

export interface Sender {
  name: string;
  /** Documented provider idempotency window (minutes) for EXACT-identical retries. */
  idempotentRetryMinutes?: number;
  send(i: SendInput): Promise<SendResult>;
  reconcile?(attemptId: string): Promise<'accepted' | 'failed' | null>;
}

export class NoProvider implements Sender {
  name = 'none';
  async send(): Promise<SendResult> { return { outcome: 'failed', reason: 'no_provider_configured', retryable: false }; }
}

/** sha256 over the FULL approved stage content - subject and text included, not only html. */
export function stageContentSha(s: { day: number; subject: string; body_text: string; body_html?: string }): string {
  return createHash('sha256').update(JSON.stringify({ day: s.day, subject: s.subject, body_text: s.body_text, body_html: s.body_html ?? '' })).digest('hex');
}

export function sendKey(campaignId: string, stageDay: number, contentSha: string): string {
  return createHash('sha256').update(`${campaignId}|${stageDay}|${contentSha}`).digest('hex');
}

/** One due-delivery pass. Every gate honest; no lock or transaction held across a network call. */
export async function sweepFollowups(db: pg.Pool, sender: Sender, maxAttempts = 3): Promise<{ sent: number; states: Record<string, number> }> {
  const states: Record<string, number> = {};
  const bump = (s: string) => { states[s] = (states[s] ?? 0) + 1; };
  // Crash recovery: stuck 'attempting' means the process died mid-attempt. UNKNOWN, never resent.
  await db.query(
    `UPDATE followup_delivery SET state='unknown', updated_at=now()
      WHERE state='attempting' AND updated_at < now() - interval '2 minutes'`);
  // Exclusive claim: state flips to 'attempting' IN THE CLAIM STATEMENT, so once committed no
  // other worker can select the row. Every branch writes a non-attempting terminal state.
  const due = await db.query(
    `WITH c AS (
       SELECT d.id, d.state AS prior_state, d.updated_at AS prior_updated_at FROM followup_delivery d
        WHERE d.due_at <= now()
          AND d.state IN ('pending','unknown','blocked_no_provider','failed')
        ORDER BY d.id LIMIT 50
        FOR UPDATE OF d SKIP LOCKED)
     UPDATE followup_delivery d SET state='attempting', updated_at=now() FROM c WHERE d.id = c.id
     RETURNING d.id AS delivery_id, c.prior_state AS prior_state, d.send_key, d.attempt_count,
       d.provider_message_id, d.first_attempt_at, d.rendered_subject, d.rendered_text, d.rendered_html, d.stage_day,
       (SELECT c2.id FROM followup_campaign c2 WHERE c2.id = d.campaign_id) AS campaign_id,
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
    // 4. Unknown previous attempt: reconcile first, NEVER blind resend. A 'key:' attempt may only
    //    fall through to an idempotent retry INSIDE the provider's documented window, anchored at
    //    first_attempt_at (the TTL belongs to the FIRST attempt and is never refreshed by passes).
    if (r.prior_state === 'unknown') {
      const attemptId = r.provider_message_id ?? '';
      const retryMinutes = sender.idempotentRetryMinutes ?? 0;
      const ageMs = r.first_attempt_at ? Date.now() - new Date(r.first_attempt_at).getTime() : Number.POSITIVE_INFINITY;
      const insideWindow = attemptId.startsWith('key:') && retryMinutes > 0 && ageMs < retryMinutes * 60000;
      if (!insideWindow) {
        const verdict = sender.reconcile ? await sender.reconcile(attemptId) : null;
        if (verdict === 'accepted') {
          await db.query(`UPDATE followup_delivery SET state='accepted', updated_at=now() WHERE id=$1`, [r.delivery_id]);
          bump('accepted');
        } else if (verdict === 'failed' && r.attempt_count < maxAttempts) {
          await db.query(`UPDATE followup_delivery SET state='pending', updated_at=now() WHERE id=$1`, [r.delivery_id]);
          bump('pending');
        } else {
          await db.query(`UPDATE followup_delivery SET state='unknown' WHERE id=$1`, [r.delivery_id]); // stays manual; no refreshed claim timestamp
          bump('unknown');
        }
        continue;
      }
    }
    // 5. Attempt cap - persisted, not just reported.
    if (r.attempt_count >= maxAttempts) {
      await db.query(`UPDATE followup_delivery SET state='failed', last_error='attempt_cap_reached', updated_at=now() WHERE id=$1`, [r.delivery_id]);
      bump('failed'); continue;
    }
    // 6. Provider gate: NoProvider leaves the honest blocked state.
    if (sender.name === 'none') {
      await db.query(`UPDATE followup_delivery SET state='blocked_no_provider', updated_at=now() WHERE id=$1`, [r.delivery_id]);
      bump('blocked_no_provider'); continue;
    }
    // 7. Pre-send recheck (gates can have changed since the claim): campaign still active,
    //    consent still granted, issue still unresolved. A revoke between claim and send stops the send.
    const recheck = (await db.query(
      `SELECT (SELECT c2.state FROM followup_campaign c2 WHERE c2.id=$1) AS cs,
              (SELECT granted FROM user_mail_consent WHERE user_id=(SELECT owner_user_id FROM followup_campaign WHERE id=$1) AND kind='report_reminders') AS granted,
              (SELECT i.status FROM issues i JOIN followup_campaign c3 ON c3.issue_id=i.id WHERE c3.id=$1) AS ist`,
      [r.campaign_id])).rows[0];
    if (recheck.cs !== 'active' || recheck.ist === 'fixed' || recheck.ist === 'rejected') {
      await db.query(`UPDATE followup_delivery SET state='suppressed', updated_at=now() WHERE id=$1`, [r.delivery_id]);
      bump('suppressed'); continue;
    }
    if (!recheck.granted) {
      await db.query(`UPDATE followup_delivery SET state='blocked_no_consent', updated_at=now() WHERE id=$1`, [r.delivery_id]);
      bump('blocked_no_consent'); continue;
    }
    // 8. Send with the IMMUTABLE payload: rendered once, persisted, reused on every retry.
    const stage = (r.stages as any[]).find((s: any) => s.day === Number(r.stage_day)) ?? (r.stages as any[])[0];
    let { rendered_subject: subj, rendered_text: text, rendered_html: html } = r;
    if (!subj) {
      subj = String(stage.subject).replaceAll('{{status}}', r.issue_status);
      text = String(stage.body_text).replaceAll('{{status}}', r.issue_status);
      html = String(stage.body_html ?? '').replaceAll('{{status}}', r.issue_status);
      await db.query(
        `UPDATE followup_delivery SET rendered_subject=$2, rendered_text=$3, rendered_html=$4, first_attempt_at=now(), attempt_count=attempt_count+1, updated_at=now() WHERE id=$1`,
        [r.delivery_id, subj, text, html]);
    } else {
      await db.query(`UPDATE followup_delivery SET attempt_count=attempt_count+1, updated_at=now() WHERE id=$1`, [r.delivery_id]);
    }
    const res = await sender.send({ sendKey: r.send_key, to: r.recipient_address, subject: subj, text, html });
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
  const hasIssueAccess = async (issueId: string, userId: string) =>
    !!(await db.query(
      `SELECT 1 FROM issues i WHERE i.id=$1 AND (i.reporter_id=$2 OR EXISTS (SELECT 1 FROM reports r WHERE r.issue_id=$1 AND r.user_id=$2))`,
      [issueId, userId])).rowCount;

  // Grant or revoke reminder consent. The scope version must be the exact text version the
  // current UI shows - consent is pinned to words, not to a checkbox.
  app.post('/v1/me/mail-consent', async (req) => {
    const p = await auth(req);
    const { kind, granted, scope_version } = (req.body ?? {}) as any;
    if (kind !== 'report_reminders' || typeof granted !== 'boolean')
      throw new HttpError(400, 'kind and granted are required', 'bad_request');
    if (scope_version !== FOLLOWUP_CONSENT_VERSION)
      throw new HttpError(400, 'unsupported consent text version', 'bad_scope_version');
    await db.query(
      `INSERT INTO user_mail_consent(user_id, kind, scope_version, granted, granted_at, revoked_at, updated_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $4 THEN now() END, CASE WHEN NOT $4 THEN now() END, now())
       ON CONFLICT (user_id, kind) DO UPDATE SET granted=$4, scope_version=$3,
         granted_at=CASE WHEN $4 THEN now() ELSE user_mail_consent.granted_at END,
         revoked_at=CASE WHEN NOT $4 THEN now() ELSE user_mail_consent.revoked_at END, updated_at=now()`,
      [p.userId, kind, scope_version, granted]);
    if (!granted) // revoking blocks every not-yet-accepted delivery immediately
      await db.query(
        `UPDATE followup_delivery d SET state='blocked_no_consent', updated_at=now()
           FROM followup_campaign c
          WHERE d.campaign_id=c.id AND c.owner_user_id=$1 AND d.state IN ('pending','blocked_no_provider','blocked_no_recipient','failed','unknown')`,
        [p.userId]);
    else // re-granting re-arms deliveries that were blocked only by the revoked consent
      await db.query(
        `UPDATE followup_delivery d SET state='pending', updated_at=now()
           FROM followup_campaign c
          WHERE d.campaign_id=c.id AND c.owner_user_id=$1 AND d.state='blocked_no_consent'`,
        [p.userId]);
    return { kind, granted, scope_version };
  });

  // Create + approve a campaign. Access is verified BEFORE any campaign lookup or response
  // detail; the idempotency key is scoped to the owner; replay requires an identical payload.
  app.post('/v1/issues/:id/followup-campaigns', async (req, reply) => {
    const p = await auth(req);
    const issueId = (req.params as any).id;
    if (!(await hasIssueAccess(issueId, p.userId))) throw new HttpError(404, 'Issue not found', 'not_found');
    const { audience, recipient_descriptor, recipient_email, stages, idempotency_key } = (req.body ?? {}) as any;
    if (!['reporter', 'authority'].includes(audience)) throw new HttpError(400, 'audience must be reporter or authority', 'bad_audience');
    if (!Array.isArray(stages) || stages.length !== DAY_STAGES.length) throw new HttpError(400, 'stages must be exactly the day 7/10/15/30 set', 'bad_stages');
    const days = stages.map((s: any) => s.day).sort((a: number, b: number) => a - b);
    if (!DAY_STAGES.every((d, i) => days[i] === d)) throw new HttpError(400, 'stages must cover days 7, 10, 15 and 30 exactly once', 'bad_stages');
    for (const s of stages)
      if (typeof s.subject !== 'string' || !s.subject.length || typeof s.body_text !== 'string' || !s.body_text.length)
        throw new HttpError(400, `bad stage (day ${s?.day})`, 'bad_stage');
    if (!idempotency_key || typeof idempotency_key !== 'string') throw new HttpError(400, 'idempotency_key required', 'bad_idempotency_key');
    const consent = await db.query(`SELECT granted, scope_version FROM user_mail_consent WHERE user_id=$1 AND kind='report_reminders'`, [p.userId]);
    if (!consent.rows[0]?.granted) throw new HttpError(403, 'reminder consent required first', 'consent_required');
    // Reporter/self: the concrete recipient is the AUTHENTICATED sign-in email from the verified
    // token - never a client-supplied address. A body value that disagrees is rejected, not stored.
    let address: string | null = null;
    let recipientVerified = false;
    if (audience === 'reporter') {
      if (recipient_descriptor !== 'self') throw new HttpError(400, 'reporter campaigns are self-addressed', 'bad_audience');
      if (!p.email) throw new HttpError(400, 'your sign-in address is not available from this session', 'signin_email_unavailable');
      if (typeof recipient_email !== 'string' || recipient_email.toLowerCase() !== p.email.toLowerCase())
        throw new HttpError(403, 'recipient_email must be your own sign-in address', 'recipient_mismatch');
      address = p.email;
      recipientVerified = true; // narrow sense: sign-in mail reaches it; email-confirmation is a Supabase deployment setting (owner surface)
    }
    const descriptor = audience === 'reporter' ? 'self' : String(recipient_descriptor ?? '');
    if (audience === 'authority' && !descriptor) throw new HttpError(400, 'recipient_required', 'recipient_required');
    const enriched = stages.map((s: any) => ({ ...s, content_sha256: stageContentSha(s) }));
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO followup_campaign(issue_id, owner_user_id, audience, recipient_descriptor, recipient_address, recipient_verified,
                                       stages, consent_scope_version, approved_at, approved_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$2,$9)
         ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [issueId, p.userId, audience, descriptor, address, recipientVerified, JSON.stringify(enriched), consent.rows[0].scope_version, idempotency_key]);
      if (ins.rows.length === 0) {
        // Same owner + same key: replay ONLY if every approved parameter is identical.
        await client.query('ROLLBACK');
        const existing = (await db.query(
          `SELECT id, issue_id, audience, recipient_address, stages FROM followup_campaign WHERE owner_user_id=$1 AND idempotency_key=$2`,
          [p.userId, idempotency_key])).rows[0];
        const same = existing && existing.issue_id === issueId && existing.audience === audience
          && (existing.recipient_address ?? null) === address
          && JSON.stringify(existing.stages) === JSON.stringify(enriched);
        if (!same) throw new HttpError(409, 'same idempotency key with a different payload', 'idempotency_mismatch');
        return reply.status(200).send({ campaign_id: existing.id, replayed: true });
      }
      const campaignId = ins.rows[0].id;
      for (const s of enriched)
        await client.query(
          `INSERT INTO followup_delivery(campaign_id, stage_day, due_at, send_key)
           VALUES ($1,$2,(SELECT created_at FROM issues WHERE id=$3) + make_interval(days => $2),$4)`,
          [campaignId, s.day, issueId, sendKey(campaignId, s.day, s.content_sha256)]);
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

  // Revoke a campaign (owner only). Every not-yet-accepted delivery suppressed; an in-flight
  // 'attempting' delivery is stopped by the pre-send recheck inside the sweep.
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

  // Own campaigns + truthful delivery states for an issue (same access gate as creation).
  app.get('/v1/issues/:id/followup-campaigns', async (req) => {
    const p = await auth(req);
    if (!(await hasIssueAccess((req.params as any).id, p.userId))) throw new HttpError(404, 'Issue not found', 'not_found');
    const c = await db.query(
      `SELECT id, audience, recipient_descriptor, recipient_address, recipient_verified, state, stages, consent_scope_version, created_at
         FROM followup_campaign WHERE issue_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC`,
      [(req.params as any).id, p.userId]);
    const d = await db.query(
      `SELECT d.campaign_id, d.stage_day, d.due_at, d.state, d.attempt_count, d.last_error
         FROM followup_delivery d JOIN followup_campaign c ON c.id=d.campaign_id
        WHERE c.issue_id=$1 AND c.owner_user_id=$2 ORDER BY d.stage_day`,
      [(req.params as any).id, p.userId]);
    return { campaigns: c.rows, deliveries: d.rows };
  });

  // Operator-run sweep. Municipal admin only. HARD GATE: always NoProvider in this head -
  // every due delivery resolves to the truthful blocked_no_provider state; nothing sends.
  app.post('/v1/admin/jobs/followup-sweep', async (req) => {
    const p = await auth(req);
    const ms = await memberships(db, p.userId);
    if (!ms.some((m) => m.role === 'admin' && m.kind === 'municipality')) throw new HttpError(403, 'Municipal admin only', 'forbidden');
    return sweepFollowups(db, new NoProvider());
  });
}
