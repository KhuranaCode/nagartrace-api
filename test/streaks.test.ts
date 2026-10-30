/**
 * Streak module tests.
 *  - Unit tests for the pure streak math run everywhere.
 *  - Integration tests run against a real Postgres when STREAK_TEST_DB_URL is set
 *    (e.g. postgresql://postgres@/postgres?host=/tmp/pgdata). They build a MINIMAL schema
 *    (users + points_ledger subsets + db/007_streaks.sql, read verbatim) because the full
 *    migration chain needs PostGIS; the streak tables and queries never touch geography.
 *    The integrator must still run the full suite (npm test) after wiring the plugin in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import pg from 'pg';
import { SignJWT, generateKeyPair } from 'jose';
import { addDays, computeStreaks, isValidTimeZone, registerStreakRoutes, DEFAULT_STREAK_TZ } from '../src/streaks.ts';
import { HttpError } from '../src/auth.ts';
import { defaults } from '../src/config.ts';

// ---------- pure streak math ----------

test('computeStreaks: empty', () => {
  assert.deepEqual(computeStreaks([], '2026-10-30'),
    { current: 0, longest: 0, alive: false, todayCredited: false, lastCredited: null, total: 0 });
});

test('computeStreaks: consecutive run ending today is current', () => {
  const s = computeStreaks(['2026-10-28', '2026-10-29', '2026-10-30'], '2026-10-30');
  assert.deepEqual(s, { current: 3, longest: 3, alive: true, todayCredited: true, lastCredited: '2026-10-30', total: 3 });
});

test('computeStreaks: run ending yesterday is still alive, not today-credited', () => {
  const s = computeStreaks(['2026-10-28', '2026-10-29'], '2026-10-30');
  assert.equal(s.current, 2);
  assert.equal(s.alive, true);
  assert.equal(s.todayCredited, false);
});

test('computeStreaks: gap before today breaks current but keeps longest', () => {
  const s = computeStreaks(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-29'], '2026-10-30');
  assert.equal(s.current, 1); // yesterday alone
  assert.equal(s.longest, 3);
  assert.equal(s.alive, true);
});

test('computeStreaks: stale last day means broken streak, longest retained', () => {
  const s = computeStreaks(['2026-10-01', '2026-10-02', '2026-10-03'], '2026-10-30');
  assert.equal(s.current, 0);
  assert.equal(s.alive, false);
  assert.equal(s.longest, 3);
  assert.equal(s.total, 3);
});

test('computeStreaks: duplicates and unsorted input are normalized', () => {
  const s = computeStreaks(['2026-10-30', '2026-10-29', '2026-10-30'], '2026-10-30');
  assert.equal(s.current, 2);
  assert.equal(s.total, 2);
});

test('computeStreaks: month and year boundaries are consecutive', () => {
  const s = computeStreaks(['2026-01-30', '2026-01-31', '2026-02-01', '2025-12-31', '2026-01-01'], '2026-02-01');
  assert.equal(s.current, 3);
  assert.equal(s.longest, 3);
  assert.equal(s.total, 5);
});

test('addDays basics', () => {
  assert.equal(addDays('2026-10-30', -1), '2026-10-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29'); // leap year
});

test('isValidTimeZone', () => {
  assert.ok(isValidTimeZone('Asia/Kolkata'));
  assert.ok(isValidTimeZone('UTC'));
  assert.ok(!isValidTimeZone('Mars/Olympus_Mons'));
  assert.ok(!isValidTimeZone("x'; DROP TABLE users;--"));
  assert.ok(!isValidTimeZone(''));
});

// ---------- integration against real Postgres ----------

const DB_URL = process.env.STREAK_TEST_DB_URL;
const it = DB_URL ? test : test.skip;

const HARNESS_SQL = `
  -- gen_random_uuid() is core in PG13+; no pgcrypto needed in the harness
  CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer text NOT NULL, subject text NOT NULL, alias text NOT NULL,
    ward text, points integer NOT NULL DEFAULT 0,
    suspended boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer, subject)
  );
  CREATE TABLE IF NOT EXISTS points_ledger (
    id bigserial PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    issue_id uuid, delta integer NOT NULL, reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

async function world() {
  const admin = new pg.Pool({ connectionString: DB_URL, max: 2 });
  await admin.query('DROP TABLE IF EXISTS user_streak_prefs, user_streak_days, user_streaks, points_ledger, users CASCADE');
  await admin.query(HARNESS_SQL);
  const sql007 = fs.readFileSync(path.resolve(import.meta.dirname, '../db/007_streaks.sql'), 'utf8')
    .replaceAll('TO nagartrace_runtime', 'TO CURRENT_USER'); // harness has no runtime role; grants are covered by db/002 review
  await admin.query(sql007);
  const kp = await generateKeyPair('RS256');
  const cfg = { ...defaults(), authIssuer: 'https://issuer.test/', authAudience: 'nagartrace-api', databaseUrl: DB_URL! };
  const app = Fastify({ logger: false });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
    return reply.status(500).send({ error: 'internal', message: String(err) });
  });
  registerStreakRoutes(app, { cfg, db: admin as any, keys: kp.publicKey });
  const sign = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(sub)
    .setIssuer(cfg.authIssuer).setAudience(cfg.authAudience).setIssuedAt().setExpirationTime('10m').sign(kp.privateKey);
  const get = async (sub: string, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await sign(sub)}` } });
  const patch = async (sub: string, url: string, body: unknown) =>
    app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${await sign(sub)}`, 'content-type': 'application/json' }, payload: body as any });
  const uid = async (sub: string) =>
    (await admin.query('SELECT id FROM users WHERE subject=$1', [sub])).rows[0].id as string;
  // authenticate() creates the user row on first call; warm it up so tests can insert ledger rows
  const mkuser = async (sub: string) => { await get(sub, '/v1/me/streaks'); return uid(sub); };
  const ledger = (userId: string, delta: number, at: string, reason = 'verified_report') =>
    admin.query('INSERT INTO points_ledger (user_id, delta, reason, created_at) VALUES ($1,$2,$3,$4)', [userId, delta, reason, at]);
  const kolkataToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return { app, admin, get, patch, mkuser, ledger, kolkataToday, close: () => admin.end() };
}

it('no activity: zeroed honest state', async () => {
  const w = await world();
  try {
    await w.mkuser('u-empty');
    const r = await w.get('u-empty', '/v1/me/streaks');
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.equal(j.current_streak, 0);
    assert.equal(j.longest_streak, 0);
    assert.equal(j.streak_alive, false);
    assert.equal(j.today_credited, false);
    assert.equal(j.last_credited_date, null);
    assert.equal(j.timezone, DEFAULT_STREAK_TZ);
    assert.equal(j.milestones.every((m: any) => !m.earned), true);
  } finally { await w.close(); }
});

it('credits consecutive verified days and keeps streak alive', async () => {
  const w = await world();
  try {
    const id = await w.mkuser('u-streak');
    const t = w.kolkataToday();
    await w.ledger(id, 10, `${addDays(t, -2)}T10:00:00+05:30`);
    await w.ledger(id, 10, `${addDays(t, -1)}T10:00:00+05:30`);
    await w.ledger(id, 5, `${t}T09:00:00+05:30`, 'confirmed_fix');
    const j = (await w.get('u-streak', '/v1/me/streaks')).json();
    assert.equal(j.current_streak, 3);
    assert.equal(j.longest_streak, 3);
    assert.equal(j.today_credited, true);
    assert.equal(j.credited_days, 3);
    assert.equal(j.milestones.find((m: any) => m.days === 3).earned, true);
    assert.equal(j.milestones.find((m: any) => m.days === 7).earned, false);
  } finally { await w.close(); }
});

it('a gap breaks the current streak but longest survives', async () => {
  const w = await world();
  try {
    const id = await w.mkuser('u-gap');
    const t = w.kolkataToday();
    await w.ledger(id, 10, `${addDays(t, -5)}T10:00:00+05:30`);
    await w.ledger(id, 10, `${addDays(t, -4)}T10:00:00+05:30`);
    await w.ledger(id, 10, `${addDays(t, -3)}T10:00:00+05:30`);
    await w.ledger(id, 10, `${addDays(t, -1)}T10:00:00+05:30`);
    const j = (await w.get('u-gap', '/v1/me/streaks')).json();
    assert.equal(j.current_streak, 1);
    assert.equal(j.longest_streak, 3);
    assert.equal(j.streak_alive, true);
  } finally { await w.close(); }
});

it('last activity 2+ days ago: streak broken, history kept', async () => {
  const w = await world();
  try {
    const id = await w.mkuser('u-stale');
    const t = w.kolkataToday();
    await w.ledger(id, 10, `${addDays(t, -3)}T10:00:00+05:30`);
    await w.ledger(id, 10, `${addDays(t, -2)}T10:00:00+05:30`);
    const j = (await w.get('u-stale', '/v1/me/streaks')).json();
    assert.equal(j.current_streak, 0);
    assert.equal(j.streak_alive, false);
    assert.equal(j.longest_streak, 2);
    assert.equal(j.credited_days, 2);
  } finally { await w.close(); }
});

it('repeated reads are idempotent (watermark, no duplicate days)', async () => {
  const w = await world();
  try {
    const id = await w.mkuser('u-idem');
    const t = w.kolkataToday();
    await w.ledger(id, 10, `${t}T08:00:00+05:30`);
    const a = (await w.get('u-idem', '/v1/me/streaks')).json();
    const b = (await w.get('u-idem', '/v1/me/streaks')).json();
    const c = (await w.get('u-idem', '/v1/me/streaks')).json();
    assert.deepEqual([b.current_streak, b.credited_days], [a.current_streak, a.credited_days]);
    assert.deepEqual(c, b);
    const n = (await w.admin.query('SELECT count(*)::int AS n FROM user_streak_days WHERE user_id=$1', [id])).rows[0].n;
    assert.equal(n, 1);
  } finally { await w.close(); }
});

it('negative and zero ledger entries never credit a day', async () => {
  const w = await world();
  try {
    const id = await w.mkuser('u-neg');
    const t = w.kolkataToday();
    await w.ledger(id, -10, `${t}T08:00:00+05:30`, 'false_report_penalty');
    await w.ledger(id, 0, `${t}T09:00:00+05:30`, 'capped');
    const j = (await w.get('u-neg', '/v1/me/streaks')).json();
    assert.equal(j.credited_days, 0);
    assert.equal(j.current_streak, 0);
    assert.equal(j.today_credited, false);
  } finally { await w.close(); }
});

it('day boundaries follow the user timezone, not UTC', async () => {
  const w = await world();
  try {
    const id = await w.mkuser('u-tz');
    // 2026-01-02 00:30 IST == 2026-01-01 19:00 UTC: Kolkata says Jan 2, UTC says Jan 1.
    await w.ledger(id, 10, '2026-01-02T00:30:00+05:30');
    const j = (await w.get('u-tz', '/v1/me/streaks')).json();
    assert.equal(j.last_credited_date, '2026-01-02');
    // Same instant re-buckets to Jan 1 for a UTC user.
    const j2 = (await w.patch('u-tz', '/v1/me/streaks/timezone', { timezone: 'UTC' })).json();
    assert.equal(j2.timezone, 'UTC');
    assert.equal(j2.last_credited_date, '2026-01-01');
    assert.equal(j2.credited_days, 1);
  } finally { await w.close(); }
});

it('timezone change re-buckets history idempotently', async () => {
  const w = await world();
  try {
    const id = await w.mkuser('u-rebucket');
    await w.ledger(id, 10, '2026-03-01T23:30:00+00:00'); // Mar 1 UTC, Mar 2 IST
    const j1 = (await w.get('u-rebucket', '/v1/me/streaks')).json();
    assert.equal(j1.last_credited_date, '2026-03-02'); // default Asia/Kolkata
    const j2 = (await w.patch('u-rebucket', '/v1/me/streaks/timezone', { timezone: 'UTC' })).json();
    assert.equal(j2.last_credited_date, '2026-03-01');
    const j3 = (await w.get('u-rebucket', '/v1/me/streaks')).json();
    assert.deepEqual([j3.last_credited_date, j3.credited_days], [j2.last_credited_date, j2.credited_days]);
    const n = (await w.admin.query('SELECT count(*)::int AS n FROM user_streak_days WHERE user_id=$1', [id])).rows[0].n;
    assert.equal(n, 1); // re-bucketed, not duplicated
  } finally { await w.close(); }
});

it('rejects invalid timezone values', async () => {
  const w = await world();
  try {
    await w.mkuser('u-badtz');
    const r1 = await w.patch('u-badtz', '/v1/me/streaks/timezone', { timezone: 'Not/A_Zone' });
    assert.equal(r1.statusCode, 422);
    assert.equal(r1.json().error, 'bad_timezone');
    const r2 = await w.patch('u-badtz', '/v1/me/streaks/timezone', { timezone: "UTC'; DROP TABLE users;--" });
    assert.equal(r2.statusCode, 422);
    const r3 = await w.patch('u-badtz', '/v1/me/streaks/timezone', {});
    assert.equal(r3.statusCode, 400);
  } finally { await w.close(); }
});

it('new verified activity after first read advances the streak', async () => {
  const w = await world();
  try {
    const id = await w.mkuser('u-live');
    const t = w.kolkataToday();
    await w.ledger(id, 10, `${addDays(t, -1)}T10:00:00+05:30`);
    const j1 = (await w.get('u-live', '/v1/me/streaks')).json();
    assert.equal(j1.current_streak, 1);
    assert.equal(j1.today_credited, false);
    await w.ledger(id, 10, new Date().toISOString());
    const j2 = (await w.get('u-live', '/v1/me/streaks')).json();
    assert.equal(j2.current_streak, 2);
    assert.equal(j2.today_credited, true);
  } finally { await w.close(); }
});

it('concurrent reads stay consistent', async () => {
  const w = await world();
  try {
    const id = await w.mkuser('u-race');
    const t = w.kolkataToday();
    for (let i = 1; i <= 3; i++) await w.ledger(id, 10, `${addDays(t, -i)}T10:00:00+05:30`);
    const rs = await Promise.all(Array.from({ length: 5 }, () => w.get('u-race', '/v1/me/streaks')));
    for (const r of rs) assert.equal(r.statusCode, 200);
    const bodies = rs.map((r) => JSON.stringify(r.json()));
    assert.ok(bodies.every((b) => b === bodies[0]));
    const n = (await w.admin.query('SELECT count(*)::int AS n FROM user_streak_days WHERE user_id=$1', [id])).rows[0].n;
    assert.equal(n, 3);
  } finally { await w.close(); }
});

it('requires authentication', async () => {
  const w = await world();
  try {
    const r = await w.app.inject({ method: 'GET', url: '/v1/me/streaks' });
    assert.equal(r.statusCode, 401);
  } finally { await w.close(); }
});
