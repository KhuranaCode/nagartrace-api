/**
 * Integrated tests for the follow-up reminder pipeline (src/followup.ts, real module, real PG).
 * The pending migration is applied EXPLICITLY (db-pending/011) - mirroring the coordinated
 * apply - because the migrator deliberately does not pick it up yet.
 * All sweep sends use fake in-process senders or the real NoProvider: NO provider calls ever.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newWorld, sign, client, reportBody, P_NOROAD, type World } from './helpers.ts';
import { sweepFollowups, NoProvider, FOLLOWUP_CONSENT_VERSION, type Sender, type SendInput } from '../src/followup.ts';

let w: World;
const uniq = () => Math.random().toString(36).slice(2, 10);

class FakeSender implements Sender {
  name = 'fake';
  idempotentRetryMinutes?: number;
  calls: SendInput[] = [];
  constructor(private plan: (i: SendInput) => any, windowMinutes?: number) { this.idempotentRetryMinutes = windowMinutes; }
  async send(i: SendInput) { this.calls.push(i); return this.plan(i); }
}

async function mkUser(email?: string) {
  const t = await sign('u-' + uniq(), email ? { extra: { email, email_verified: true } } : {});
  const c = client(w, t);
  const me = (await c.get('/v1/me')).json;
  return { t, c, id: me.id as string };
}
async function mkIssue(c: ReturnType<typeof client>) {
  // Unique coordinates per issue (> duplicate radius apart) so tests never merge into one issue.
  const j = () => (Math.random() - 0.5) * 0.02;
  const r = await c.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + j(), lon: P_NOROAD.lon + j() }));
  assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.json));
  return r.json.issue.id as string;
}
const consent = (c: ReturnType<typeof client>, granted = true, v = FOLLOWUP_CONSENT_VERSION) =>
  c.post('/v1/me/mail-consent', { kind: 'report_reminders', granted, scope_version: v });
const STAGES = [7, 10, 15, 30].map((day) => ({ day, subject: `s${day}`, body_text: `b${day} {{status}}` }));
const create = (c: ReturnType<typeof client>, issueId: string, key: string, email: string, stages = STAGES) =>
  c.post(`/v1/issues/${issueId}/followup-campaigns`, { audience: 'reporter', recipient_descriptor: 'self', recipient_email: email, stages, idempotency_key: key });
const dueAll = () => w.adminDb.query(`UPDATE followup_delivery SET due_at=now()-interval '1 minute'`);
/** Suppress every OTHER campaign's selectable deliveries, so a sweep touches only this campaign. */
const isolate = async (cid: string, days = [7, 10, 15, 30]) => {
  await w.adminDb.query(`UPDATE followup_delivery SET state='suppressed' WHERE campaign_id<>$1 AND state IN ('pending','unknown','blocked_no_provider','blocked_no_consent','blocked_no_recipient','failed')`, [cid]);
  await w.adminDb.query(`UPDATE followup_delivery SET due_at=now()-interval '1 minute' WHERE campaign_id=$1 AND stage_day=ANY($2)`, [cid, days]);
};

before(async () => {
  w = await newWorld({ followupPipeline: true });
  const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../db-pending/011_followup_pipeline.sql'), 'utf8');
  await w.adminDb.query(sql); // explicit pending apply; the migrator does not run db-pending/
});
after(() => w.close());

test('consent: wrong scope version rejected, exact version granted (runtime role permissions)', async () => {
  const u = await mkUser('a@example.in');
  const bad = await consent(u.c, true, 'v0-anything');
  assert.equal(bad.status, 400);
  const ok = await consent(u.c);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.granted, true);
});

test('access: a non-reporter cannot create or list campaigns on another user\'s issue', async () => {
  const owner = await mkUser('owner@example.in'); const other = await mkUser('other@example.in');
  const issueId = await mkIssue(owner.c);
  await consent(other.c);
  const r = await create(other.c, issueId, 'k-' + uniq(), 'other@example.in');
  assert.equal(r.status, 404);
  const g = await other.c.get(`/v1/issues/${issueId}/followup-campaigns`);
  assert.equal(g.status, 404);
});

