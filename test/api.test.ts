import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, client, sign, wrongKeyToken, reportBody, jpeg, P_WARRANTY, P_UTILITY, P_EXPIRED, P_NOROAD, type World } from './helpers.ts';

let w: World; let s: Awaited<ReturnType<typeof seed>>; const clock = { t: Date.now() };
before(async () => { w = await newWorld({}, clock); s = await seed(w); });
after(async () => { await w.close(); });

const citizen = async (n: string) => s.mk(n);
const report = (u: { c: ReturnType<typeof client> }, p: any, extra: any = {}, hdr: Record<string, string> = {}) => u.c.post('/v1/reports', reportBody(p, extra, new Date(clock.t)), hdr);

test('auth: bad tokens are rejected, identity bound to issuer+subject', async () => {
  const anon = await w.app.inject({ method: 'GET', url: '/v1/me' });
  assert.equal(anon.statusCode, 401);
  for (const t of [await sign('x', { iss: 'https://evil/' }), await sign('x', { aud: 'other' }), await sign('x', { exp: '-1m' }), await wrongKeyToken('x'), 'garbage']) {
    assert.equal((await client(w, t).get('/v1/me')).status, 401);
  }
  const unsigned = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: 'a', iss: 'https://issuer.test/', aud: 'nagartrace-api', exp: 9999999999 })).toString('base64url') + '.';
  assert.equal((await client(w, unsigned).get('/v1/me')).status, 401);
});

test('roles cannot be self-granted (token claims, profile fields, admin endpoints)', async () => {
  const t = await sign('sneaky', { extra: { role: 'admin', roles: ['admin', 'officer'] } });
  const c = client(w, t);
  const me = (await c.get('/v1/me')).json;
  assert.deepEqual(me.memberships, []);
  assert.equal((await c.patch('/v1/me', { role: 'admin' })).status, 400);
  assert.equal((await c.post('/v1/admin/memberships', { user_id: me.id, org_id: s.muni, role: 'admin' })).status, 403);
  assert.equal((await c.post('/v1/admin/orgs', { kind: 'contractor', name: 'Fake Co' })).status, 403);
  assert.equal((await c.post('/v1/admin/jobs/escalate')).status, 403);
  // contractor/officer cannot grant either
  assert.equal((await s.officer.c.post('/v1/admin/memberships', { user_id: me.id, org_id: s.muni, role: 'officer' })).status, 403);
  assert.equal((await s.contractor.c.post('/v1/admin/memberships', { user_id: me.id, org_id: s.contractorOrg, role: 'contractor' })).status, 403);
  // runtime DB role cannot rewrite memberships or the audit trail
  await assert.rejects(w.runtime.query(`UPDATE memberships SET role='admin'`));
});

test('registry import validates and is scoped to the municipality admin', async () => {
  const bad = (b: any) => s.admin.c.post('/v1/admin/registry/import', { municipality_org_id: s.muni, source_label: 'x test', is_synthetic: true, roads: [], ...b });
  assert.equal((await bad({ roads: [{ code: 'A', name: 'a', coordinates: [[76.7, 30.7], [76.71, 30.7]] }, { code: 'A', name: 'b', coordinates: [[76.7, 30.7], [76.71, 30.7]] }] })).status, 400);
  assert.equal((await bad({ roads: [{ code: 'Z1', name: 'z', coordinates: [[76.7, 30.7], [76.71, 30.7]] }], contracts: [{ road_code: 'Z1', contractor_name: 'Bad Dates', completion_date: '2024-01-01', warranty_end: '2023-01-01' }] })).status, 400);
  assert.equal((await bad({ contracts: [{ road_code: 'NOPE', contractor_name: 'Ghost Co', completion_date: '2024-01-01', warranty_end: '2025-01-01' }] })).status, 400);
  assert.equal((await bad({ roads: [{ code: 'R-WARR', name: 'dup', coordinates: [[76.7, 30.7], [76.71, 30.7]] }] })).status, 409);
  assert.equal((await bad({ roads: [{ code: 'BAD', name: 'b', coordinates: [[200, 30.7], [76.71, 30.7]] }] })).status, 400);
  // failed imports leave nothing behind
  assert.equal((await w.adminDb.query(`SELECT count(*)::int n FROM road_segments WHERE code IN ('Z1','BAD')`)).rows[0].n, 0);
  assert.equal((await w.adminDb.query(`SELECT count(*)::int n FROM orgs WHERE name IN ('Bad Dates','Ghost Co')`)).rows[0].n, 0);
  const u = await citizen('imp-citizen');
  assert.equal((await u.c.post('/v1/admin/registry/import', { municipality_org_id: s.muni, source_label: 'x test', is_synthetic: true, roads: [] })).status, 403);
  assert.equal((await s.officer.c.post('/v1/admin/registry/import', { municipality_org_id: s.muni, source_label: 'x test', is_synthetic: true, roads: [] })).status, 403);
});

