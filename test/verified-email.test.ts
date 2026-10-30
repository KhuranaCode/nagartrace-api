/** Trusted verified-email binding for follow-up recipients. Lookup contract tests stub
 *  global fetch (no network); route tests inject a fake lookup (no Supabase). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newWorld, sign, client, reportBody, P_NOROAD, type World } from './helpers.ts';
import { supabaseAuthUserLookup, noAuthUserLookup, type AuthUserLookup, type VerifiedEmail } from '../src/verified-email.ts';
import { FOLLOWUP_CONSENT_VERSION } from '../src/followup.ts';

test('lookup contract: only a server-confirmed auth user binds; key goes only to the issuer', async () => {
  assert.deepEqual(await noAuthUserLookup('uid-1'), { status: 'unavailable', reason: 'not_configured' });
  const lk = supabaseAuthUserLookup({ authIssuer: 'https://issuer.test/', authServiceRoleKey: 'test-service-key' } as any);
  const realFetch = globalThis.fetch;
  const setFetch = (impl: any) => { (globalThis as any).fetch = impl; };
  try {
    let seenUrl = ''; let seenKey = ''; let seenAuth = '';
    setFetch(async (url: any, init: any) => { seenUrl = String(url); seenKey = init.headers.apikey; seenAuth = init.headers.authorization;
      return new Response(JSON.stringify({ id: 'uid-1', email: 'a@example.in', email_confirmed_at: '2026-10-01T00:00:00Z' }), { status: 200 }); });
    assert.deepEqual(await lk('uid-1'), { status: 'verified', email: 'a@example.in' });
    assert.equal(seenUrl, 'https://issuer.test/admin/users/uid-1');
    assert.equal(seenKey, 'test-service-key'); assert.equal(seenAuth, 'Bearer test-service-key');
    setFetch(async () => new Response(JSON.stringify({ id: 'uid-1', email: 'a@example.in', email_confirmed_at: null }), { status: 200 }));
    assert.deepEqual(await lk('uid-1'), { status: 'unavailable', reason: 'unconfirmed' });
    setFetch(async () => new Response(JSON.stringify({ id: 'uid-OTHER', email: 'a@example.in', email_confirmed_at: '2026-10-01T00:00:00Z' }), { status: 200 }));
    assert.deepEqual(await lk('uid-1'), { status: 'unavailable', reason: 'not_found' }); // never bind another user's record
    setFetch(async () => new Response(JSON.stringify({ id: 'uid-1', email_confirmed_at: '2026-10-01T00:00:00Z' }), { status: 200 }));
    assert.deepEqual(await lk('uid-1'), { status: 'unavailable', reason: 'no_email' });
    setFetch(async () => new Response('nope', { status: 404 }));
    assert.deepEqual(await lk('uid-1'), { status: 'unavailable', reason: 'not_found' });
    setFetch(async () => new Response('err', { status: 500 }));
    assert.deepEqual(await lk('uid-1'), { status: 'unavailable', reason: 'lookup_failed' });
    setFetch(async () => { throw new Error('network down'); });
    assert.deepEqual(await lk('uid-1'), { status: 'unavailable', reason: 'lookup_failed' });
  } finally { (globalThis as any).fetch = realFetch; }
});

// Route-level: campaign create resolves the trusted address through the injected lookup.
let w: World;
let lookupResult: VerifiedEmail = { status: 'unavailable', reason: 'not_found' };
let lookupCalls: string[] = [];
const fakeLookup: AuthUserLookup = async (id) => { lookupCalls.push(id); return lookupResult; };
before(async () => {
  w = await newWorld({ followupPipeline: true }, undefined, undefined, fakeLookup);
  await w.adminDb.query(fs.readFileSync('db-pending/011_followup_pipeline.sql', 'utf8'));
});
after(async () => { await w.close(); });

const STAGES = [7, 10, 15, 30].map((day) => ({ day, subject: 's', body_text: 'b' }));
let n = 0;
async function setup() {
  const sub = 've-' + ++n;
  const c = client(w, await sign(sub)); // stock token: NO email claim at all
  const issueId = (await c.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + Math.random() / 1e4, lon: P_NOROAD.lon + Math.random() / 1e4 }))).json.issue.id;
  await c.post('/v1/me/mail-consent', { kind: 'report_reminders', granted: true, scope_version: FOLLOWUP_CONSENT_VERSION });
  return { sub, c, issueId };
}
const create = (c: any, issueId: string, email: string) =>
  c.post(`/v1/issues/${issueId}/followup-campaigns`, { audience: 'reporter', recipient_descriptor: 'self', recipient_email: email, stages: STAGES, idempotency_key: 've-' + Math.random() });

test('route: stock-JWT user binds via server-confirmed record; unconfirmed/unavailable 400 honestly', async () => {
  const a = await setup();
  lookupCalls = []; lookupResult = { status: 'verified', email: 'a@example.in' };
  const ok = await create(a.c, a.issueId, 'a@example.in');
  assert.equal(ok.status, 201);
  assert.deepEqual(lookupCalls, [a.sub], 'lookup bound to the token subject (issuer is the configured project)');
  assert.equal((await w.adminDb.query(`SELECT recipient_address, recipient_verified FROM followup_campaign WHERE id=$1`, [ok.json.campaign_id])).rows[0].recipient_address, 'a@example.in');
  // mismatched body email is still rejected against the TRUSTED address
  const b = await setup();
  lookupResult = { status: 'verified', email: 'b-real@example.in' };
  assert.equal((await create(b.c, b.issueId, 'b-fake@example.in')).status, 403); // recipient_mismatch
  // unconfirmed / not found / lookup failure all 400 honestly, nothing stored
  for (const r of [{ status: 'unavailable', reason: 'unconfirmed' }, { status: 'unavailable', reason: 'not_found' }, { status: 'unavailable', reason: 'lookup_failed' }] as VerifiedEmail[]) {
    const u = await setup();
    lookupResult = r;
    const res = await create(u.c, u.issueId, 'x@example.in');
    assert.equal(res.status, 400, JSON.stringify(r));
    assert.equal(res.json.error, 'signin_email_unavailable');
  }
});
