import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, reportBody, P_WARRANTY, P_NOROAD, type World } from './helpers.ts';

let w: World; let s: Awaited<ReturnType<typeof seed>>; let muni2: string; let admin2: Awaited<ReturnType<typeof s.mk>>; let officer2: Awaited<ReturnType<typeof s.mk>>;
before(async () => {
  w = await newWorld({ verificationMode: 'officer_review', unroutedTriage: 'any_municipal_staff' }); s = await seed(w);
  muni2 = (await w.adminDb.query(`INSERT INTO orgs (kind,name) VALUES ('municipality','Second City') RETURNING id`)).rows[0].id;
  admin2 = await s.mk('admin-2'); officer2 = await s.mk('officer-2');
  await w.adminDb.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'admin'),($3,$2,'officer')`, [admin2.id, muni2, officer2.id]);
});
after(async () => { await w.close(); });
const at = (lon: number, extra: Record<string, unknown> = {}) => reportBody({ lat: 30.7000, lon }, extra);

test('F1 grants are bound to the owning municipality; revoke works; no cross-city access', async () => {
  const intruder = await s.mk('intruder');
  // admin of another city cannot make anyone a member of city A's contractor org
  assert.equal((await admin2.c.post('/v1/admin/memberships', { user_id: intruder.id, org_id: s.contractorOrg, role: 'contractor' })).status, 403);
  assert.equal((await admin2.c.post('/v1/admin/memberships', { user_id: intruder.id, org_id: s.utilityOrg, role: 'utility' })).status, 403);
  // cannot create an org for a city they do not administer
  assert.equal((await admin2.c.post('/v1/admin/orgs', { municipality_org_id: s.muni, kind: 'contractor', name: 'Sneaky Co' })).status, 403);
  // can create and grant inside their own city
  const own = await admin2.c.post('/v1/admin/orgs', { municipality_org_id: muni2, kind: 'contractor', name: 'Sharma Infra' }); // same name as city A's: a different org
  assert.equal(own.status, 201); assert.notEqual(own.json.org_id, s.contractorOrg);
  assert.equal((await admin2.c.post('/v1/admin/memberships', { user_id: intruder.id, org_id: own.json.org_id, role: 'contractor' })).status, 201);
  // that membership gives no view of city A's issues
  const r = await (await s.mk('f1-r')).c.post('/v1/reports', at(76.7010));
  const id = r.json.issue.id;
  await s.officer.c.post(`/v1/issues/${id}/verify`, { decision: 'verify', reason: 'Checked, real hazard here' });
  assert.equal((await intruder.c.get(`/v1/issues/${id}`)).status, 404);
  assert.equal((await intruder.c.post(`/v1/issues/${id}/start`)).status, 404);
  // synthetic flag mismatch on the same org is refused, not merged
  assert.equal((await admin2.c.post('/v1/admin/orgs', { municipality_org_id: muni2, kind: 'contractor', name: 'Sharma Infra', is_synthetic: true })).status, 409);
  // revoke: only the owning city's admin; access disappears; own role cannot be revoked; re-grant works
  assert.equal((await admin2.c.post('/v1/admin/memberships/revoke', { user_id: s.contractor.id, org_id: s.contractorOrg, role: 'contractor' })).status, 403);
  assert.equal((await s.contractor.c.get(`/v1/issues/${id}`)).status, 200);
  assert.equal((await s.admin.c.post('/v1/admin/memberships/revoke', { user_id: s.contractor.id, org_id: s.contractorOrg, role: 'contractor' })).status, 200);
  assert.equal((await s.contractor.c.get(`/v1/issues/${id}`)).status, 404);
  assert.equal((await s.admin.c.post('/v1/admin/memberships/revoke', { user_id: s.contractor.id, org_id: s.contractorOrg, role: 'contractor' })).status, 404); // already revoked
  assert.equal((await s.admin.c.post('/v1/admin/memberships/revoke', { user_id: s.admin.id, org_id: s.muni, role: 'admin' })).status, 409);
  assert.equal((await s.admin.c.post('/v1/admin/memberships', { user_id: s.contractor.id, org_id: s.contractorOrg, role: 'contractor' })).status, 201);
  assert.equal((await s.contractor.c.get(`/v1/issues/${id}`)).status, 200);
  await assert.rejects(w.runtime.query('DELETE FROM memberships')); // history is never deleted
});

test('F2 unrouted report with several municipalities is recoverable: visible to municipal staff only, claimable, never auto-assigned', async () => {
  const rep = await s.mk('f2-r');
  const iss = (await rep.c.post('/v1/reports', reportBody(P_NOROAD))).json.issue;
  assert.equal(iss.status, 'reported');
  const row = (await w.adminDb.query('SELECT review_org_id, suggested_flags f FROM issues WHERE id=$1', [iss.id])).rows[0];
  assert.equal(row.review_org_id, null); assert.ok(row.f.includes('needs_manual_routing'));
  assert.equal((await s.contractor.c.get(`/v1/issues/${iss.id}`)).status, 404);
  assert.equal((await (await s.mk('f2-x')).c.get(`/v1/issues/${iss.id}`)).status, 404);
  assert.equal((await s.officer.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'cannot verify before claiming' })).status, 404);
  assert.ok((await officer2.c.get('/v1/issues?status=reported')).json.issues.some((i: any) => i.id === iss.id));
  const tv = await officer2.c.get(`/v1/issues/${iss.id}`);
  assert.equal(tv.status, 200); assert.equal(tv.json.triage_only, true); // public-level view only
  assert.equal(tv.json.events, undefined); assert.equal(tv.json.evidence, undefined); assert.equal(tv.json.danger_flag, undefined);
  assert.equal((await officer2.c.get(`/v1/issues/${iss.id}/evidence/00000000-0000-4000-8000-000000000000`)).status, 404);
  assert.equal((await rep.c.post(`/v1/issues/${iss.id}/claim-review`, { reason: 'reporter tries to claim' })).status, 404);
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/claim-review`, { reason: 'contractor tries to claim' })).status, 404);
  assert.equal((await officer2.c.post(`/v1/issues/${iss.id}/claim-review`, { reason: 'x' })).status, 400);
  const c = await officer2.c.post(`/v1/issues/${iss.id}/claim-review`, { reason: 'Location is inside our boundary' });
  assert.equal(c.status, 200); assert.equal(c.json.status, 'reported');
  assert.equal((await w.adminDb.query('SELECT status, responsible_org_id FROM issues WHERE id=$1', [iss.id])).rows[0].responsible_org_id, null); // still nothing assigned
  assert.equal((await s.officer.c.post(`/v1/issues/${iss.id}/claim-review`, { reason: 'late claim by other city' })).status, 404); // already claimed
  assert.equal((await s.officer.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'other city cannot verify' })).status, 404);
  const v = await officer2.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'Reviewed and confirmed by our staff' });
  assert.equal(v.json.status, 'assigned'); assert.equal(v.json.responsible_kind, 'municipality');
  const kinds = (await w.adminDb.query('SELECT kind FROM status_events WHERE issue_id=$1 ORDER BY id', [iss.id])).rows.map((x: any) => x.kind);
  assert.deepEqual(kinds, ['created', 'routing_suggested', 'review_claimed', 'verified_by_officer', 'routed']);
});

