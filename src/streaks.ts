/**
 * Streaks / engagement progress (website gamification request). Self-contained module:
 * the integrator only adds `registerStreakRoutes(app, { cfg, db, keys })` inside buildApp
 * (docs/STREAKS.md has the exact two-line wiring). No existing file changes are required.
 *
 * Semantics (all derived from points_ledger, the append-only source of truth):
 *  - A "streak day" is a calendar day in the user's timezone on which at least one POSITIVE
 *    points_ledger entry landed. Positive entries exist only for verified activity
 *    (verified_report, first_reporter_bonus, confirmed_fix) and pass the daily points cap,
 *    so unverified reports and spam never move a streak. No separate streak write path exists.
 *  - current_streak counts the consecutive-day run ending at the most recent credited day.
 *    It stays alive while that day is today or yesterday (today may simply have no activity
 *    yet); an older last credited day means the streak is broken (current = 0).
 *  - longest_streak is the best run ever. Changing timezone re-buckets all days from the ledger.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { authenticate, HttpError, type KeyResolver } from './auth.ts';
import type { Config } from './config.ts';

/** ASSUMPTION: the PRD does not define streak day boundaries. NagarTrace is India-focused,
 *  so Asia/Kolkata is the default; each user can override with any IANA timezone. */
export const DEFAULT_STREAK_TZ = 'Asia/Kolkata';

const STREAK_MILESTONES = [3, 7, 14, 30, 100];

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length < 1 || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** 'YYYY-MM-DD' plus n days (pure UTC date math; safe because the format has no time component). */
export function addDays(d: string, n: number): string {
  return new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
}

export type StreakStats = {
  current: number;
  longest: number;
  alive: boolean;
  todayCredited: boolean;
  lastCredited: string | null;
  total: number;
};

/** Consecutive-day runs over local dates ('YYYY-MM-DD' sorts chronologically). */
export function computeStreaks(days: string[], today: string): StreakStats {
  const uniq = [...new Set(days)].sort();
  const total = uniq.length;
  if (!total) return { current: 0, longest: 0, alive: false, todayCredited: false, lastCredited: null, total: 0 };
  let longest = 1;
  let run = 1;
  for (let i = 1; i < uniq.length; i++) {
    run = addDays(uniq[i - 1], 1) === uniq[i] ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  const lastCredited = uniq[uniq.length - 1];
  const yesterday = addDays(today, -1);
  const alive = lastCredited === today || lastCredited === yesterday;
  // length of the run that ends at lastCredited
  let tail = 1;
  for (let i = uniq.length - 1; i > 0 && addDays(uniq[i - 1], 1) === uniq[i]; i--) tail++;
  return { current: alive ? tail : 0, longest, alive, todayCredited: lastCredited === today, lastCredited, total };
}

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'validation');
  return r.data;
}

type Q = pg.PoolClient;

/** Reads (or lazily creates) the user's streak timezone. */
async function currentTz(c: Q, userId: string, defaultTz: string): Promise<string> {
  const r = await c.query('SELECT tz FROM user_streak_prefs WHERE user_id=$1', [userId]);
  if (r.rowCount) return r.rows[0].tz as string;
  await c.query('INSERT INTO user_streak_prefs (user_id, tz) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING', [userId, defaultTz]);
  return defaultTz;
}

/**
 * Idempotently advances the user's derived streak state from points_ledger.
 * Watermark over points_ledger.id makes re-runs no-ops; a timezone change re-buckets everything.
 * Must run inside a transaction.
 */