test('routing: warranty, utility precedence, expired, unknown road, severity deadlines', async () => {
  const a = await citizen('r-a');
  const warr = (await report(a, P_WARRANTY)).json.issue;
  assert.equal(warr.status, 'assigned'); assert.equal(warr.responsible.kind, 'contractor'); assert.equal(warr.responsible.name, 'Sharma Infra'); assert.equal(warr.copy_org, 'Test Municipality');
  const days = (new Date(warr.deadline_at).getTime() - clock.t) / 86400000; assert.ok(Math.abs(days - 7) < 0.01);
  const b = await citizen('r-b');
  const util = (await report(b, P_UTILITY)).json.issue;
  assert.equal(util.responsible.kind, 'utility'); assert.equal(util.responsible.name, 'Test Telecom'); // utility beats an active warranty on the same road
  const c = await citizen('r-c');
  const exp = (await report(c, P_EXPIRED)).json.issue;
  assert.equal(exp.responsible.kind, 'municipality'); assert.deepEqual(exp.route_flags, []);
  const d = await citizen('r-d');
  const none = (await report(d, P_NOROAD)).json.issue;
  assert.equal(none.responsible.kind, 'municipality'); assert.deepEqual(none.route_flags, ['road_not_in_registry']);
  const e = await citizen('r-e');
  const hi = (await report(e, { lat: 30.7399, lon: 76.7051 }, { hazard: 'missing_cover', danger: true })).json.issue; // 3 + 2 = severity 5 on the expired-warranty road
  assert.equal(hi.severity, 5);
  const hrs = (new Date(hi.deadline_at).getTime() - clock.t) / 3600000; assert.ok(Math.abs(hrs - 48) < 0.01);
});

test('duplicates merge within 30 m, not across hazards or distance, once per user', async () => {
  const base = { lat: 30.7000, lon: 76.7020 };
  const u1 = await citizen('d-1'); const u2 = await citizen('d-2'); const u3 = await citizen('d-3'); const u4 = await citizen('d-4');
  const first = (await report(u1, base)).json;
  const near = (await report(u2, { lat: base.lat + 0.00015, lon: base.lon })).json; // ~17 m
  assert.equal(near.merged_into_existing, true); assert.equal(near.issue.id, first.issue.id); assert.equal(near.issue.reports_count, 2);
  assert.equal((await report(u1, base)).status, 409);
  const far = (await report(u3, { lat: base.lat + 0.0006, lon: base.lon })).json; // ~67 m
  assert.notEqual(far.issue.id, first.issue.id);
  const other = (await report(u4, base, { hazard: 'crack' })).json;
  assert.notEqual(other.issue.id, first.issue.id);
  assert.ok(near.issue.severity >= first.issue.severity);
});

