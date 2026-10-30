import type pg from 'pg';
import type { Config } from './config.ts';
import { HttpError } from './auth.ts';

type Q = pg.PoolClient;
export type IssueStatus = 'reported' | 'verified' | 'assigned' | 'in_progress' | 'awaiting_confirmation' | 'fixed' | 'reopened' | 'rejected';

const ALLOWED: Record<IssueStatus, IssueStatus[]> = {
  reported: ['verified', 'rejected'],
  verified: ['assigned', 'rejected'],
  assigned: ['in_progress', 'assigned'],
  in_progress: ['awaiting_confirmation', 'assigned'],
  awaiting_confirmation: ['fixed', 'reopened'],
  reopened: ['in_progress', 'assigned'],
  fixed: [],
  rejected: [],
};

const HAZARD_BASE: Record<string, number> = { pothole: 2, crack: 1, waterlogging: 2, broken_edge: 2, missing_cover: 3, other: 1 };

/** PRD: severity estimated from hazard type, danger flag, number of confirmations and road type.
 *  Road type is not in the registry model yet, so it is not used. */
export function severityOf(hazard: string, danger: boolean, reports: number): number {
  const s = (HAZARD_BASE[hazard] ?? 1) + (danger ? 2 : 0) + Math.min(2, Math.floor((reports - 1) / 2) + (reports > 1 ? 1 : 0));
  return Math.max(1, Math.min(5, s));
}
export const deadlineHours = (severity: number) => (severity >= 4 ? 48 : 7 * 24);

