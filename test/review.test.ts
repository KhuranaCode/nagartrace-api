import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, reportBody, P_WARRANTY, P_UTILITY, P_NOROAD, jpeg, type World } from './helpers.ts';
import { fromEnv } from '../src/config.ts';

let w: World; let s: Awaited<ReturnType<typeof seed>>;
before(async () => { w = await newWorld({ verificationMode: 'officer_review' }); s = await seed(w); });
after(async () => { await w.close(); });

test('default policy: plausible GPS/time never verifies or assigns; routing is only a suggestion', async () => {
  assert.equal(fromEnv({ POLICY_USE_DEV_DEFAULTS: 'synthetic-test-only', AUTH_ISSUER: 'x', AUTH_AUDIENCE: 'y', AUTH_JWKS_URL: 'https://z', DATABASE_URL: 'd' } as any).verificationMode, 'officer_review');
  const a = await s.mk('rv-a');
  const r = await a.c.post('/v1/reports', reportBody(P_WARRANTY));
  assert.equal(r.status, 201);
  const iss = r.json.issue;
  assert.equal(iss.status, 'reported'); assert.equal(iss.responsible, null); assert.equal(iss.deadline_at, null);
  const row = (await w.adminDb.query('SELECT status, responsible_org_id, suggested_kind, deadline_at FROM issues WHERE id=$1', [iss.id])).rows[0];
  assert.equal(row.responsible_org_id, null); assert.equal(row.suggested_kind, 'contractor'); assert.equal(row.deadline_at, null);
  const ev = (await w.adminDb.query(`SELECT kind FROM status_events WHERE issue_id=$1 ORDER BY id`, [iss.id])).rows.map((x: any) => x.kind);
  assert.deepEqual(ev, ['created', 'routing_suggested']); // no auto_verified, no routed
  assert.equal((await w.adminDb.query(`SELECT count(*)::int n FROM points_ledger WHERE issue_id=$1`, [iss.id])).rows[0].n, 0); // no "verified report" points yet
  // contractor, utility and the public see no authority and no suggestion
  assert.equal((await s.contractor.c.get(`/v1/issues/${iss.id}`)).status, 404);
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/accept`)).status, 404);
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/start`)).status, 404);
  const pub = await w.app.inject({ method: 'GET', url: `/v1/public/issues/${iss.id}` });
  assert.equal(pub.json().status, 'reported'); assert.equal(pub.json().responsible, null);
  assert.ok(!JSON.stringify(pub.json()).includes('suggest'));
  assert.equal((await w.app.inject({ method: 'GET', url: '/health' })).json().verification_mode, 'officer_review');
});

test('only the reviewing municipality officer can verify; verification assigns, starts the clock, awards deferred points', async () => {
  const a = await s.mk('rv-b'); const b = await s.mk('rv-b2');
  const iss = (await a.c.post('/v1/reports', reportBody(P_UTILITY))).json.issue;
  assert.equal((await b.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'looks real to me' })).status, 404); // citizen
  assert.equal((await a.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'my own report is real' })).status, 404); // reporter cannot self-verify
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'contractor tries it' })).status, 404);
  assert.equal((await s.officer.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'short' })).status, 400); // reason required
  assert.ok((await s.officer.c.get('/v1/issues?status=reported')).json.issues.some((i: any) => i.id === iss.id)); // officer sees pending
  const v = await s.officer.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'Checked photo and location, real hazard' });
  assert.equal(v.status, 200); assert.equal(v.json.status, 'assigned'); assert.equal(v.json.responsible_kind, 'utility');
  const after = (await a.c.get(`/v1/issues/${iss.id}`)).json;
  assert.equal(after.status, 'assigned'); assert.equal(after.responsible.kind, 'utility'); assert.ok(after.deadline_at);
  const ev = (await w.adminDb.query(`SELECT kind, actor_id FROM status_events WHERE issue_id=$1 ORDER BY id`, [iss.id])).rows;
  assert.deepEqual(ev.map((x: any) => x.kind), ['created', 'routing_suggested', 'verified_by_officer', 'routed']);
  assert.equal(ev[2].actor_id, s.officer.id);
  assert.equal((await w.adminDb.query(`SELECT COALESCE(sum(delta),0)::int n FROM points_ledger WHERE issue_id=$1 AND user_id=$2`, [iss.id, a.id])).rows[0].n, 15);
  assert.equal((await s.officer.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'twice is not allowed' })).status, 404); // no longer pending
});