test('report validation, idempotency, daily cap', async () => {
  const u = await citizen('v-1');
  const at = (ms: number) => new Date(clock.t + ms);
  assert.equal((await u.c.post('/v1/reports', reportBody(P_WARRANTY, {}, at(-16 * 60000)))).status, 422);
  assert.equal((await u.c.post('/v1/reports', reportBody(P_WARRANTY, {}, at(10 * 60000)))).status, 422);
  assert.equal((await u.c.post('/v1/reports', reportBody(P_WARRANTY, { accuracy_m: 500 }, at(0)))).status, 422);
  assert.equal((await u.c.post('/v1/reports', reportBody({ lat: 95, lon: 0 }, {}, at(0)))).status, 400);
  assert.equal((await u.c.post('/v1/reports', { ...reportBody(P_WARRANTY, {}, at(0)), hazard: 'meteor' })).status, 400);
  assert.equal((await u.c.post('/v1/reports', { ...reportBody(P_WARRANTY, {}, at(0)), reporter_id: 'x' })).status, 400);
  const p = { lat: 30.7000, lon: 76.7090 };
  const r1 = await u.c.post('/v1/reports', reportBody(p, {}, at(0)), { 'idempotency-key': 'k1' });
  const r2 = await u.c.post('/v1/reports', reportBody(p, {}, at(0)), { 'idempotency-key': 'k1' });
  assert.equal(r1.status, 201); assert.equal(r2.status, 200); assert.equal(r2.json.replayed, true); assert.equal(r1.json.report_id, r2.json.report_id);
  const capped = await citizen('v-cap');
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await report(capped, { lat: 30.7000 + i * 0.001, lon: 76.7060 })).status;
  assert.equal(last, 429);
});

test('concurrent reports at one spot create exactly one issue', async () => {
  const p = { lat: 30.7000, lon: 76.7030 };
  const users = await Promise.all(Array.from({ length: 6 }, (_, i) => citizen('conc-' + i)));
  const rs = await Promise.all(users.map((u) => report(u, { lat: p.lat - 0.0003, lon: p.lon })));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201));
  assert.equal(new Set(rs.map((r) => r.json.issue.id)).size, 1);
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
});

async function toAwaiting(tag: string, point = P_WARRANTY) {
  const lat = point.lat + (tag.length % 7) * 0.00001; // keep distinct spots per test via small offsets
  const base = { lat: point.lat, lon: 76.7012 };
  const r1 = await citizen(tag + '-r1'); const r2 = await citizen(tag + '-r2');
  const first = (await report(r1, base)).json;
  await report(r2, { lat: base.lat + 0.00005, lon: base.lon });
  const id = first.issue.id as string;
  assert.equal((await s.contractor.c.post(`/v1/issues/${id}/start`)).status, 200);
  const up = await s.contractor.c.upload(`/v1/issues/${id}/evidence?kind=after&lat=${base.lat}&lon=${base.lon}`, await jpeg());
  assert.equal(up.status, 201);
  assert.equal((await s.contractor.c.post(`/v1/issues/${id}/submit-repair`, { evidence_id: up.json.evidence_id })).status, 200);
  void lat;
  return { id, r1, r2, base };
}