test('F2b auto_checks mode also leaves an unrouted report pending instead of a verified dead end', async () => {
  const w2 = await newWorld({ verificationMode: 'auto_checks' }); const s2 = await seed(w2);
  await w2.adminDb.query(`INSERT INTO orgs (kind,name) VALUES ('municipality','Another') RETURNING id`);
  const u = await s2.mk('ac-r');
  const iss = (await u.c.post('/v1/reports', reportBody(P_NOROAD))).json.issue;
  assert.equal(iss.status, 'reported');
  assert.equal((await w2.adminDb.query(`SELECT count(*)::int n FROM status_events WHERE issue_id=$1 AND kind='auto_verified'`, [iss.id])).rows[0].n, 0);
  await w2.close();
});

test('F3 severity increase on a merged duplicate shortens the deadline from assignment time, never extends it', async () => {
  const a = await s.mk('f3-a'); const b = await s.mk('f3-b');
  const iss = (await a.c.post('/v1/reports', at(76.7030))).json.issue;
  await s.officer.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'Checked, real hazard here' });
  const before = (await w.adminDb.query('SELECT severity, deadline_at FROM issues WHERE id=$1', [iss.id])).rows[0];
  assert.ok(before.severity < 4);
  const t0 = (await w.adminDb.query(`SELECT max(created_at) t FROM status_events WHERE issue_id=$1 AND to_status='assigned'`, [iss.id])).rows[0].t;
  assert.equal((await b.c.post('/v1/reports', at(76.70302, { danger: true }))).json.merged_into_existing, true);
  const after = (await w.adminDb.query('SELECT severity, deadline_at FROM issues WHERE id=$1', [iss.id])).rows[0];
  assert.ok(after.severity >= 4);
  assert.equal(Math.round((after.deadline_at - t0) / 3600000), 48);
  assert.ok(after.deadline_at <= before.deadline_at);
  // a later merge that does not raise severity leaves the deadline alone
  const c = await s.mk('f3-c');
  await c.c.post('/v1/reports', at(76.70304));
  assert.equal((await w.adminDb.query('SELECT deadline_at FROM issues WHERE id=$1', [iss.id])).rows[0].deadline_at.getTime(), after.deadline_at.getTime());
});

