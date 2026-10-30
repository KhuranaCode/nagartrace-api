import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, mainAdmin, MAIN_ADMIN_SUB, reportBody, P_WARRANTY, P_NOROAD, type World } from './helpers.ts';

let w: World; let s: Awaited<ReturnType<typeof seed>>; let realMuni: string; let realOfficer: any;
before(async () => {
  w = await newWorld({ unroutedTriage: 'any_municipal_staff', publicScorecards: true }); s = await seed(w);
  // fixture world: the seeded municipality, roads and contractor are synthetic
  await w.adminDb.query('UPDATE orgs SET is_synthetic=true; UPDATE road_segments SET is_synthetic=true; UPDATE contracts SET is_synthetic=true; UPDATE utility_cuts SET is_synthetic=true');
});
after(async () => { await w.close(); });
const genuine = (sub: string) => s.mk(sub);
const fixture = async (sub: string) => { const u = await s.mk(sub); await w.adminDb.query('UPDATE users SET is_test=true WHERE id=$1', [u.id]); return u; };
const claim = (u: any, id: string, org?: string) => u.c.post(`/v1/issues/${id}/claim-review`, { reason: 'cohort test claim reason', ...(org ? { org_id: org } : {}) });

test('triage ON: synthetic staff cannot list, read or claim a GENUINE unrouted report', async () => {
  const g = await genuine('tri-real-1');
  const r = await g.c.post('/v1/reports', reportBody(P_NOROAD)); assert.equal(r.status, 201);
  const id = r.json.issue.id;
  assert.equal((await s.officer.c.get(`/v1/issues/${id}`)).status, 404);
  assert.ok(!(await s.officer.c.get('/v1/issues')).json.issues.some((x: any) => x.id === id));
  assert.ok(!(await s.admin.c.get('/v1/issues')).json.issues.some((x: any) => x.id === id));
  assert.equal((await claim(s.officer, id)).status, 404);
  assert.equal((await claim(s.admin, id, s.muni)).status, 404);
  const row = (await w.adminDb.query('SELECT review_org_id, is_test FROM issues WHERE id=$1', [id])).rows[0];
  assert.equal(row.review_org_id, null); assert.equal(row.is_test, false);
  // a REAL municipality appears later (no roads registered): its officer CAN triage the still-unrouted genuine report
  realMuni = (await w.adminDb.query(`INSERT INTO orgs (kind,name,is_synthetic) VALUES ('municipality','Real Test Authority',false) RETURNING id`)).rows[0].id;
  realOfficer = await s.mk('real-officer');
  await w.adminDb.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'officer')`, [realOfficer.id, realMuni]);
  const seen = (await realOfficer.c.get('/v1/issues')).json.issues.find((x: any) => x.id === id);
  assert.ok(seen && seen.triage_only === true);
  assert.equal((await claim(realOfficer, id)).status, 200);
});

test('triage ON: real staff cannot see or claim a FIXTURE unrouted report; fixture staff can', async () => {
  const f = await fixture('tri-fix-1');
  const r = await f.c.post('/v1/reports', reportBody(P_NOROAD)); assert.equal(r.status, 201);
  const id = r.json.issue.id;
  assert.equal((await w.adminDb.query('SELECT is_test FROM issues WHERE id=$1', [id])).rows[0].is_test, true);
  // force the unrouted-triage state for this fixture issue (fixture routing normally files it for the synthetic municipality)
  await w.adminDb.query("UPDATE issues SET status='reported', review_org_id=NULL, responsible_org_id=NULL, responsible_kind=NULL WHERE id=$1", [id]);
  assert.equal((await realOfficer.c.get(`/v1/issues/${id}`)).status, 404);
  assert.ok(!(await realOfficer.c.get('/v1/issues')).json.issues.some((x: any) => x.id === id));
  assert.equal((await claim(realOfficer, id)).status, 404);
  assert.ok((await s.officer.c.get('/v1/issues')).json.issues.some((x: any) => x.id === id));
  { const cr = await claim(s.officer, id); assert.equal(cr.status, 200, JSON.stringify(cr.json)); }
});

test('public and admin scorecards are separated by cohort; public never counts fixtures', async () => {
  const g = await genuine('sc-real'); const f1 = await fixture('sc-fix-1'); const f2 = await fixture('sc-fix-2');
  const a = (await g.c.post('/v1/reports', reportBody(P_WARRANTY))).json.issue.id;
  const b = (await f1.c.post('/v1/reports', reportBody(P_WARRANTY))).json.issue.id;
  const c = (await f2.c.post('/v1/reports', reportBody(P_NOROAD))).json.issue.id;
  await w.adminDb.query(`UPDATE issues SET responsible_org_id=$2, responsible_kind='contractor' WHERE id = ANY($1::uuid[])`, [[a, b, c], s.contractorOrg]);
  // settled policy: even with PUBLIC_SCORECARDS=true the public route is owner-only (complaint-derived
  // contractor targeting); non-owners get the same 404 as a disabled flag
  assert.equal((await g.c.get('/v1/public/scorecards')).status, 404);
  const pubOwner = (await (await mainAdmin(w)).get('/v1/public/scorecards')).json.scorecards;
  assert.equal(pubOwner.find((x: any) => x.org_id === s.contractorOrg)?.issues, 1); // real-cohort board only, never fixtures
  // settled privacy policy: complaint-linked contractor performance is owner-only. Municipal admin
  // ROLE (genuine or fixture) gets 403; the exact owner principal sees their own cohort's board.
  const fa = await fixture('sc-fix-admin'); await w.adminDb.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'admin')`, [fa.id, s.muni]);
  assert.equal((await fa.c.get('/v1/admin/scorecards')).status, 403);
  assert.equal((await s.admin.c.get('/v1/admin/scorecards')).status, 403);
  const mad = await mainAdmin(w);
  const realBoard = (await mad.get('/v1/admin/scorecards')).json.scorecards;
  assert.equal(realBoard.find((x: any) => x.org_id === s.contractorOrg)?.issues, 1);
  await w.adminDb.query(`UPDATE users SET is_test=true WHERE subject=$1`, [MAIN_ADMIN_SUB]);
  const fixBoard = (await mad.get('/v1/admin/scorecards')).json.scorecards;
  assert.equal(fixBoard.find((x: any) => x.org_id === s.contractorOrg)?.issues, 2);
});

test('leaderboard is separated by the caller cohort with no overlap', async () => {
  const g = await genuine('lb-real'); const f = await fixture('lb-fix');
  await g.c.post('/v1/reports', reportBody({ ...P_WARRANTY, lat: P_WARRANTY.lat + 0.01 } as any));
  await f.c.post('/v1/reports', reportBody({ ...P_WARRANTY, lat: P_WARRANTY.lat + 0.02 } as any));
  const gl = (await g.c.get('/v1/leaderboard')).json.leaderboard; const fl = (await f.c.get('/v1/leaderboard')).json.leaderboard;
  assert.ok(gl.length > 0 && fl.length > 0);
  const ga = new Set(gl.map((x: any) => x.alias)); assert.ok(fl.every((x: any) => !ga.has(x.alias)));
  assert.ok(gl.every((x: any) => Object.keys(x).sort().join() === 'alias,points,ward'));
});