test('repair workflow: location-checked proof, eligibility, two confirmations, audit trail, points', async () => {
  const id0 = (await citizen('wf-x')); void id0;
  const base = { lat: 30.7000, lon: 76.7005 };
  const r1 = await citizen('wf-r1'); const r2 = await citizen('wf-r2'); const stranger = await citizen('wf-stranger');
  const issue = (await report(r1, base)).json.issue; await report(r2, { lat: base.lat + 0.00005, lon: base.lon });
  const id = issue.id;
  // outsiders cannot act or even see it
  assert.equal((await stranger.c.post(`/v1/issues/${id}/start`)).status, 404);
  assert.equal((await stranger.c.get(`/v1/issues/${id}`)).status, 404);
  assert.equal((await s.contractor.c.post(`/v1/issues/${id}/submit-repair`, { evidence_id: '00000000-0000-4000-8000-000000000000' })).status, 422); // must start first, and needs proof
  assert.equal((await s.contractor.c.post(`/v1/issues/${id}/start`)).status, 200);
  // after-photo far from the issue is refused; no proof, no submit
  assert.equal((await s.contractor.c.upload(`/v1/issues/${id}/evidence?kind=after&lat=${base.lat + 0.01}&lon=${base.lon}`, await jpeg())).status, 422);
  assert.equal((await s.contractor.c.post(`/v1/issues/${id}/submit-repair`, { evidence_id: '00000000-0000-4000-8000-000000000000' })).status, 422);
  const up = await s.contractor.c.upload(`/v1/issues/${id}/evidence?kind=after&lat=${base.lat}&lon=${base.lon}`, await jpeg());
  assert.equal((await s.contractor.c.post(`/v1/issues/${id}/submit-repair`, { evidence_id: up.json.evidence_id })).json.status, 'awaiting_confirmation');
  // contractor cannot confirm their own fix; strangers cannot vote; one vote per citizen
  assert.equal((await s.contractor.c.post(`/v1/issues/${id}/confirm`, { is_fixed: true })).status, 403);
  assert.equal((await stranger.c.post(`/v1/issues/${id}/confirm`, { is_fixed: true })).status, 403);
  const v1 = await r1.c.post(`/v1/issues/${id}/confirm`, { is_fixed: true });
  assert.equal(v1.json.status, 'awaiting_confirmation');
  assert.equal((await r1.c.post(`/v1/issues/${id}/confirm`, { is_fixed: true })).status, 409);
  assert.equal((await r2.c.post(`/v1/issues/${id}/confirm`, { is_fixed: true })).json.status, 'fixed');
  const detail = (await r1.c.get(`/v1/issues/${id}`)).json;
  assert.equal(detail.status, 'fixed');
  assert.deepEqual(detail.events.map((e: any) => e.kind).filter((k: string) => ['created', 'auto_verified', 'routed', 'started', 'repair_submitted', 'fixed_by_citizens'].includes(k)), ['created', 'auto_verified', 'routed', 'started', 'repair_submitted', 'fixed_by_citizens']);
  const pts = (await w.adminDb.query(`SELECT reason, delta FROM points_ledger WHERE user_id=$1 ORDER BY id`, [r2.id])).rows.map((x) => x.reason);
  assert.ok(pts.includes('confirmed_fix') && pts.includes('verified_report'));
  // audit trail is append-only even for the API's DB role
  await assert.rejects(w.runtime.query(`UPDATE status_events SET reason='x'`));
  await assert.rejects(w.runtime.query(`DELETE FROM status_events`));
});

test('rejected repair reopens with a fresh deadline; municipal approval/rejection needs a reason and the right org', async () => {
  const x = await toAwaiting('rej');
  const before = (await w.adminDb.query('SELECT deadline_at FROM issues WHERE id=$1', [x.id])).rows[0].deadline_at;
  clock.t += 3 * 3600_000;
  assert.equal((await x.r1.c.post(`/v1/issues/${x.id}/confirm`, { is_fixed: false })).json.status, 'awaiting_confirmation');
  const rej = await x.r2.c.post(`/v1/issues/${x.id}/confirm`, { is_fixed: false });
  assert.equal(rej.json.status, 'reopened');
  const row = (await w.adminDb.query('SELECT status, reopen_count, deadline_at FROM issues WHERE id=$1', [x.id])).rows[0];
  assert.equal(row.status, 'reopened'); assert.equal(row.reopen_count, 1);
  assert.ok(new Date(row.deadline_at) > new Date(before));
  // new round: previous votes do not carry over; contractor re-submits; officer decides
  assert.equal((await s.contractor.c.post(`/v1/issues/${x.id}/start`)).status, 200);
  const up = await s.contractor.c.upload(`/v1/issues/${x.id}/evidence?kind=after&lat=${x.base.lat}&lon=${x.base.lon}`, await jpeg());
  await s.contractor.c.post(`/v1/issues/${x.id}/submit-repair`, { evidence_id: up.json.evidence_id });
  assert.equal((await x.r1.c.post(`/v1/issues/${x.id}/confirm`, { is_fixed: true })).json.status, 'awaiting_confirmation');
  assert.equal((await s.officer.c.post(`/v1/issues/${x.id}/municipal-decision`, { decision: 'approve', reason: 'short' })).status, 400);
  assert.equal((await s.contractor.c.post(`/v1/issues/${x.id}/municipal-decision`, { decision: 'approve', reason: 'I did it really' })).status, 404);
  const ok = await s.officer.c.post(`/v1/issues/${x.id}/municipal-decision`, { decision: 'approve', reason: 'Site inspected by officer' });
  assert.equal(ok.json.status, 'fixed');
  const kinds = (await s.officer.c.get(`/v1/issues/${x.id}`)).json.events.map((e: any) => e.kind);
  assert.ok(kinds.includes('reopened') && kinds.includes('fixed_by_municipal_approval'));
});

