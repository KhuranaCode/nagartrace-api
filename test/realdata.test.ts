import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, reportBody, P_WARRANTY, P_NOROAD, type World } from './helpers.ts';

let w: World; let s: Awaited<ReturnType<typeof seed>>;
before(async () => { w = await newWorld(); s = await seed(w);
  // seed() builds a genuine-style world; turn it into the fixture world (synthetic municipality, roads, contractor) the live DB has today
  await w.adminDb.query('UPDATE orgs SET is_synthetic=true; UPDATE road_segments SET is_synthetic=true; UPDATE contracts SET is_synthetic=true; UPDATE utility_cuts SET is_synthetic=true');
});
after(async () => { await w.close(); });

const genuine = (sub: string) => s.mk(sub);
const fixture = async (sub: string) => { const u = await s.mk(sub); await w.adminDb.query('UPDATE users SET is_test=true WHERE id=$1', [u.id]); return u; };

test('genuine report is never routed to the synthetic municipality or matched to synthetic roads', async () => {
  const g = await genuine('real-1');
  const r = await g.c.post('/v1/reports', reportBody(P_WARRANTY)); // synthetic road + synthetic warranty contractor sit exactly here
  assert.equal(r.status, 201);
  const i = r.json.issue;
  assert.equal(i.test_data, false); assert.equal(i.status, 'reported');
  assert.equal(i.responsible, null); assert.equal(i.review_org_id, undefined); // report response carries the minimal public DTO (owner-only private fields)
  const row = (await w.adminDb.query('SELECT road_id, review_org_id, suggested_org_id, suggested_flags, suggested_reason, is_test FROM issues WHERE id=$1', [i.id])).rows[0];
  assert.equal(row.road_id, null); assert.equal(row.review_org_id, null); assert.equal(row.suggested_org_id, null); assert.equal(row.is_test, false);
  assert.ok(row.suggested_flags.includes('needs_manual_routing')); assert.match(row.suggested_reason, /No real authority/);
  // synthetic staff cannot see it
  assert.equal((await s.admin.c.get(`/v1/issues/${i.id}`)).status, 404);
  assert.ok(!(await s.officer.c.get('/v1/issues')).json.issues.some((x: any) => x.id === i.id));
  // reporter sees it
  assert.equal((await g.c.get(`/v1/issues/${i.id}`)).status, 200);
});

test('public map shows genuine only; fixture issues are hidden, detail is 404, nothing deleted', async () => {
  const t = await fixture('fixture-1');
  const tr = await t.c.post('/v1/reports', reportBody(P_WARRANTY));
  assert.equal(tr.json.issue.test_data, true);
  assert.equal(tr.json.issue.responsible.synthetic_data, true);
  const g = await genuine('real-2');
  const gr = await g.c.post('/v1/reports', reportBody(P_NOROAD));
  const pub = (await g.c.get('/v1/public/issues')).json.issues;
  assert.ok(pub.some((x: any) => x.id === gr.json.issue.id));
  assert.ok(pub.every((x: any) => !('test_data' in x)));
  assert.ok(!pub.some((x: any) => x.id === tr.json.issue.id));
  assert.equal((await g.c.get(`/v1/public/issues/${tr.json.issue.id}`)).status, 404);
  assert.equal((await g.c.get(`/v1/public/issues/${gr.json.issue.id}`)).status, 200);
  // fixture world still works for its own users
  assert.equal((await t.c.get(`/v1/issues/${tr.json.issue.id}`)).status, 200);
  const n = (await w.adminDb.query('SELECT count(*)::int n FROM issues')).rows[0].n; assert.ok(n >= 3);
});

test('genuine report does not merge into a fixture issue at the same spot', async () => {
  const t = await fixture('fixture-2'); const g = await genuine('real-3');
  const a = await t.c.post('/v1/reports', reportBody(P_NOROAD, { hazard: 'crack' }));
  const b = await g.c.post('/v1/reports', reportBody(P_NOROAD, { hazard: 'crack' }));
  assert.equal(b.status, 201); assert.equal(b.json.merged_into_existing, false);
  assert.notEqual(a.json.issue.id, b.json.issue.id);
  const c2 = await genuine('real-4');
  const c = await c2.c.post('/v1/reports', reportBody(P_NOROAD, { hazard: 'crack' }));
  assert.equal(c.json.merged_into_existing, true); assert.equal(c.json.issue.id, b.json.issue.id);
});

test('leaderboard and scorecards keep the two worlds apart', async () => {
  const g = await genuine('real-5'); const t = await fixture('fixture-3');
  await w.adminDb.query(`INSERT INTO points_ledger (user_id, delta, reason) VALUES ($1, 10, 'x'), ($2, 99, 'x')`, [g.id, t.id]).catch(async () => {
    await w.adminDb.query(`INSERT INTO points_ledger (user_id, delta, reason, issue_id) SELECT $1, 10, 'x', id FROM issues LIMIT 1`, [g.id]);
  });
  const gb = (await g.c.get('/v1/leaderboard')).json.leaderboard; const tb = (await t.c.get('/v1/leaderboard')).json.leaderboard;
  assert.ok(!gb.some((x: any) => x.points === 99));
  assert.ok(!tb.some((x: any) => x.alias === (/** genuine alias */ '__none__')));
});

test('a real authority, once configured, receives genuine reports for review (suggestion only)', async () => {
  const real = (await w.adminDb.query(`INSERT INTO orgs (kind,name,is_synthetic) VALUES ('municipality','Real Test Authority',false) RETURNING id`)).rows[0].id;
  const g = await genuine('real-6');
  const r = await g.c.post('/v1/reports', reportBody({ lat: 31.5, lon: 77.5 }));
  assert.equal(r.status, 201);
  const row = (await w.adminDb.query('SELECT review_org_id, suggested_flags FROM issues WHERE id=$1', [r.json.issue.id])).rows[0];
  assert.equal(row.review_org_id, real); const fl = (await w.adminDb.query('SELECT route_flags, suggested_flags FROM issues WHERE id=$1', [r.json.issue.id])).rows[0]; assert.ok([...fl.route_flags, ...fl.suggested_flags].includes('road_not_in_registry'));
});
