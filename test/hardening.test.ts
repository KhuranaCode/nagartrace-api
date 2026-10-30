import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, client, mainAdmin, reportBody, jpeg, userToken, P_WARRANTY, type World } from './helpers.ts';
import { fromEnv, POLICY_KEYS } from '../src/config.ts';
import { buildApp, csvRows } from '../src/app.ts';
import { defaults } from '../src/config.ts';

let w: World; let s: Awaited<ReturnType<typeof seed>>;
before(async () => { w = await newWorld({ dailyReportCap: 10 }); s = await seed(w); });
after(async () => { await w.close(); });
const cit = (n: string) => s.mk(n);
const rep = (u: any, p: any, extra: any = {}) => u.c.post('/v1/reports', reportBody(p, extra));

test('provisional policy cannot reach production silently', async () => {
  const base = { AUTH_ISSUER: 'i', AUTH_AUDIENCE: 'a', AUTH_JWKS_URL: 'https://x/jwks', DATABASE_URL: 'postgres://x' };
  assert.throws(() => fromEnv(base), /POLICY_/);
  const full: Record<string, string> = { ...base };
  for (const k of Object.keys(POLICY_KEYS)) full[k] = '5';
  assert.throws(() => fromEnv(full), /POLICY_VERIFICATION_MODE/); // who verifies reports must be chosen explicitly
  full.POLICY_VERIFICATION_MODE = 'officer_review';
  assert.throws(() => fromEnv(full), /RESIDENCY_ACK/);
  full.POLICY_SPOOF_RESIDENCY_ACK = 'confirmations-are-not-resident-verification';
  assert.equal(fromEnv(full).policySource, 'explicit');
  assert.throws(() => fromEnv({ ...full, POLICY_DAILY_POINTS_CAP: '-1' }), /non-negative/);
  const prev = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try { await assert.rejects(buildApp({ cfg: { ...defaults(), authIssuer: 'i', authAudience: 'a', databaseUrl: 'x' } as any, db: w.runtime, keys: new Uint8Array(1), store: null as any }), /provisional/); }
  finally { process.env.NODE_ENV = prev; }
  const h = (await w.app.inject({ method: 'GET', url: '/health' })).json();
  assert.match(h.policy, /PROVISIONAL/);
});

