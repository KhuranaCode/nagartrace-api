import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, mainAdmin, reportBody, jpeg, P_WARRANTY, P_NOROAD, type World } from './helpers.ts';

// Settled privacy policy (owner-directed, peer-reviewed scope):
//  - Photo bytes: ONLY the evidence's own uploader or the EXACT deployment-owner principal.
//    No reporter/staff/officer/contractor/utility/reviewer or admin-ROLE access. Unset config fails closed.
//  - Complaint-linked private fields (route reasons, org ids, events, evidence list, disputes,
//    precise-point official records, contractor scorecards): owner only.
//  - Everyone else with a legitimate view gets exactly the anonymous public payload.
//  - Public map/status and the standalone public NHAI historical catalog are unchanged.
//  - The owner override never crosses the test/real data-separation cohort.

let w: World; let s: Awaited<ReturnType<typeof seed>>;
before(async () => { w = await newWorld(); s = await seed(w); });
after(async () => { await w.close(); });

const PUBLIC_DETAIL_KEYS = ['complaint_id', 'complaint_no', 'created_at', 'deadline_at', 'hazard', 'hazards', 'id', 'location', 'reports_count', 'responsible', 'route_flags', 'severity', 'status', 'updated_at', 'ward'];

async function routedIssueWithPhoto(sub: string, lon: number) {
  const r = await s.mk(sub);
  const rep = await r.c.post('/v1/reports', reportBody({ lat: 30.70001234, lon }));
  assert.equal(rep.status, 201);
  const iss = rep.json.issue;
  const up = await r.c.upload(`/v1/issues/${iss.id}/evidence?kind=report&lat=30.70001234&lon=${lon}`, await jpeg());
  assert.equal(up.status, 201);
  return { r, iss, eid: up.json.evidence_id as string };
}