test('new accounts cannot confirm repairs (anti-abuse gate), real age check', async () => {
  const w2 = await newWorld({ confirmMinAccountAgeHours: 24 });
  try {
    const s2 = await seed(w2);
    const r1 = await s2.mk('gate-r1');
    const rep = (await r1.c.post('/v1/reports', reportBody(P_WARRANTY, {}))).json.issue;
    await s2.contractor.c.post(`/v1/issues/${rep.id}/start`);
    const up = await s2.contractor.c.upload(`/v1/issues/${rep.id}/evidence?kind=after&lat=${P_WARRANTY.lat}&lon=${P_WARRANTY.lon}`, await jpeg());
    await s2.contractor.c.post(`/v1/issues/${rep.id}/submit-repair`, { evidence_id: up.json.evidence_id });
    assert.equal((await r1.c.post(`/v1/issues/${rep.id}/confirm`, { is_fixed: true })).status, 403);
    await w2.adminDb.query(`UPDATE users SET created_at = now() - interval '2 days' WHERE id=$1`, [r1.id]);
    assert.equal((await r1.c.post(`/v1/issues/${rep.id}/confirm`, { is_fixed: true })).status, 200);
  } finally { await w2.close(); }
});

test('disputes: window, who may raise, officer decision re-routes, evidence ownership', async () => {
  const base = { lat: 30.7000, lon: 76.7080 };
  const r = await citizen('dp-r');
  const iss = (await report(r, base)).json.issue;
  const other = await s.mk('contractor-2');
  const otherOrg = (await w.adminDb.query(`INSERT INTO orgs (kind,name) VALUES ('contractor','Other Co') RETURNING id`)).rows[0].id;
  await s.admin.c.post('/v1/admin/memberships', { user_id: other.id, org_id: otherOrg, role: 'contractor' });
  assert.equal((await other.c.post(`/v1/issues/${iss.id}/dispute`, { reason: 'Not mine at all really' })).status, 404); // other contractor cannot see it
  assert.equal((await r.c.post(`/v1/issues/${iss.id}/dispute`, { reason: 'Not mine at all really' })).status, 404); // citizens cannot dispute
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/dispute`, { reason: 'short' })).status, 400);
  const dev = await s.contractor.c.upload(`/v1/issues/${iss.id}/evidence?kind=dispute&lat=${base.lat}&lon=${base.lon}`, await jpeg());
  assert.equal(dev.status, 201);
  const d = await s.contractor.c.post(`/v1/issues/${iss.id}/dispute`, { reason: 'Telecom trench cut here last month', evidence_id: dev.json.evidence_id });
  assert.equal(d.status, 201);
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/dispute`, { reason: 'Telecom trench cut here again' })).status, 409);
  assert.equal((await s.contractor.c.post(`/v1/disputes/${d.json.dispute_id}/decide`, { decision: 'upheld', reason: 'I decide for myself' })).status, 404);
  assert.equal((await s.officer.c.post(`/v1/disputes/${d.json.dispute_id}/decide`, { decision: 'upheld', reason: 'ok' })).status, 400);
  const dec = await s.officer.c.post(`/v1/disputes/${d.json.dispute_id}/decide`, { decision: 'upheld', reason: 'Utility cut log confirms trench' });
  assert.equal(dec.status, 200);
  const after = (await s.officer.c.get(`/v1/issues/${iss.id}`)).json;
  assert.equal(after.responsible.kind, 'municipality'); assert.equal(after.route_overridden, true);
  assert.equal((await s.officer.c.post(`/v1/disputes/${d.json.dispute_id}/decide`, { decision: 'rejected', reason: 'Changing my mind later' })).status, 409);
  // window: a fresh issue, 49 hours later
  const iss2 = (await report(await citizen('dp-r2'), { lat: 30.7000, lon: 76.7092 })).json.issue;
  clock.t += 49 * 3600_000;
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss2.id}/dispute`, { reason: 'Too late to say this now' })).status, 409);
});

test('route override needs a reason and municipal staff of that issue', async () => {
  const iss = (await report(await citizen('ov-r'), { lat: 30.7000, lon: 76.7096 }, { hazard: 'crack' })).json.issue;
  assert.equal((await s.officer.c.post(`/v1/issues/${iss.id}/override-route`, { org_id: s.muni, reason: 'x' })).status, 400);
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/override-route`, { org_id: s.muni, reason: 'Take it back please' })).status, 404);
  assert.equal((await s.officer.c.post(`/v1/issues/${iss.id}/override-route`, { org_id: s.utilityOrg, reason: 'Gas utility trench seen on site' })).status, 200);
  const d = (await s.officer.c.get(`/v1/issues/${iss.id}`)).json;
  assert.equal(d.responsible.kind, 'utility'); assert.ok(d.events.some((e: any) => e.kind === 'route_override' && e.reason.includes('Gas utility')));
});