test('CSV registry import: valid file, strict header, quoting, row errors, authorization', async () => {
  const body = (o: any) => ({ municipality_org_id: s.muni, source_label: 'CSV test registry', is_synthetic: true, roads_csv: '', ...o });
  const ok = await s.admin.c.post('/v1/admin/registry/import-csv', body({
    roads_csv: 'code,name,ward,coordinates\nCSV-1,"Main, Road ""A""",W9,76.80 30.70;76.81 30.70\n',
    contracts_csv: 'road_code,contractor_name,completion_date,warranty_end\nCSV-1,CSV Builders,2025-01-01,2099-01-01\n',
    utility_cuts_csv: 'road_code,utility_name,cut_date\nCSV-1,CSV Water,2000-01-01\n' }));
  assert.equal(ok.status, 201); assert.deepEqual(ok.json, { roads: 1, contracts: 1, utility_cuts: 1 });
  assert.equal((await w.adminDb.query(`SELECT name FROM road_segments WHERE code='CSV-1'`)).rows[0].name, 'Main, Road "A"');
  const bad = (o: any) => s.admin.c.post('/v1/admin/registry/import-csv', body(o));
  assert.equal((await bad({ roads_csv: 'code,name\nX,y\n' })).status, 400);
  assert.equal((await bad({ roads_csv: 'code,name,ward,coordinates\nX,y,w\n' })).status, 400);
  assert.equal((await bad({ roads_csv: 'code,name,ward,coordinates\nX,y,w,"76.8 30.7;76.9\n' })).status, 400);
  assert.equal((await bad({ roads_csv: 'code,name,ward,coordinates\nX,y,w,abc def;1 2\n' })).status, 400);
  assert.equal((await bad({ roads_csv: '' })).status, 400);
  assert.equal((await w.adminDb.query(`SELECT count(*)::int n FROM road_segments WHERE code='X'`)).rows[0].n, 0);
  assert.equal((await s.officer.c.post('/v1/admin/registry/import-csv', body({ roads_csv: 'code,name,ward,coordinates\nQ,q,w,1 2;3 4\n' }))).status, 403);
  assert.deepEqual(csvRows('a,b\r\n1,2\r\n\r\n3,4', ['a', 'b']), [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
});

test('restricted DB role cannot rewrite history, evidence, identity or memberships', async () => {
  const u = await cit('db-u'); const iss = (await rep(u, { lat: 30.7000, lon: 76.7001 })).json.issue;
  await u.c.upload(`/v1/issues/${iss.id}/evidence?kind=report&lat=30.7&lon=76.7001`, await jpeg());
  await s.admin.c.post('/v1/admin/jobs/escalate');
  const denied = [
    `UPDATE status_events SET reason='x'`, `DELETE FROM status_events`, `UPDATE points_ledger SET delta=999`, `DELETE FROM points_ledger`,
    `UPDATE escalation_events SET level=2`, `DELETE FROM escalation_events`, `UPDATE registry_imports SET rows_ok=1`, `DELETE FROM registry_imports`,
    `UPDATE evidence SET kind='after'`, `UPDATE evidence SET location_ok=true`, `UPDATE reports SET user_id=user_id`, `UPDATE memberships SET role='admin'`, `DELETE FROM memberships`,
    `UPDATE users SET subject='hijack'`, `UPDATE users SET issuer='https://evil/'`, `UPDATE users SET suspended=false`, `TRUNCATE status_events`, `TRUNCATE users CASCADE`,
    `DROP TABLE status_events`, `ALTER TABLE issues ADD COLUMN x int`, `CREATE ROLE evil`, `DELETE FROM road_segments`, `DELETE FROM contracts`,
  ];
  for (const q of denied) await assert.rejects(w.runtime.query(q), (e: Error) => { void q; return !!e; });
  // triggers also block the owner role
  await assert.rejects(w.adminDb.query(`UPDATE status_events SET reason='x'`), /append-only/);
  await assert.rejects(w.adminDb.query(`DELETE FROM points_ledger`), /append-only/);
  // what the app legitimately does still works
  await w.runtime.query(`UPDATE users SET alias='ok-alias' WHERE id=$1`, [u.id]);
});

test('public surface: exact key allowlist, no leaks via errors, ids, aggregates or listings', async () => {
  const a = await cit('pub-a'); const b = await cit('pub-b');
  const iss = (await rep(a, { lat: 30.7000, lon: 76.7002 }, { note: 'my private note 12345' })).json.issue;
  await a.c.upload(`/v1/issues/${iss.id}/evidence?kind=report&lat=30.7&lon=76.7002`, await jpeg());
  const get = async (url: string) => w.app.inject({ method: 'GET', url });
  const one = (await get(`/v1/public/issues/${iss.id}`)).json();
  assert.deepEqual(Object.keys(one).sort(), ['complaint_id', 'complaint_no', 'created_at', 'deadline_at', 'hazard', 'hazards', 'id', 'location', 'reports_count', 'responsible', 'route_flags', 'severity', 'status', 'updated_at', 'ward'].sort()); // complaint_id is a public display reference, no reporter identity; hazards is the same already-public hazard class as hazard // complaint_id is a public display reference, no reporter identity; hazards is the same already-public hazard class as hazard
  assert.ok(!('official_records' in one)); // settled policy: complaint-linked candidate associations are owner-only, even on the public route
  assert.deepEqual(Object.keys(one.responsible).sort(), ['kind', 'synthetic_data']); // no contractor NAME: complaint-linked targeting is owner-only
  assert.deepEqual(Object.keys(one.location).sort(), ['lat', 'lon']);
  const list = (await get('/v1/public/issues?limit=200')).body;
  for (const secret of ['my private note', a.id, b.id, 'pub-a', 'issuer.test', 'storage_key', 'sha256', 'alias']) assert.ok(!list.includes(secret), 'leak: ' + secret);
  // filtering cannot be used to reach private fields; odd parameters are rejected or ignored, never echoed
  const odd = await get('/v1/public/issues?status=%27%20OR%201=1--&limit=5');
  assert.ok(odd.statusCode === 200 && odd.json().issues.length === 0);
  assert.equal((await get('/v1/public/issues?limit=100000')).statusCode, 400);
  const miss = await get('/v1/public/issues/00000000-0000-4000-8000-000000000000');
  assert.equal(miss.statusCode, 404); assert.ok(!miss.body.includes('0000-4000'));
  // private endpoints answer identically for "missing" and "exists but not yours"
  const nobody = await cit('pub-nobody');
  const hidden = await nobody.c.get(`/v1/issues/${iss.id}`); const missing = await nobody.c.get('/v1/issues/00000000-0000-4000-8000-000000000000');
  assert.equal(hidden.status, 404); assert.deepEqual(hidden.json, missing.json);
  // public endpoints never take the Authorization header into account
  const withTok = await w.app.inject({ method: 'GET', url: `/v1/public/issues/${iss.id}`, headers: { authorization: `Bearer ${a.t}` } });
  assert.deepEqual(withTok.json(), one);
  // identity is not exposed to other citizens through me/leaderboard
  const me = (await a.c.get('/v1/me')).json; assert.ok(!('issuer' in me) && !('subject' in me));
  const lb = (await b.c.get('/v1/leaderboard')).json; assert.ok(!JSON.stringify(lb).includes('pub-a')); assert.ok(lb.leaderboard.every((r: any) => Object.keys(r).sort().join() === 'alias,points,ward'));
  assert.equal((await get('/v1/nope')).statusCode, 404);
  assert.equal((await w.app.inject({ method: 'GET', url: '/v1/public/scorecards' })).statusCode, 404);
});

test('evidence authorization matrix incl. a second municipality', async () => {
  const muni2 = (await w.adminDb.query(`INSERT INTO orgs (kind,name) VALUES ('municipality','Other City') RETURNING id`)).rows[0].id;
  const admin2 = await s.mk('admin-2'); await w.adminDb.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'admin')`, [admin2.id, muni2]);
  const officer2 = await s.mk('officer-2'); await admin2.c.post('/v1/admin/memberships', { user_id: officer2.id, org_id: muni2, role: 'officer' });
  assert.equal((await admin2.c.post('/v1/admin/memberships', { user_id: officer2.id, org_id: s.muni, role: 'officer' })).status, 403); // cannot grant into someone else's municipality
  const r = await cit('evm-r'); const other = await cit('evm-other');
  const iss = (await rep(r, { lat: 30.7000, lon: 76.7003 })).json.issue;
  const up = await r.c.upload(`/v1/issues/${iss.id}/evidence?kind=report&lat=30.7&lon=76.7003`, await jpeg());
  const url = `/v1/issues/${iss.id}/evidence/${up.json.evidence_id}`;
  // settled policy: photo bytes go ONLY to the own uploader and the exact owner principal - no role grants
  const who: [string, any, number][] = [['reporter (uploader)', r, 200], ['officer same city', s.officer, 404], ['assigned contractor', s.contractor, 404], ['other citizen', other, 404], ['officer other city', officer2, 404], ['admin other city', admin2, 404]];
  for (const [name, u, want] of who) assert.equal((await u.c.get(url)).status, want, name);
  assert.equal((await (await mainAdmin(w)).get(url)).status, 200, 'exact owner principal');
  assert.equal((await w.app.inject({ method: 'GET', url })).statusCode, 401);
  for (const u of [officer2, admin2, other]) {
    assert.equal((await u.c.get(`/v1/issues/${iss.id}`)).status, 404);
    assert.equal((await u.c.post(`/v1/issues/${iss.id}/override-route`, { org_id: muni2, reason: 'Steal this issue now' })).status, 404);
    assert.equal((await u.c.post(`/v1/issues/${iss.id}/municipal-decision`, { decision: 'approve', reason: 'Approve other city' })).status, 404);
  }
  // evidence id from another issue cannot be fetched through this issue's URL
  const iss2 = (await rep(await cit('evm-r2'), { lat: 30.7000, lon: 76.7040 })).json.issue;
  assert.equal((await r.c.get(`/v1/issues/${iss2.id}/evidence/${up.json.evidence_id}`)).status, 404);
  // cross-issue proof reuse is refused
  const ev2 = await s.contractor.c.upload(`/v1/issues/${iss.id}/evidence?kind=after&lat=30.7&lon=76.7003`, await jpeg());
  await s.contractor.c.post(`/v1/issues/${iss2.id}/start`);
  assert.equal((await s.contractor.c.post(`/v1/issues/${iss2.id}/submit-repair`, { evidence_id: ev2.json.evidence_id })).status, 422);
});

test('spoofing and abuse controls: time, GPS, reporter identity, rate limit', async () => {
  const u = await cit('sp-u');
  const old = new Date(Date.now() - 3600_000).toISOString();
  assert.equal((await u.c.post('/v1/reports', { ...reportBody(P_WARRANTY), captured_at: old })).status, 422);
  assert.equal((await u.c.post('/v1/reports', { ...reportBody(P_WARRANTY), captured_at: new Date(Date.now() + 3600_000).toISOString() })).status, 422);
  assert.equal((await u.c.post('/v1/reports', { ...reportBody(P_WARRANTY), accuracy_m: 5000 })).status, 422);
  assert.equal((await u.c.post('/v1/reports', { ...reportBody(P_WARRANTY), user_id: 'someone-else', reporter_id: 'x', status: 'fixed' })).status, 400);
  assert.equal((await u.c.post('/v1/reports', { ...reportBody(P_WARRANTY), captured_at: 'yesterday' })).status, 400);
  const w2 = await newWorld({ rateLimitMax: 5 });
  try {
    const codes: number[] = []; for (let i = 0; i < 8; i++) codes.push((await w2.app.inject({ method: 'GET', url: '/health' })).statusCode);
    assert.ok(codes.includes(429) && codes[0] === 200);
  } finally { await w2.close(); }
});

test('transactions: concurrent confirmations, caps, disputes and decisions stay consistent', async () => {
  // daily cap holds under parallel requests from one user
  const cap = await cit('tx-cap');
  const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => cap.c.post('/v1/reports', reportBody({ lat: 30.7500, lon: 76.7100 - i * 0.001 }))));
  assert.equal(rs.filter((r) => r.status === 201 || r.status === 200).length, 10);
  assert.equal(rs.filter((r) => r.status === 429).length, 6);
  // parallel confirmations + municipal approval: exactly one terminal transition, points paid once
  const r1 = await cit('tx-r1'); const r2 = await cit('tx-r2'); const r3 = await cit('tx-r3');
  const base = { lat: 30.7000, lon: 76.7022 };
  const id = (await rep(r1, base)).json.issue.id; await rep(r2, { lat: base.lat + 0.00004, lon: base.lon }); await rep(r3, { lat: base.lat - 0.00004, lon: base.lon });
  await s.contractor.c.post(`/v1/issues/${id}/start`);
  const up = await s.contractor.c.upload(`/v1/issues/${id}/evidence?kind=after&lat=30.7&lon=${base.lon}`, await jpeg());
  await s.contractor.c.post(`/v1/issues/${id}/submit-repair`, { evidence_id: up.json.evidence_id });
  const res = await Promise.all([r1.c.post(`/v1/issues/${id}/confirm`, { is_fixed: true }), r2.c.post(`/v1/issues/${id}/confirm`, { is_fixed: true }), r3.c.post(`/v1/issues/${id}/confirm`, { is_fixed: true }),
    s.officer.c.post(`/v1/issues/${id}/municipal-decision`, { decision: 'approve', reason: 'Officer inspected the road' })]);
  assert.ok(res.every((r) => [200, 409].includes(r.status)), JSON.stringify(res.map((r) => r.status)));
  const ev = (await w.adminDb.query(`SELECT kind FROM status_events WHERE issue_id=$1 AND kind LIKE 'fixed_by%'`, [id])).rows;
  assert.equal(ev.length, 1);
  assert.equal((await w.adminDb.query('SELECT status FROM issues WHERE id=$1', [id])).rows[0].status, 'fixed');
  const dupPoints = (await w.adminDb.query(`SELECT user_id, count(*)::int n FROM points_ledger WHERE issue_id=$1 AND reason='confirmed_fix' GROUP BY user_id`, [id])).rows;
  assert.ok(dupPoints.every((r) => r.n === 1));
  // parallel disputes -> one wins
  const id2 = (await rep(await cit('tx-d'), { lat: 30.7000, lon: 76.7030 })).json.issue.id;
  const ds = await Promise.all([1, 2, 3].map(() => s.contractor.c.post(`/v1/issues/${id2}/dispute`, { reason: 'Utility trench cut seen on site' })));
  assert.deepEqual(ds.map((d) => d.status).sort(), [201, 409, 409]);
});

test('hosted test mode: dev defaults only by explicit opt-in, never in production', async () => {
  const { fromEnv } = await import('../src/config.ts');
  const base = { AUTH_ISSUER: 'https://i.test/', AUTH_AUDIENCE: 'a', AUTH_JWKS_URL: 'https://i.test/jwks', DATABASE_URL: 'postgres://x' } as any;
  assert.throws(() => fromEnv(base), /POLICY_/);
  const c = fromEnv({ ...base, POLICY_USE_DEV_DEFAULTS: 'synthetic-test-only', NODE_ENV: 'staging' });
  assert.equal(c.policySource, 'dev-defaults');
  assert.throws(() => fromEnv({ ...base, POLICY_USE_DEV_DEFAULTS: 'synthetic-test-only', NODE_ENV: 'production' }), /production/);
  assert.throws(() => fromEnv({ ...base, POLICY_USE_DEV_DEFAULTS: 'yes' }), /POLICY_/);
});

test('error shapes are consistent: unknown route, malformed JSON, oversized or wrong content type', async () => {
  const nf = await w.app.inject({ method: 'GET', url: '/v1/nope' });
  assert.equal(nf.statusCode, 404); assert.equal(nf.json().error, 'not_found');
  const t = await userToken('shape-1');
  const bad = await w.app.inject({ method: 'POST', url: '/v1/reports', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, payload: '{not json' });
  assert.equal(bad.statusCode, 400); assert.ok(bad.json().error);
  const big = await w.app.inject({ method: 'POST', url: '/v1/reports', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, payload: JSON.stringify({ note: 'x'.repeat(11 * 1024 * 1024) }) });
  assert.equal(big.statusCode, 413); assert.ok(big.json().error);
  assert.doesNotMatch(JSON.stringify(big.json()), /stack|node_modules/);
});

test('real server process: starts, serves /health, exits 0 on SIGTERM', async () => {
  const { spawn } = await import('node:child_process');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const url = (w.cfg.databaseUrl as string).replace('sandbox@', 'nagartrace_runtime@');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { env: { ...process.env, PORT: String(port), DATABASE_URL: url, AUTH_ISSUER: 'https://issuer.test/', AUTH_AUDIENCE: 'nagartrace-api', AUTH_JWKS_URL: 'https://issuer.test/jwks', POLICY_USE_DEV_DEFAULTS: 'synthetic-test-only', NODE_ENV: 'test', STORAGE_DIR: w.cfg.storageDir as string }, stdio: 'ignore' });
  const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  assert.ok(up, 'server did not start');
  child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 8000))]);
  if (code === 'timeout') child.kill('SIGKILL');
  assert.equal(code, 0);
});