export async function refreshStreaks(c: Q, userId: string, tz: string): Promise<void> {
  // Serialize concurrent refreshes for the same user (read endpoints can race).
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['streaks:' + userId]);
  const pref = await c.query('SELECT tz FROM user_streak_prefs WHERE user_id=$1', [userId]);
  if (pref.rowCount && pref.rows[0].tz !== tz) {
    // Day boundaries move with the timezone: re-derive every credited day from the ledger.
    await c.query('DELETE FROM user_streak_days WHERE user_id=$1', [userId]);
    await c.query(
      `INSERT INTO user_streaks (user_id, watermark_ledger_id) VALUES ($1, 0)
       ON CONFLICT (user_id) DO UPDATE SET watermark_ledger_id = 0`, [userId]);
    await c.query('UPDATE user_streak_prefs SET tz=$2, updated_at=now() WHERE user_id=$1', [userId, tz]);
  }
  const wmRow = (await c.query('SELECT watermark_ledger_id FROM user_streaks WHERE user_id=$1', [userId])).rows[0];
  const wm = BigInt(wmRow?.watermark_ledger_id ?? 0);
  // Credit one day per local date, keeping the earliest ledger id of that day as provenance.
  await c.query(
    `INSERT INTO user_streak_days (user_id, local_date, first_ledger_id)
     SELECT DISTINCT ON (d) $1, d, id FROM (
       SELECT id, (created_at AT TIME ZONE $2)::date AS d
       FROM points_ledger WHERE user_id=$1 AND delta > 0 AND id > $3 ORDER BY id
     ) s ORDER BY d, id
     ON CONFLICT (user_id, local_date) DO NOTHING`,
    [userId, tz, wm.toString()]);
  const next = (await c.query(
    `SELECT COALESCE(MAX(id), 0)::text AS m FROM points_ledger WHERE user_id=$1 AND delta > 0 AND id > $2`,
    [userId, wm.toString()])).rows[0].m as string;
  const watermark = BigInt(next) > wm ? BigInt(next) : wm;
  const dayRows = (await c.query(
    `SELECT to_char(local_date, 'YYYY-MM-DD') AS d FROM user_streak_days WHERE user_id=$1 ORDER BY local_date`, [userId])).rows;
  const today = (await c.query(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS t`, [tz])).rows[0].t as string;
  const stats = computeStreaks(dayRows.map((r) => r.d as string), today);
  await c.query(
    `INSERT INTO user_streaks (user_id, current_streak, longest_streak, credited_days, last_credited_date, watermark_ledger_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (user_id) DO UPDATE SET current_streak=$2, longest_streak=$3, credited_days=$4,
       last_credited_date=$5, watermark_ledger_id=$6, updated_at=now()`,
    [userId, stats.current, stats.longest, stats.total, stats.lastCredited, watermark.toString()]);
}

export type StreakDeps = { cfg: Config; db: pg.Pool; keys: KeyResolver; defaultTz?: string };

export function registerStreakRoutes(app: FastifyInstance, deps: StreakDeps): void {
  const { cfg, db, keys } = deps;
  const defaultTz = deps.defaultTz ?? DEFAULT_STREAK_TZ;
  const auth = (req: FastifyRequest) => authenticate(req.headers.authorization, cfg, keys, db);
  async function tx<T>(fn: (c: Q) => Promise<T>): Promise<T> {
    const c = await db.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }

  async function state(c: Q, userId: string, tz: string) {
    await refreshStreaks(c, userId, tz);
    // date columns are read with to_char: a JS Date round-trip would shift the day in non-UTC processes
    const s = (await c.query(
      `SELECT current_streak, longest_streak, credited_days, to_char(last_credited_date, 'YYYY-MM-DD') AS last_credited FROM user_streaks WHERE user_id=$1`, [userId])).rows[0];
    const today = (await c.query(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS t`, [tz])).rows[0].t as string;
    const recent = (await c.query(
      `SELECT to_char(local_date, 'YYYY-MM-DD') AS d FROM user_streak_days WHERE user_id=$1 ORDER BY local_date DESC LIMIT 14`, [userId])).rows.map((r) => r.d as string);
    const lastCredited = (s?.last_credited as string | undefined) ?? null;
    const alive = lastCredited === today || lastCredited === addDays(today, -1);
    const longest = s?.longest_streak ?? 0;
    return {
      timezone: tz,
      current_streak: alive ? (s?.current_streak ?? 0) : 0,
      longest_streak: longest,
      streak_alive: alive,
      today_credited: lastCredited === today,
      last_credited_date: lastCredited,
      credited_days: s?.credited_days ?? 0,
      recent_days: recent,
      milestones: STREAK_MILESTONES.map((m) => ({ days: m, earned: longest >= m })),
      note: 'A day counts only when points from verified activity land in the ledger (verified report, first-reporter bonus, fix confirmation). Unverified reports never move a streak. Day boundaries use your timezone.',
    };
  }

  app.get('/v1/me/streaks', async (req) => {
    const p = await auth(req);
    return tx(async (c) => state(c, p.userId, await currentTz(c, p.userId, defaultTz)));
  });

  app.patch('/v1/me/streaks/timezone', async (req) => {
    const p = await auth(req);
    const b = parse(z.object({ timezone: z.string().min(1).max(64) }).strict(), req.body);
    if (!isValidTimeZone(b.timezone)) throw new HttpError(422, 'Unknown IANA timezone name', 'bad_timezone');
    return tx(async (c) => {
      await currentTz(c, p.userId, defaultTz); // ensure prefs row exists before the tz write
      return state(c, p.userId, b.timezone);
    });
  });
}