test('escalation records are idempotent and never delivered', async () => {
  const w3clock = { t: Date.now() };
  const w3 = await newWorld({}, w3clock);
  try {
    const s3 = await seed(w3);
    const u = await s3.mk('esc-u');
    const iss = (await u.c.post('/v1/reports', reportBody(P_WARRANTY, {}, new Date(w3clock.t)))).json.issue;
    assert.deepEqual((await s3.admin.c.post('/v1/admin/jobs/escalate')).json, { level1: 0, level2: 0 });
    w3clock.t += 8 * 86400_000;
    assert.deepEqual((await s3.admin.c.post('/v1/admin/jobs/escalate')).json, { level1: 1, level2: 0 });
    assert.deepEqual((await s3.admin.c.post('/v1/admin/jobs/escalate')).json, { level1: 0, level2: 0 });
    w3clock.t += 3 * 86400_000;
    assert.deepEqual((await s3.admin.c.post('/v1/admin/jobs/escalate')).json, { level1: 0, level2: 1 });
    const n = (await w3.adminDb.query('SELECT target FROM escalation_events WHERE issue_id=$1 ORDER BY level', [iss.id])).rows.map((r) => r.target);
    assert.deepEqual(n, ['municipal_engineer', 'department_head']);
  } finally { await w3.close(); }
});

test('public endpoints expose no reporter, evidence or exact coordinates; scorecards gated; leaderboard needs login', async () => {
  const u = await citizen('pub-u');
  const iss = (await report(u, { lat: 30.70001234, lon: 76.70912345 }, { hazard: 'broken_edge' })).json.issue;
  await u.c.upload(`/v1/issues/${iss.id}/evidence?kind=report&lat=30.70001234&lon=76.70912345`, await jpeg());
  const pub = await w.app.inject({ method: 'GET', url: `/v1/public/issues/${iss.id}` });
  assert.equal(pub.statusCode, 200);
  const body = pub.body;
  const j = pub.json();
  assert.equal(j.location.lat, 30.7); assert.equal(j.location.lon, 76.7091);
  for (const forbidden of ['reporter', 'evidence', 'user', 'alias', u.id, 'storage']) assert.ok(!body.includes(forbidden), 'public body leaked ' + forbidden);
  const list = await w.app.inject({ method: 'GET', url: '/v1/public/issues?limit=5' });
  assert.equal(list.statusCode, 200); assert.ok(!list.body.includes(u.id));
  assert.equal((await w.app.inject({ method: 'GET', url: '/v1/public/scorecards' })).statusCode, 404);
  assert.equal((await w.app.inject({ method: 'GET', url: '/v1/leaderboard' })).statusCode, 401);
  assert.equal((await w.app.inject({ method: 'GET', url: '/v1/public/issues/not-a-uuid' })).statusCode, 400);
  assert.equal((await s.officer.c.get('/v1/admin/scorecards')).status, 200);
  assert.equal((await u.c.get('/v1/admin/scorecards')).status, 403);
});

