import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, reportBody, P_WARRANTY, P_EXPIRED, type World } from './helpers.ts';

let w: World; let s: Awaited<ReturnType<typeof seed>>;
before(async () => { w = await newWorld(); s = await seed(w); });
after(async () => { await w.close(); });

test('contractor accept: assignee only, idempotent, state-checked; responsible-party filter', async () => {
  const a = await s.mk('f-a'); const b = await s.mk('f-b');
  const r1 = await a.c.post('/v1/reports', reportBody(P_WARRANTY));
  const id = r1.json.issue.id;
  assert.equal((await b.c.post(`/v1/issues/${id}/accept`)).status, 404); // other citizen
  assert.equal((await a.c.post(`/v1/issues/${id}/accept`)).status, 404); // reporter is not the assignee
  const x = await s.contractor.c.post(`/v1/issues/${id}/accept`); assert.equal(x.status, 200); assert.equal(x.json.already, false);
  const y = await s.contractor.c.post(`/v1/issues/${id}/accept`); assert.equal(y.json.already, true);
  const evs = (await w.adminDb.query(`SELECT count(*)::int AS n FROM status_events WHERE issue_id=$1 AND kind='accepted'`, [id])).rows[0].n; assert.equal(evs, 1);
  await s.contractor.c.post(`/v1/issues/${id}/start`);
  assert.equal((await s.contractor.c.post(`/v1/issues/${id}/accept`)).status, 409);
  const c = await s.mk('f-c'); const r2 = await c.c.post('/v1/reports', reportBody(P_EXPIRED));
  const pubC = (await a.c.get('/v1/public/issues?responsible=contractor')).json.issues;
  assert.ok(pubC.length >= 1 && pubC.every((i: any) => i.responsible.kind === 'contractor'));
  const pubM = (await a.c.get('/v1/public/issues?responsible=municipality')).json.issues;
  assert.ok(pubM.some((i: any) => i.id === r2.json.issue.id) && pubM.every((i: any) => i.responsible.kind === 'municipality'));
  assert.equal((await a.c.get('/v1/public/issues?responsible=bogus')).status, 400);
  const mine = (await s.contractor.c.get('/v1/issues?responsible=contractor')).json.issues; assert.ok(mine.every((i: any) => i.responsible.kind === 'contractor'));
});

test('badges are derived from real counts, not claimable', async () => {
  const u = await s.mk('badge-u');
  assert.deepEqual((await u.c.get('/v1/me/badges')).json.badges.map((b: any) => b.earned), [false, false, false, false]);
  await u.c.post('/v1/reports', reportBody(P_WARRANTY));
  const b = (await u.c.get('/v1/me/badges')).json;
  assert.equal(b.badges[0].earned, true); assert.equal(b.badges[1].earned, false);
  assert.equal(b.badges[3].earned, false); // no ward set
  await u.c.patch('/v1/me', { ward: 'W1' });
  const t = (await u.c.get('/v1/me/badges')).json; assert.equal(typeof t.badges[3].earned, 'boolean');
  assert.equal((await u.c.post('/v1/me/badges', { badge: 'Road Guardian' })).status, 404);
  assert.equal((await fetchNoAuth()).status, 401);
});
async function fetchNoAuth() { const r = await w.app.inject({ method: 'GET', url: '/v1/me/badges' }); return { status: r.statusCode }; }

test('CORS: only listed origins; preflight denied otherwise; no wildcard', async () => {
  const w2 = await newWorld({ corsOrigins: ['https://app.example.test'] } as any);
  try {
    const ok = await w2.app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: 'https://app.example.test', 'access-control-request-method': 'GET' } });
    assert.equal(ok.statusCode, 204); assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example.test');
    const bad = await w2.app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: 'https://evil.test' } });
    assert.equal(bad.statusCode, 403); assert.equal(bad.headers['access-control-allow-origin'], undefined);
    const get = await w2.app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.test' } });
    assert.equal(get.headers['access-control-allow-origin'], undefined);
  } finally { await w2.close(); }
});