test('photos: own uploader and exact owner only - every role and merged reporter is refused', async () => {
  const { r, iss, eid } = await routedIssueWithPhoto('pv-u1', 76.7050);
  // merged co-reporter (a reporter of the issue, but NOT the uploader)
  const r2 = await s.mk('pv-u2');
  const rep2 = await r2.c.post('/v1/reports', reportBody({ lat: 30.70002234, lon: 76.7050 }));
  void 0;
  assert.equal(rep2.json.merged_into_existing, true);
  assert.equal(rep2.json.issue.id, iss.id);
  const stranger = await s.mk('pv-stranger');

  assert.equal((await r.c.get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 200); // own uploader
  assert.equal((await r2.c.get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 404); // merged reporter is not the uploader
  assert.equal((await stranger.c.get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 404);
  assert.equal((await s.officer.c.get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 404); // municipal officer
  assert.equal((await s.admin.c.get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 404);   // municipal ADMIN ROLE
  assert.equal((await s.contractor.c.get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 404); // assignee
  assert.equal((await (await mainAdmin(w)).get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 200); // exact owner
});

test('photos: reviewer of a pending issue is refused; owner reads', async () => {
  const w2 = await newWorld({ verificationMode: 'officer_review' }); // keeps the issue 'reported' with a reviewer
  try {
    const s2 = await seed(w2);
    const x = await s2.mk('pv-rv');
    const rep = await x.c.post('/v1/reports', reportBody(P_NOROAD)); // unroutable: stays 'reported', muni is reviewer
    assert.equal(rep.json.issue.status, 'reported');
    const iss = rep.json.issue;
    const up = await x.c.upload(`/v1/issues/${iss.id}/evidence?kind=report&lat=${P_NOROAD.lat}&lon=${P_NOROAD.lon}`, await jpeg());
    assert.equal(up.status, 201);
    const eid = up.json.evidence_id as string;
    const row = (await w2.adminDb.query('SELECT review_org_id FROM issues WHERE id=$1', [iss.id])).rows[0];
    assert.equal(row.review_org_id, s2.muni); // s2.officer really is the reviewer of this issue
    assert.equal((await s2.officer.c.get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 404); // reviewer: no photo grant
    assert.equal((await s2.contractor.c.get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 404);
    assert.equal((await x.c.get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 200);
    assert.equal((await (await mainAdmin(w2)).get(`/v1/issues/${iss.id}/evidence/${eid}`)).status, 200);
  } finally { await w2.close(); }
});

test('issue detail: reporter and staff get exactly the public payload; owner gets the full private view', async () => {
  const { r, iss } = await routedIssueWithPhoto('pv-d1', 76.7060);
  const pub = await w.app.inject({ method: 'GET', url: `/v1/public/issues/${iss.id}` });
  assert.equal(pub.statusCode, 200);

  for (const who of [r.c, s.officer.c, s.admin.c, s.contractor.c]) {
    const det = await who.get(`/v1/issues/${iss.id}`);
    assert.equal(det.status, 200);
    assert.deepEqual(Object.keys(det.json).sort(), [...PUBLIC_DETAIL_KEYS].sort());
    assert.deepEqual(det.json, pub.json()); // byte-identical to the anonymous public payload
    assert.equal(det.json.location.lat, 30.7); // rounded, never the precise 30.70001234
    assert.ok(!('route_reason' in det.json) && !('responsible_org_id' in det.json) && !('events' in det.json)
      && !('evidence' in det.json) && !('disputes' in det.json) && !('danger_flag' in det.json) && !('redaction' in det.json)
      && !('official_records' in det.json));
    assert.deepEqual(Object.keys(det.json.responsible).sort(), ['kind', 'synthetic_data']); // no contractor NAME
    assert.ok(!JSON.stringify(det.json).includes('Sharma Infra'));
  }

  const od = (await (await mainAdmin(w)).get(`/v1/issues/${iss.id}`)).json;
  assert.equal(od.location.lat, 30.70001234); // precise
  assert.ok('responsible_org_id' in od && 'route_reason' in od && 'redaction' in od && 'deadline_at' in od && 'route_flags' in od);
  assert.equal(od.responsible.name, 'Sharma Infra'); // owner restores the private association fields
  assert.ok(Array.isArray(od.events) && od.events.length > 0);
  assert.ok(Array.isArray(od.evidence) && od.evidence.length === 1);
  assert.ok(od.official_records && 'responsible_contractor' in od.official_records);
});

test('issue list: non-admin entries are minimal; owner lists the whole cohort in full DTO, never the other cohort', async () => {
  const { iss } = await routedIssueWithPhoto('pv-l1', 76.7070);
  const mine = (await s.contractor.c.get('/v1/issues')).json.issues.find((x: any) => x.id === iss.id);
  assert.ok(mine);
  assert.ok(!('route_reason' in mine) && !('responsible_org_id' in mine) && !('danger_flag' in mine));
  assert.equal(mine.location.lat, 30.7);

  const mad = await mainAdmin(w);
  const ownerEntry = (await mad.get('/v1/issues?limit=200')).json.issues.find((x: any) => x.id === iss.id);
  assert.ok(ownerEntry, 'owner must see issues they did not report and do not staff');
  assert.ok('responsible_org_id' in ownerEntry && 'route_reason' in ownerEntry);
  assert.equal(ownerEntry.location.lat, 30.70001234);

  // cohort guard: flag the issue synthetic -> the real-cohort owner no longer lists or reads it
  await w.adminDb.query('UPDATE issues SET is_test=true WHERE id=$1', [iss.id]);
  assert.ok(!(await mad.get('/v1/issues?limit=200')).json.issues.some((x: any) => x.id === iss.id));
  assert.equal((await mad.get(`/v1/issues/${iss.id}`)).status, 404);
  assert.equal((await mad.get(`/v1/issues/${iss.id}/evidence/${(await w.adminDb.query('SELECT id FROM evidence WHERE issue_id=$1', [iss.id])).rows[0].id}`)).status, 404);
  await w.adminDb.query('UPDATE issues SET is_test=false WHERE id=$1', [iss.id]);
});

test('report response is minimised: a merged reporter receives no complaint-linked private fields', async () => {
  const a = await s.mk('pv-m1'); const b = await s.mk('pv-m2');
  const r1 = await a.c.post('/v1/reports', reportBody({ lat: 30.7001, lon: 76.7090 }));
  assert.equal(r1.status, 201);
  for (const k of ['route_reason', 'responsible_org_id', 'copy_org_id', 'review_org_id', 'route_overridden', 'danger_flag']) {
    assert.ok(!(k in r1.json.issue), `fresh report response leaked ${k}`);
  }
  assert.equal(r1.json.issue.test_data, false); // honesty label retained
  const r2 = await b.c.post('/v1/reports', reportBody({ lat: 30.70011, lon: 76.7090 }));
  assert.equal(r2.json.merged_into_existing, true);
  for (const k of ['route_reason', 'responsible_org_id', 'copy_org_id', 'review_org_id', 'route_overridden', 'danger_flag']) {
    assert.ok(!(k in r2.json.issue), `merged report response leaked ${k}`);
  }
  assert.ok(!JSON.stringify(r2.json).includes('Sharma Infra'), 'merged response leaked the contractor name');
  assert.equal(r2.json.issue.id, r1.json.issue.id);
});

test('scorecards: complaint-linked contractor performance is owner-only', async () => {
  const u = await s.mk('pv-s1');
  assert.equal((await u.c.get('/v1/admin/scorecards')).status, 403);
  assert.equal((await s.officer.c.get('/v1/admin/scorecards')).status, 403);
  assert.equal((await s.admin.c.get('/v1/admin/scorecards')).status, 403);
  assert.equal((await (await mainAdmin(w)).get('/v1/admin/scorecards')).status, 200);
});

test('public surface unchanged: map/status, rounded-point records, standalone NHAI catalog', async () => {
  const { iss } = await routedIssueWithPhoto('pv-p1', 76.7080);
  const pub = await w.app.inject({ method: 'GET', url: `/v1/public/issues/${iss.id}` });
  assert.equal(pub.statusCode, 200);
  assert.deepEqual(Object.keys(pub.json()).sort(), [...PUBLIC_DETAIL_KEYS].sort());
  assert.ok(!('official_records' in pub.json())); // complaint-linked candidate associations are owner-only, even publicly
  // the STANDALONE historical catalog stays public (settled exception)
  const cat = await w.app.inject({ method: 'GET', url: '/v1/public/gov-records/nhai-awards?limit=5' });
  assert.equal(cat.statusCode, 200);
  assert.ok(Array.isArray(cat.json().awards));
  assert.equal((await w.app.inject({ method: 'GET', url: '/v1/public/issues?limit=5' })).statusCode, 200);
  // PUBLIC_SCORECARDS must not bypass the restriction: default off -> 404 (flag itself not freshly verified, untouched)
  assert.equal((await w.app.inject({ method: 'GET', url: '/v1/public/scorecards' })).statusCode, 404);
});

test('fail-closed: with MAIN_ADMIN_SUBJECT unset the owner principal has no special access anywhere', async () => {
  const w2 = await newWorld({ mainAdminSubject: undefined });
  try {
    const s2 = await seed(w2);
    const r = await s2.mk('fc-r');
    const rep = await r.c.post('/v1/reports', reportBody({ lat: 30.70001234, lon: 76.7110 }));
    const iss = rep.json.issue;
    const up = await r.c.upload(`/v1/issues/${iss.id}/evidence?kind=report&lat=30.70001234&lon=76.7110`, await jpeg());
    const wouldBeOwner = await mainAdmin(w2); // same subject, but config unset
    assert.equal((await wouldBeOwner.get(`/v1/issues/${iss.id}/evidence/${up.json.evidence_id}`)).status, 404);
    assert.equal((await wouldBeOwner.get('/v1/admin/scorecards')).status, 403);
    const det = await wouldBeOwner.get(`/v1/issues/${iss.id}`);
    assert.equal(det.status, 404); // not reporter/staff and no owner override -> invisible
    assert.ok(!(await wouldBeOwner.get('/v1/issues?limit=200')).json.issues.some((x: any) => x.id === iss.id));
    // ordinary access still works in the fail-closed world
    assert.equal((await r.c.get(`/v1/issues/${iss.id}/evidence/${up.json.evidence_id}`)).status, 200);
    assert.equal((await r.c.get(`/v1/issues/${iss.id}`)).status, 200);
  } finally { await w2.close(); }
});

test('PUBLIC_SCORECARDS=true does not bypass the restriction: owner-preview only', async () => {
  const w3 = await newWorld({ publicScorecards: true });
  try {
    const s3 = await seed(w3);
    const u = await s3.mk('ps-u');
    assert.equal((await w3.app.inject({ method: 'GET', url: '/v1/public/scorecards' })).statusCode, 404); // anonymous
    assert.equal((await u.c.get('/v1/public/scorecards')).status, 404); // authenticated non-owner
    assert.equal((await s3.admin.c.get('/v1/public/scorecards')).status, 404); // municipal admin ROLE
    assert.equal((await (await mainAdmin(w3)).get('/v1/public/scorecards')).status, 200); // exact owner
  } finally { await w3.close(); }
});

test('recursive identity scan: no complaint-linked org name/id anywhere in non-owner surfaces', async () => {
  const lon = 76.7095;
  const a = await s.mk('pv-scan1'); const b = await s.mk('pv-scan2');
  const key = 'scan-' + Date.now();
  const fresh = await a.c.post('/v1/reports', reportBody({ lat: 30.70001234, lon }, {}, ), { 'idempotency-key': key });
  assert.equal(fresh.status, 201);
  const iss = fresh.json.issue;
  const merged = await b.c.post('/v1/reports', reportBody({ lat: 30.70002234, lon }));
  assert.equal(merged.json.merged_into_existing, true);
  const replay = await a.c.post('/v1/reports', reportBody({ lat: 30.70001234, lon }), { 'idempotency-key': key });
  assert.equal(replay.json.replayed, true);

  const surfaces: [string, unknown][] = [
    ['fresh report response', fresh.json], ['merged report response', merged.json], ['replay response', replay.json],
    ['public detail', (await w.app.inject({ method: 'GET', url: `/v1/public/issues/${iss.id}` })).json()],
    ['public list', (await w.app.inject({ method: 'GET', url: '/v1/public/issues?limit=200' })).json()],
    ['reporter detail', (await a.c.get(`/v1/issues/${iss.id}`)).json],
    ['merged-reporter detail', (await b.c.get(`/v1/issues/${iss.id}`)).json],
    ['officer detail', (await s.officer.c.get(`/v1/issues/${iss.id}`)).json],
    ['municipal-admin-role detail', (await s.admin.c.get(`/v1/issues/${iss.id}`)).json],
    ['contractor detail', (await s.contractor.c.get(`/v1/issues/${iss.id}`)).json],
    ['contractor list', (await s.contractor.c.get('/v1/issues?limit=200')).json],
    ['reporter list', (await a.c.get('/v1/issues?limit=200')).json],
  ];
  const forbidden = ['Sharma Infra', 'Test Telecom', 'Test Municipality', s.contractorOrg, s.utilityOrg, s.muni];
  for (const [label, payload] of surfaces) {
    const text = JSON.stringify(payload);
    for (const f of forbidden) assert.ok(!text.includes(f), `${label} leaked ${f}`);
  }
  // positive control: the exact owner still sees the private association on this same issue
  const od = (await (await mainAdmin(w)).get(`/v1/issues/${iss.id}`)).json;
  assert.ok(JSON.stringify(od).includes('Sharma Infra'));
  assert.ok(JSON.stringify(od).includes(s.contractorOrg));
});