test('rejecting leaves no authority, no points, and the evidence stays reviewer/reporter-only', async () => {
  const a = await s.mk('rv-c');
  const iss = (await a.c.post('/v1/reports', reportBody(P_WARRANTY, { note: 'x' }))).json.issue;
  const up = await a.c.upload(`/v1/issues/${iss.id}/evidence?kind=report&lat=${P_WARRANTY.lat}&lon=${P_WARRANTY.lon}`, await jpeg());
  assert.equal(up.status, 201);
  const eid = up.json.id ?? up.json.evidence_id;
  assert.equal((await s.contractor.c.get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 404);
  assert.equal((await s.officer.c.get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 200); // reviewing officer
  const r = await s.officer.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'reject', reason: 'Photo shows no hazard at this spot' });
  assert.equal(r.json.status, 'rejected');
  assert.equal((await w.adminDb.query(`SELECT count(*)::int n FROM points_ledger WHERE issue_id=$1`, [iss.id])).rows[0].n, 0);
  assert.equal((await s.contractor.c.get(`/v1/issues/${iss.id}`)).status, 404);
});

test('road not in registry: still pending, reviewer is the municipality, never auto-assigned', async () => {
  const a = await s.mk('rv-d');
  const iss = (await a.c.post('/v1/reports', reportBody(P_NOROAD))).json.issue;
  assert.equal(iss.status, 'reported'); assert.equal(iss.responsible, null); assert.deepEqual((await w.adminDb.query('SELECT suggested_flags f FROM issues WHERE id=$1', [iss.id])).rows[0].f, ['road_not_in_registry']);
  const v = await s.officer.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'Real hazard, unknown road, city handles' });
  assert.equal(v.json.responsible_kind, 'municipality');
});

test('duplicate reports on a pending issue do not earn points until verification; after verification they do', async () => {
  const a = await s.mk('rv-e'); const b = await s.mk('rv-e2'); const c = await s.mk('rv-e3');
  const iss = (await a.c.post('/v1/reports', reportBody({ lat: 30.7000, lon: 76.7020 }))).json.issue;
  const m = await b.c.post('/v1/reports', reportBody({ lat: 30.7000, lon: 76.7020 })); assert.equal(m.json.merged_into_existing, true);
  assert.equal((await w.adminDb.query(`SELECT count(*)::int n FROM points_ledger WHERE issue_id=$1`, [iss.id])).rows[0].n, 0);
  await s.officer.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'Two photos agree, real hazard' });
  assert.equal((await w.adminDb.query(`SELECT COALESCE(sum(delta),0)::int n FROM points_ledger WHERE issue_id=$1 AND user_id=$2`, [iss.id, b.id])).rows[0].n, 10);
  await c.c.post('/v1/reports', reportBody({ lat: 30.7000, lon: 76.7020 }));
  assert.equal((await w.adminDb.query(`SELECT COALESCE(sum(delta),0)::int n FROM points_ledger WHERE issue_id=$1 AND user_id=$2`, [iss.id, c.id])).rows[0].n, 10);
});

test('golden path under officer_review: report > verify > accept > start > proof > 2 confirmations > fixed, with audit trail', async () => {
  const r1 = await s.mk('gp-r1'); const r2 = await s.mk('gp-r2');
  const base = { lat: 30.7000, lon: 76.7090 };
  const iss = (await r1.c.post('/v1/reports', reportBody(base))).json.issue;
  await r2.c.post('/v1/reports', reportBody({ lat: base.lat + 0.00005, lon: base.lon })); // duplicate merges
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/accept`)).status, 404); // nothing assigned yet
  assert.equal((await s.officer.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'Reviewed report, location matches road' })).json.status, 'assigned');
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/accept`)).status, 200);
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/start`)).status, 200);
  const up = await s.contractor.c.upload(`/v1/issues/${iss.id}/evidence?kind=after&lat=${base.lat}&lon=${base.lon}`, await jpeg());
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/submit-repair`, { evidence_id: up.json.evidence_id })).json.status, 'awaiting_confirmation');
  assert.equal((await r1.c.post(`/v1/issues/${iss.id}/confirm`, { is_fixed: true })).json.status, 'awaiting_confirmation');
  assert.equal((await r2.c.post(`/v1/issues/${iss.id}/confirm`, { is_fixed: true })).json.status, 'fixed');
  const kinds = (await w.adminDb.query(`SELECT kind FROM status_events WHERE issue_id=$1 ORDER BY id`, [iss.id])).rows.map((x: any) => x.kind);
  for (const k of ['created', 'routing_suggested', 'verified_by_officer', 'routed', 'started', 'repair_submitted', 'fixed_by_citizens']) assert.ok(kinds.includes(k), k);
  assert.ok(kinds.indexOf('verified_by_officer') < kinds.indexOf('started'));
  assert.equal((await w.app.inject({ method: 'GET', url: `/v1/public/issues/${iss.id}` })).json().status, 'fixed');
});