test('F4 override-route on an in_progress issue records the real transition', async () => {
  const a = await s.mk('f4-a');
  const iss = (await a.c.post('/v1/reports', at(76.7060))).json.issue;
  await s.officer.c.post(`/v1/issues/${iss.id}/verify`, { decision: 'verify', reason: 'Checked, real hazard here' });
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss.id}/start`)).status, 200);
  assert.equal((await s.officer.c.post(`/v1/issues/${iss.id}/override-route`, { org_id: s.muni, reason: 'Moving to municipal crew' })).status, 200);
  const st = (await w.adminDb.query('SELECT status FROM issues WHERE id=$1', [iss.id])).rows[0].status;
  const ev = (await w.adminDb.query(`SELECT from_status, to_status FROM status_events WHERE issue_id=$1 AND kind='route_override'`, [iss.id])).rows[0];
  assert.equal(ev.from_status, 'in_progress'); assert.equal(ev.to_status, st); assert.equal(st, 'assigned');
});

test('F2c triage is OFF by default: unrouted reports are not visible or claimable by any municipal staff', async () => {
  const w2 = await newWorld({ verificationMode: 'officer_review' }); const s2 = await seed(w2);
  const m2 = (await w2.adminDb.query(`INSERT INTO orgs (kind,name) VALUES ('municipality','Second City') RETURNING id`)).rows[0].id;
  const o2 = await s2.mk('o2'); await w2.adminDb.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'officer')`, [o2.id, m2]);
  const iss = (await (await s2.mk('off-r')).c.post('/v1/reports', reportBody(P_NOROAD))).json.issue;
  for (const o of [s2.officer, o2]) {
    assert.equal((await o.c.get(`/v1/issues/${iss.id}`)).status, 404);
    assert.equal((await o.c.post(`/v1/issues/${iss.id}/claim-review`, { reason: 'trying to claim while off' })).status, 404);
    assert.ok(!(await o.c.get('/v1/issues?status=reported')).json.issues.some((i: any) => i.id === iss.id));
  }
  assert.equal((await w2.app.inject({ method: 'GET', url: '/health' })).json().unrouted_triage, 'off');
  await w2.close();
});

test('F2d two cities racing to claim one unrouted report: exactly one wins', async () => {
  const iss = (await (await s.mk('race-r')).c.post('/v1/reports', reportBody({ lat: 30.9, lon: 76.9 }))).json.issue;
  const [x, y] = await Promise.all([
    s.officer.c.post(`/v1/issues/${iss.id}/claim-review`, { reason: 'Our boundary, claiming first' }),
    officer2.c.post(`/v1/issues/${iss.id}/claim-review`, { reason: 'Our boundary, claiming too' }),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 404]);
  assert.equal((await w.adminDb.query(`SELECT count(*)::int n FROM status_events WHERE issue_id=$1 AND kind='review_claimed'`, [iss.id])).rows[0].n, 1);
});