test('evidence: validated by content, metadata stripped, private to participants', async () => {
  const base = { lat: 30.7000, lon: 76.7070 };
  const r = await citizen('ev-r'); const stranger = await citizen('ev-s');
  const iss = (await report(r, base)).json.issue;
  const q = `?kind=report&lat=${base.lat}&lon=${base.lon}`;
  assert.equal((await r.c.upload(`/v1/issues/${iss.id}/evidence${q}`, Buffer.from('<html>not an image</html>'), 'image/jpeg')).status, 415);
  assert.equal((await r.c.upload(`/v1/issues/${iss.id}/evidence${q}`, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]), 'image/jpeg')).status, 422);
  assert.equal((await stranger.c.upload(`/v1/issues/${iss.id}/evidence${q}`, await jpeg())).status, 404);
  assert.equal((await r.c.upload(`/v1/issues/${iss.id}/evidence?kind=report&lat=${base.lat + 0.01}&lon=${base.lon}`, await jpeg())).status, 422);
  const up = await r.c.upload(`/v1/issues/${iss.id}/evidence${q}`, await jpeg(true));
  assert.equal(up.status, 201);
  const got = await r.c.get(`/v1/issues/${iss.id}/evidence/${up.json.evidence_id}`);
  assert.equal(got.status, 200); assert.equal(got.headers['content-type'], 'image/jpeg');
  assert.ok(!got.raw.includes(Buffer.from('SECRET-TEST-TAG')));
  assert.equal((await stranger.c.get(`/v1/issues/${iss.id}/evidence/${up.json.evidence_id}`)).status, 404);
  assert.equal((await w.app.inject({ method: 'GET', url: `/v1/issues/${iss.id}/evidence/${up.json.evidence_id}` })).statusCode, 401);
  assert.equal((await s.contractor.c.get(`/v1/issues/${iss.id}/evidence/${up.json.evidence_id}`)).status, 200);
  assert.equal(((await r.c.get(`/v1/issues/${iss.id}`)).json.redaction).startsWith('none'), true);
});

test('tenant isolation: another contractor cannot see or act on an issue', async () => {
  const iss = (await report(await citizen('tn-r'), { lat: 30.7000, lon: 76.7098 }, { hazard: 'waterlogging' })).json.issue;
  const other = await s.mk('contractor-iso');
  const org = (await w.adminDb.query(`INSERT INTO orgs (kind,name) VALUES ('contractor','Iso Co') RETURNING id`)).rows[0].id;
  await s.admin.c.post('/v1/admin/memberships', { user_id: other.id, org_id: org, role: 'contractor' });
  assert.equal((await other.c.get(`/v1/issues/${iss.id}`)).status, 404);
  assert.equal((await other.c.post(`/v1/issues/${iss.id}/start`)).status, 404);
  assert.equal(((await other.c.get('/v1/issues')).json.issues as any[]).some((i) => i.id === iss.id), false);
  assert.equal(((await s.contractor.c.get('/v1/issues')).json.issues as any[]).some((i) => i.id === iss.id), true);
});

test('daily points cap limits positive points', async () => {
  const w4 = await newWorld({ dailyPointsCap: 20, dailyReportCap: 50 });
  try {
    const s4 = await seed(w4); const u = await s4.mk('pc-u');
    for (let i = 0; i < 4; i++) await u.c.post('/v1/reports', reportBody({ lat: 30.7000, lon: 76.7000 + i * 0.001 }));
    assert.equal((await w4.adminDb.query('SELECT points FROM users WHERE id=$1', [u.id])).rows[0].points, 20);
  } finally { await w4.close(); }
});