test('recipient binding: missing token email 400, mismatched body email 403, bound email 201', async () => {
  const noMail = await mkUser();
  const i1 = await mkIssue(noMail.c);
  await consent(noMail.c);
  assert.equal((await create(noMail.c, i1, 'k-' + uniq(), 'x@example.in')).status, 400); // signin_email_unavailable
  const u = await mkUser('bound@example.in');
  const i2 = await mkIssue(u.c);
  await consent(u.c);
  assert.equal((await create(u.c, i2, 'k-' + uniq(), 'tampered@example.in')).status, 403); // recipient_mismatch
  const ok = await create(u.c, i2, 'k-' + uniq(), 'bound@example.in');
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.state, 'active');
  const g = await u.c.get(`/v1/issues/${i2}/followup-campaigns`);
  assert.equal(g.json.campaigns[0].recipient_address, 'bound@example.in');
});

test('idempotency: identical replay 200, changed payload 409, other user same key no leak', async () => {
  const u = await mkUser('idem@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const key = 'k-' + uniq();
  const first = await create(u.c, issueId, key, 'idem@example.in');
  assert.equal(first.status, 201);
  const replay = await create(u.c, issueId, key, 'idem@example.in');
  assert.equal(replay.status, 200);
  assert.equal(replay.json.campaign_id, first.json.campaign_id);
  const changed = await create(u.c, issueId, key, 'idem@example.in', STAGES.map((s) => ({ ...s, subject: 'CHANGED' })));
  assert.equal(changed.status, 409);
  // A DIFFERENT user reusing the same key on their own issue gets their own campaign, not ours.
  const v = await mkUser('idem2@example.in'); const i2 = await mkIssue(v.c);
  await consent(v.c);
  const own = await create(v.c, i2, key, 'idem2@example.in');
  assert.equal(own.status, 201);
  assert.notEqual(own.json.campaign_id, first.json.campaign_id);
});

test('stage set: incomplete or duplicate day sets rejected', async () => {
  const u = await mkUser('st@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  assert.equal((await create(u.c, issueId, 'k-' + uniq(), 'st@example.in', STAGES.slice(0, 3))).status, 400);
  assert.equal((await create(u.c, issueId, 'k-' + uniq(), 'st@example.in', [...STAGES.slice(0, 3), STAGES[0]])).status, 400);
});

test('NoProvider sweep: granted consent + bound recipient resolves to blocked_no_provider (never a send claim)', async () => {
  const u = await mkUser('np@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid = (await create(u.c, issueId, 'k-' + uniq(), 'np@example.in')).json.campaign_id;
  assert.ok(cid);
  await isolate(cid);
  const r = await sweepFollowups(w.runtime, new NoProvider());
  assert.equal(r.states.blocked_no_provider, 4);
  const rows = (await w.adminDb.query(`SELECT state FROM followup_delivery WHERE campaign_id=$1 ORDER BY stage_day`, [cid])).rows;
  assert.deepEqual(rows.map((x: any) => x.state), ['blocked_no_provider', 'blocked_no_provider', 'blocked_no_provider', 'blocked_no_provider']);
});

test('exclusive claim: two concurrent sweeps send exactly once', async () => {
  const u = await mkUser('ex@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid7 = (await create(u.c, issueId, 'k-' + uniq(), 'ex@example.in')).json.campaign_id;
  await isolate(cid7, [7]);
  const sender = new FakeSender(async () => { await new Promise((r) => setTimeout(r, 100)); return { outcome: 'accepted', providerMessageId: 'msg-1' }; });
  await Promise.all([sweepFollowups(w.runtime, sender), sweepFollowups(w.runtime, sender)]);
  assert.equal(sender.calls.filter((i) => i.to === 'ex@example.in').length, 1);
  const st = (await w.adminDb.query(`SELECT state FROM followup_delivery WHERE campaign_id=$1 AND stage_day=7`, [cid7])).rows[0].state;
  assert.equal(st, 'accepted');
});

test('crash recovery: stale attempting becomes unknown; recovery retry only idempotent-in-window', async () => {
  const u = await mkUser('cr@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid8 = (await create(u.c, issueId, 'k-' + uniq(), 'cr@example.in')).json.campaign_id;
  await isolate(cid8, [7]);
  await w.adminDb.query(`UPDATE followup_delivery SET state='attempting', updated_at=now()-interval '5 minutes', provider_message_id='key:abc', first_attempt_at=now()-interval '5 minutes' WHERE campaign_id=$1 AND stage_day=7`, [cid8]);
  const sender = new FakeSender(async () => ({ outcome: 'accepted', providerMessageId: 'msg-x' }), 30);
  await sweepFollowups(w.runtime, sender);
  const row = (await w.adminDb.query(`SELECT state FROM followup_delivery WHERE campaign_id=$1 AND stage_day=7`, [cid8])).rows[0];
  // The stale 'attempting' row is first recovered to 'unknown', then - because the original
  // first_attempt_at is still INSIDE the documented 30-min idempotency window and the payload
  // is the identical rendered bytes - exactly one idempotent retry is allowed and lands 'accepted'.
  assert.equal(sender.calls.filter((i) => i.to === 'cr@example.in').length, 1);
  assert.equal(row.state, 'accepted');
});

test('TTL anchoring: a key: unknown older than the provider window is never retried', async () => {
  const u = await mkUser('ttl@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid9 = (await create(u.c, issueId, 'k-' + uniq(), 'ttl@example.in')).json.campaign_id;
  await isolate(cid9, [7]);
  await w.adminDb.query(`UPDATE followup_delivery SET state='unknown', provider_message_id='key:abc', first_attempt_at=now()-interval '31 minutes' WHERE campaign_id=$1 AND stage_day=7`, [cid9]);
  const sender = new FakeSender(async () => ({ outcome: 'accepted', providerMessageId: 'msg-y' }), 30);
  await sweepFollowups(w.runtime, sender);
  assert.equal(sender.calls.length, 0);
  assert.equal((await w.adminDb.query(`SELECT state FROM followup_delivery WHERE campaign_id=$1 AND stage_day=7`, [cid9])).rows[0].state, 'unknown');
});

test('attempt cap is persisted as failed, not left selectable', async () => {
  const u = await mkUser('cap@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid10 = (await create(u.c, issueId, 'k-' + uniq(), 'cap@example.in')).json.campaign_id;
  await isolate(cid10, [7]);
  await w.adminDb.query(`UPDATE followup_delivery SET attempt_count=3 WHERE campaign_id=$1 AND stage_day=7`, [cid10]);
  const sender = new FakeSender(async () => ({ outcome: 'failed', reason: 'x', retryable: true }));
  await sweepFollowups(w.runtime, sender);
  assert.equal(sender.calls.length, 0);
  const row = (await w.adminDb.query(`SELECT state, last_error FROM followup_delivery WHERE campaign_id=$1 AND stage_day=7`, [cid10])).rows[0];
  assert.equal(row.state, 'failed');
  assert.equal(row.last_error, 'attempt_cap_reached');
});

test('immutable payload: a retry reuses the rendered bytes from the first attempt', async () => {
  const u = await mkUser('im@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid11 = (await create(u.c, issueId, 'k-' + uniq(), 'im@example.in')).json.campaign_id;
  await isolate(cid11, [7]);
  const sender = new FakeSender(async () => ({ outcome: 'failed', reason: 'boom', retryable: true }));
  await sweepFollowups(w.runtime, sender);
  await sweepFollowups(w.runtime, sender);
  assert.equal(sender.calls.length, 2);
  assert.equal(sender.calls[0].subject, sender.calls[1].subject);
  assert.equal(sender.calls[0].text, sender.calls[1].text);
  assert.ok(sender.calls[0].text.includes('reported')); // {{status}} rendered at first attempt
  const row = (await w.adminDb.query(`SELECT first_attempt_at FROM followup_delivery WHERE campaign_id=$1 AND stage_day=7`, [cid11])).rows[0];
  assert.ok(row.first_attempt_at);
});

test('revoke between claim and send stops the send (pre-send recheck)', async () => {
  const u = await mkUser('rv@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid = (await create(u.c, issueId, 'k-' + uniq(), 'rv@example.in')).json.campaign_id;
  await isolate(cid, [7]);
  const sender = new FakeSender(async () => ({ outcome: 'accepted', providerMessageId: 'msg-z' }));
  const orig = w.runtime.query.bind(w.runtime);
  (w.runtime as any).query = async (text: any, p?: any) => {
    const r = await orig(text, p);
    if (typeof text === 'string' && text.includes('FOR UPDATE OF d SKIP LOCKED'))
      await w.adminDb.query(`UPDATE followup_campaign SET state='revoked' WHERE id=$1`, [cid]);
    return r;
  };
  try { await sweepFollowups(w.runtime, sender); } finally { (w.runtime as any).query = orig; }
  assert.equal(sender.calls.length, 0);
  assert.equal((await w.adminDb.query(`SELECT state FROM followup_delivery WHERE campaign_id=$1 AND stage_day=7`, [cid])).rows[0].state, 'suppressed');
});

test('campaign revoke suppresses pending but preserves unknown attempt truth; consent revoke blocks and re-grant re-arms', async () => {
  const u = await mkUser('rw@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid = (await create(u.c, issueId, 'k-' + uniq(), 'rw@example.in')).json.campaign_id;
  await w.adminDb.query(`UPDATE followup_delivery SET state='unknown' WHERE stage_day=7`);
  const del = await u.c.delete(`/v1/followup-campaigns/${cid}`);
  assert.equal(del.status, 200);
  const states = (await w.adminDb.query(`SELECT state FROM followup_delivery WHERE campaign_id=$1 ORDER BY stage_day`, [cid])).rows.map((x: any) => x.state);
  assert.deepEqual(states, ['unknown', 'suppressed', 'suppressed', 'suppressed']); // unknown = real attempt, uncertain outcome: preserved
  // consent revoke blocks, re-grant re-arms to pending
  const u2 = await mkUser('rw2@example.in'); const i2 = await mkIssue(u2.c);
  await consent(u2.c);
  await create(u2.c, i2, 'k-' + uniq(), 'rw2@example.in');
  await consent(u2.c, false);
  let s2 = (await w.adminDb.query(`SELECT DISTINCT d.state FROM followup_delivery d JOIN followup_campaign c ON c.id=d.campaign_id WHERE c.issue_id=$1`, [i2])).rows.map((x: any) => x.state);
  assert.deepEqual(s2, ['blocked_no_consent']);
  await consent(u2.c, true);
  s2 = (await w.adminDb.query(`SELECT DISTINCT d.state FROM followup_delivery d JOIN followup_campaign c ON c.id=d.campaign_id WHERE c.issue_id=$1`, [i2])).rows.map((x: any) => x.state);
  assert.deepEqual(s2, ['pending']);
});

test('admin sweep job: municipal admin only, and it is NoProvider by construction', async () => {
  const u = await mkUser('adm@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid14 = (await create(u.c, issueId, 'k-' + uniq(), 'adm@example.in')).json.campaign_id;
  await isolate(cid14);
  const plain = await u.c.post('/v1/admin/jobs/followup-sweep', {});
  assert.equal(plain.status, 403);
  const muni = (await w.adminDb.query(`INSERT INTO orgs (kind,name) VALUES ('municipality','FM-'||$1) RETURNING id`, [uniq()])).rows[0].id;
  const adm = await mkUser('adm2@example.in');
  await w.adminDb.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'admin')`, [adm.id, muni]);
  const ok = await adm.c.post('/v1/admin/jobs/followup-sweep', {});
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.sent, 0); // NoProvider: nothing is ever sent in this head
  assert.equal(ok.json.states.blocked_no_provider, 4);
  const rows14 = (await w.adminDb.query(`SELECT state FROM followup_delivery WHERE campaign_id=$1`, [cid14])).rows;
  assert.ok(rows14.every((x: any) => x.state === 'blocked_no_provider'));
});

// --- Regressions from the b051dd9 runtime review artifact ---

test('regression: unknown attempt survives consent revoke + re-grant, never re-armed or resent', async () => {
  const u = await mkUser('ru@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid = (await create(u.c, issueId, 'k-' + uniq(), 'ru@example.in')).json.campaign_id;
  await isolate(cid, [7]);
  await w.adminDb.query(`UPDATE followup_delivery SET state='unknown', provider_message_id='key:old', first_attempt_at=now()-interval '31 minutes', attempt_count=1 WHERE campaign_id=$1 AND stage_day=7`, [cid]);
  const sender = new FakeSender(async () => ({ outcome: 'accepted', providerMessageId: 'x' }));
  sender.idempotentRetryMinutes = 30;
  await consent(u.c, false); await consent(u.c, true); // revoke + re-grant around the unknown row
  const st = (await w.adminDb.query(`SELECT state FROM followup_delivery WHERE campaign_id=$1 AND stage_day=7`, [cid])).rows[0].state;
  assert.equal(st, 'unknown', 'uncertain provider outcome is preserved independent of consent state');
  await sweepFollowups(w.runtime, sender);
  assert.equal(sender.calls.length, 0, '31-min-old key: attempt is outside the original TTL: never resent');
  assert.equal((await w.adminDb.query(`SELECT state FROM followup_delivery WHERE campaign_id=$1 AND stage_day=7`, [cid])).rows[0].state, 'unknown');
});

test('regression: a concurrent stop between claim and write is never overwritten', async () => {
  const u = await mkUser('ro@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid = (await create(u.c, issueId, 'k-' + uniq(), 'ro@example.in')).json.campaign_id;
  await isolate(cid, [7]);
  const orig = w.runtime.query.bind(w.runtime);
  (w.runtime as any).query = async (text: any, p?: any) => {
    const r = await orig(text, p);
    if (typeof text === 'string' && text.includes('FOR UPDATE OF d SKIP LOCKED')) {
      // Revoke lands fully between the claim and the sweep's per-delivery transaction.
      await w.adminDb.query(`UPDATE followup_campaign SET state='revoked' WHERE id=$1`, [cid]);
      await w.adminDb.query(`UPDATE followup_delivery SET state='suppressed' WHERE campaign_id=$1`, [cid]);
    }
    return r;
  };
  try { await sweepFollowups(w.runtime, new NoProvider()); } finally { (w.runtime as any).query = orig; }
  const row = (await w.adminDb.query(`SELECT state FROM followup_delivery WHERE campaign_id=$1 AND stage_day=7`, [cid])).rows[0];
  assert.equal(row.state, 'suppressed', 'revoke suppression is never overwritten by the sweep');
});

test('regression: consent revoked after claim but before send blocks the send, and re-grant does not resurrect it', async () => {
  const u = await mkUser('rt@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const cid = (await create(u.c, issueId, 'k-' + uniq(), 'rt@example.in')).json.campaign_id;
  await isolate(cid, [7]);
  const sender = new FakeSender(async () => ({ outcome: 'accepted', providerMessageId: 'x' }));
  const orig = w.runtime.query.bind(w.runtime);
  (w.runtime as any).query = async (text: any, p?: any) => {
    const r = await orig(text, p);
    if (typeof text === 'string' && text.includes('FOR UPDATE OF d SKIP LOCKED')) await consent(u.c, false);
    return r;
  };
  try { await sweepFollowups(w.runtime, sender); } finally { (w.runtime as any).query = orig; }
  assert.equal(sender.calls.length, 0, 'committed revoke is always seen before the send decision');
  assert.equal((await w.adminDb.query(`SELECT state FROM followup_delivery WHERE campaign_id=$1 AND stage_day=7`, [cid])).rows[0].state, 'blocked_no_consent');
});

test('regression: unverified email claims are rejected; only issuer-verified email binds', async () => {
  const mk = async (extra: Record<string, unknown>) => client(w, await sign('uv-' + uniq(), { extra }));
  const unverified = await mk({ email: 'u@example.in', email_verified: false });
  const i1 = await mkIssue(unverified);
  await consent(unverified);
  assert.equal((await create(unverified, i1, 'k-' + uniq(), 'u@example.in')).status, 400); // signin_email_unavailable
  const noFlag = await mk({ email: 'n@example.in' }); // claim present, verification unknown
  const i2 = await mkIssue(noFlag);
  await consent(noFlag);
  assert.equal((await create(noFlag, i2, 'k-' + uniq(), 'n@example.in')).status, 400);
  const metaFlag = await mk({ email: 'm@example.in', user_metadata: { email_verified: true } }); // issuer marker in user_metadata
  const i3 = await mkIssue(metaFlag);
  await consent(metaFlag);
  assert.equal((await create(metaFlag, i3, 'k-' + uniq(), 'm@example.in')).status, 201);
});

test('regression: identical HTML replay returns 200 same campaign; canonical hash beats jsonb key order', async () => {
  const u = await mkUser('rh@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  const withHtml = STAGES.map((s) => ({ ...s, body_html: `<p>${s.body_text}</p>` }));
  const key = 'k-' + uniq();
  const h1 = await create(u.c, issueId, key, 'rh@example.in', withHtml);
  assert.equal(h1.status, 201);
  const h2 = await create(u.c, issueId, key, 'rh@example.in', withHtml); // byte-identical replay
  assert.equal(h2.status, 200);
  assert.equal(h2.json.campaign_id, h1.json.campaign_id);
  assert.equal(h2.json.replayed, true);
  const changed = await create(u.c, issueId, key, 'rh@example.in', withHtml.map((s) => ({ ...s, body_html: s.body_html + 'x' })));
  assert.equal(changed.status, 409); // same key, different payload
});

test('regression: an older consent version no longer satisfies create or sweep after a bump', async () => {
  const u = await mkUser('rv2@example.in'); const issueId = await mkIssue(u.c);
  await consent(u.c);
  // Simulate a text bump: stored grant is now stale relative to FOLLOWUP_CONSENT_VERSION
  await w.adminDb.query(`UPDATE user_mail_consent SET scope_version='v0-stale' WHERE user_id=(SELECT id FROM users WHERE subject LIKE 'u-%' ORDER BY created_at DESC LIMIT 1)`);
  assert.equal((await create(u.c, issueId, 'k-' + uniq(), 'rv2@example.in')).status, 403); // consent_version_changed
  // An existing campaign's deliveries also block honestly instead of honoring the old grant
  await consent(u.c); // re-grant at current version
  const cid = (await create(u.c, issueId, 'k-' + uniq(), 'rv2@example.in')).json.campaign_id;
  await isolate(cid, [7]);
  await w.adminDb.query(`UPDATE user_mail_consent SET scope_version='v0-stale' WHERE granted=true`);
  const sender = new FakeSender(async () => ({ outcome: 'accepted', providerMessageId: 'x' }));
  await sweepFollowups(w.runtime, sender);
  assert.equal(sender.calls.length, 0);
  const row = (await w.adminDb.query(`SELECT state, last_error FROM followup_delivery WHERE campaign_id=$1 AND stage_day=7`, [cid])).rows[0];
  assert.equal(row.state, 'blocked_no_consent');
  assert.equal(row.last_error, 'consent_version_changed');
});