export async function recordEvent(c: Q, issueId: string, actorId: string | null, from: IssueStatus | null, to: IssueStatus | null, kind: string, reason?: string | null, data: object = {}) {
  await c.query(`INSERT INTO status_events (issue_id, actor_id, from_status, to_status, kind, reason, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [issueId, actorId, from, to, kind, reason ?? null, JSON.stringify(data)]);
}

export async function lockIssue(c: Q, id: string) {
  const r = await c.query(`SELECT *, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon FROM issues WHERE id=$1 FOR UPDATE`, [id]);
  if (!r.rowCount) throw new HttpError(404, 'Issue not found', 'not_found');
  return r.rows[0];
}

export async function transition(c: Q, issue: { id: string; status: IssueStatus }, to: IssueStatus, actorId: string | null, kind: string, reason?: string | null, extraSet = '', extraArgs: unknown[] = [], data: object = {}) {
  if (!ALLOWED[issue.status].includes(to)) throw new HttpError(409, `Cannot move from ${issue.status} to ${to}`, 'bad_transition');
  await c.query(`UPDATE issues SET status=$1, updated_at=now() ${extraSet} WHERE id=$${extraArgs.length + 2}`, [to, ...extraArgs, issue.id]);
  await recordEvent(c, issue.id, actorId, issue.status, to, kind, reason, data);
}

export type Route = { orgId: string | null; kind: 'municipality' | 'contractor' | 'utility' | null; copyOrgId: string | null; roadId: string | null; reason: string; flags: string[]; ward: string | null; reviewOrgId: string | null };

/** PRD routing, first match wins: (1) road not in registry -> municipality + flag; (2) recent utility cut -> utility, copy municipality;
 *  (3) inside warranty -> contractor, copy municipality; else municipality. Never invents a contractor. */
export async function routeIssue(c: Q, cfg: Config, lat: number, lon: number, now = new Date(), test = false): Promise<Route> {
  const road = await c.query(
    `SELECT id, municipality_org_id, ward FROM road_segments
     WHERE is_synthetic=$4 AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
     ORDER BY ST_Distance(geom, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) LIMIT 1`, [lat, lon, cfg.roadMatchRadiusM, test]);
  if (!road.rowCount) {
    const m = await c.query(`SELECT id FROM orgs WHERE kind='municipality' AND is_synthetic=$1`, [test]);
    if (m.rowCount === 1) return { orgId: m.rows[0].id, kind: 'municipality', copyOrgId: null, roadId: null, reason: 'Road not found in registry; sent to municipality for review', flags: ['road_not_in_registry'], ward: null, reviewOrgId: m.rows[0].id };
    return { orgId: null, kind: null, copyOrgId: null, roadId: null, reason: test ? 'Road not in registry and no single municipality to route to' : 'No real authority is connected yet; report is stored unassigned', flags: ['road_not_in_registry', 'needs_manual_routing'], ward: null, reviewOrgId: null };
  }
  const { id: roadId, municipality_org_id: muni, ward } = road.rows[0];
  const day = now.toISOString().slice(0, 10);
  const cut = await c.query(
    `SELECT utility_org_id FROM utility_cuts WHERE road_id=$1 AND cut_date <= $2::date AND cut_date >= ($2::date - $3::int) ORDER BY cut_date DESC LIMIT 1`, [roadId, day, cfg.utilityCutWindowDays]);
  if (cut.rowCount) return { orgId: cut.rows[0].utility_org_id, kind: 'utility', copyOrgId: muni, roadId, reason: `Utility cut within ${cfg.utilityCutWindowDays} days on this road`, flags: [], ward, reviewOrgId: muni };
  const w = await c.query(
    `SELECT contractor_org_id FROM contracts WHERE road_id=$1 AND completion_date <= $2::date AND warranty_end >= $2::date ORDER BY completion_date DESC LIMIT 1`, [roadId, day]);
  if (w.rowCount) return { orgId: w.rows[0].contractor_org_id, kind: 'contractor', copyOrgId: muni, roadId, reason: 'Road inside contractor warranty period', flags: [], ward, reviewOrgId: muni };
  return { orgId: muni, kind: 'municipality', copyOrgId: null, roadId, reason: 'No utility cut or active warranty on record; municipality maintenance', flags: [], ward, reviewOrgId: muni };
}

export async function awardPoints(c: Q, cfg: Config, userId: string, delta: number, reason: string, issueId: string | null) {
  if (delta > 0) {
    const r = await c.query(`SELECT COALESCE(SUM(delta),0)::int AS s FROM points_ledger WHERE user_id=$1 AND delta>0 AND created_at > now() - interval '24 hours'`, [userId]);
    const room = cfg.dailyPointsCap - r.rows[0].s;
    delta = Math.min(delta, Math.max(0, room));
    if (delta <= 0) return 0;
  }
  await c.query(`INSERT INTO points_ledger (user_id, issue_id, delta, reason) VALUES ($1,$2,$3,$4)`, [userId, issueId, delta, reason]);
  await c.query(`UPDATE users SET points = points + $2 WHERE id=$1`, [userId, delta]);
  return delta;
}

/** Records overdue escalation events. Idempotent. Nothing is delivered to anyone. */
export async function runEscalations(c: Q, cfg: Config, now = new Date()) {
  const l1 = await c.query(
    `INSERT INTO escalation_events (issue_id, level, target, deadline_at)
     SELECT id, 1, 'municipal_engineer', deadline_at FROM issues
     WHERE status IN ('assigned','in_progress','reopened') AND deadline_at < $1
     ON CONFLICT DO NOTHING RETURNING issue_id`, [now]);
  const l2 = await c.query(
    `INSERT INTO escalation_events (issue_id, level, target, deadline_at)
     SELECT id, 2, 'department_head', deadline_at FROM issues
     WHERE status IN ('assigned','in_progress','reopened') AND deadline_at + ($2 || ' hours')::interval < $1
     ON CONFLICT DO NOTHING RETURNING issue_id`, [now, String(cfg.level2DelayHours)]);
  for (const r of l1.rows) await recordEvent(c, r.issue_id, null, null, null, 'escalation_level_1', 'Deadline missed; recorded for municipal engineer (not delivered)');
  for (const r of l2.rows) await recordEvent(c, r.issue_id, null, null, null, 'escalation_level_2', 'Still overdue; recorded for department head (not delivered)');
  return { level1: l1.rowCount ?? 0, level2: l2.rowCount ?? 0 };
}
