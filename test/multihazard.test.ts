/** Multiple hazards per report (migration 013 + API): full set on issues/reports, primary stays
 *  `hazard`, duplicate matching merges on ANY shared hazard, merges union the set. Real PG. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, sign, client, reportBody, P_NOROAD, type World } from './helpers.ts';

let w: World;
const uniq = () => Math.random().toString(36).slice(2, 10);
before(async () => { w = await newWorld(); });
after(() => w.close());

const mk = () => sign('u-' + uniq()).then((t) => client(w, t));

test('report with a hazard set: issue carries the full distinct set, primary first', async () => {
  const c = await mk();
  const r = await c.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.03, lon: P_NOROAD.lon + 0.03 }, { hazard: 'pothole', hazards: ['pothole', 'waterlogging', 'crack', 'crack'] }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const d = (await c.get('/v1/issues/' + r.json.issue.id)).json;
  assert.deepEqual(d.hazards, ['pothole', 'waterlogging', 'crack']);
  assert.equal(d.hazard, 'pothole'); // primary unchanged
  const rep = await w.adminDb.query(`SELECT hazards FROM reports WHERE issue_id=$1`, [r.json.issue.id]);
  assert.equal(rep.rows[0].hazards, '{pothole,waterlogging,crack}');
});

test('hazards must include the primary hazard', async () => {
  const c = await mk();
  const r = await c.post('/v1/reports', reportBody({ lat: P_NOROAD.lat - 0.03, lon: P_NOROAD.lon - 0.03 }, { hazard: 'pothole', hazards: ['crack'] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'hazard_set_invalid');
});

test('duplicate matching merges on ANY shared hazard and unions the set', async () => {
  const c1 = await mk(); const c2 = await mk();
  const la = P_NOROAD.lat + 0.05, lo = P_NOROAD.lon + 0.05;
  const r1 = await c1.post('/v1/reports', reportBody({ lat: la, lon: lo }, { hazard: 'pothole', hazards: ['pothole', 'crack'] }));
  assert.equal(r1.status, 201, JSON.stringify(r1.json));
  const issueId = r1.json.issue.id;
  // Different primary, but shares 'crack' within the duplicate radius: merges.
  const r2 = await c2.post('/v1/reports', reportBody({ lat: la, lon: lo }, { hazard: 'waterlogging', hazards: ['waterlogging', 'crack'] }));
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  assert.equal(r2.json.issue.id, issueId);
  const d = (await c1.get('/v1/issues/' + issueId)).json;
  assert.deepEqual(d.hazards, ['pothole', 'crack', 'waterlogging']);
  assert.equal(d.hazard, 'pothole'); // primary of the existing issue never changes
});

test('no shared hazard nearby: separate issues', async () => {
  const c1 = await mk(); const c2 = await mk();
  const la = P_NOROAD.lat - 0.05, lo = P_NOROAD.lon - 0.05;
  const r1 = await c1.post('/v1/reports', reportBody({ lat: la, lon: lo }, { hazard: 'pothole' }));
  const r2 = await c2.post('/v1/reports', reportBody({ lat: la, lon: lo }, { hazard: 'missing_cover' }));
  assert.notEqual(r1.json.issue.id, r2.json.issue.id);
});

test('idempotent replay compares the full hazard set', async () => {
  const c = await mk();
  const key = 'mh-' + uniq();
  const body = reportBody({ lat: P_NOROAD.lat + 0.07, lon: P_NOROAD.lon + 0.07 }, { hazard: 'crack', hazards: ['crack', 'broken_edge'] });
  const r1 = await c.post('/v1/reports', body, { 'idempotency-key': key });
  assert.equal(r1.status, 201, JSON.stringify(r1.json));
  const r2 = await c.post('/v1/reports', body, { 'idempotency-key': key });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.replayed, true);
  const changed = await c.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.07, lon: P_NOROAD.lon + 0.07 }, { hazard: 'crack', hazards: ['crack'] }), { 'idempotency-key': key });
  assert.equal(changed.status, 409);
  // Reordered-but-identical set = same report = true replay, not a mismatch.
  const reordered = await c.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.07, lon: P_NOROAD.lon + 0.07 }, { hazard: 'crack', hazards: ['broken_edge', 'crack'] }), { 'idempotency-key': key });
  assert.equal(reordered.status, 200);
  assert.equal(reordered.json.replayed, true);
});
