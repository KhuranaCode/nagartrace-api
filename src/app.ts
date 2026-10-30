import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type pg from 'pg';
import type { Config } from './config.ts';
import { authenticate, HttpError, memberships, type KeyResolver, type Membership, type Principal } from './auth.ts';
import { awardPoints, deadlineHours, lockIssue, recordEvent, routeIssue, runEscalations, severityOf, transition } from './domain.ts';
import { registerStreakRoutes } from './streaks.ts';
import { registerFollowupRoutes } from './followup.ts';
import { normalizeImage } from './images.ts';
import type { BlobStore } from './storage.ts';
import { officialRecordsForPoint, nhaiAwardsBrowse } from './govrecords.ts';

export type Deps = { cfg: Config; db: pg.Pool; keys: KeyResolver; store: BlobStore; now?: () => Date; /** Test seam for the issuer self-lookup; production uses global fetch. */ fetchImpl?: typeof fetch };

const HAZARDS = ['pothole', 'crack', 'waterlogging', 'broken_edge', 'missing_cover', 'other'] as const;
const uuid = z.string().uuid();
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'validation');
  return r.data;
}

const ISSUE_COLS = `i.review_org_id, i.id, i.complaint_no, i.hazard, i.hazards, i.danger_flag, i.severity, i.status, i.ward, i.responsible_kind, i.route_reason, i.route_flags, i.route_overridden,
  i.deadline_at, i.reports_count, i.reopen_count, i.created_at, i.updated_at, i.fixed_at,
  ST_Y(i.geom::geometry) AS lat, ST_X(i.geom::geometry) AS lon,
  i.is_test, ro.id AS responsible_org_id, ro.name AS responsible_org_name, ro.is_synthetic AS responsible_synthetic, co.name AS copy_org_name, i.copy_org_id`;
const ISSUE_FROM = `FROM issues i LEFT JOIN orgs ro ON ro.id=i.responsible_org_id LEFT JOIN orgs co ON co.id=i.copy_org_id`;

/** node-pg returns custom enum arrays as raw '{a,b}' text; split into a plain list. */
export function pgEnumArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1);
    return inner ? inner.split(',') : [];
  }
  return [];
}

/** Public view: no reporter identity, no evidence, coordinates rounded to ~11 m. */
/** Human-readable complaint reference, e.g. NT-000123. Stable for the life of the issue. */
export const complaintId = (no: number | string | null | undefined) =>
  no == null ? null : `NT-${String(no).padStart(6, '0')}`;

/** Official records for a PUBLIC view: computed from the same rounded point the public sees,
 *  so nearest-road selection and derived distances can never leak finer private precision. */
async function publicOfficialRecords(db: pg.Pool, r: any) {
  return officialRecordsForPoint(db, Math.round(r.lat * 1e4) / 1e4, Math.round(r.lon * 1e4) / 1e4);
}
function publicDto(r: any) {
  return {
    id: r.id, complaint_no: r.complaint_no == null ? null : Number(r.complaint_no), complaint_id: complaintId(r.complaint_no == null ? null : Number(r.complaint_no)), hazard: r.hazard, hazards: pgEnumArray(r.hazards), status: r.status, severity: r.severity, ward: r.ward,
    location: { lat: Math.round(r.lat * 1e4) / 1e4, lon: Math.round(r.lon * 1e4) / 1e4 },
    responsible: r.responsible_org_name ? { kind: r.responsible_kind, name: r.responsible_org_name, synthetic_data: !!r.responsible_synthetic } : null,
    deadline_at: r.deadline_at, reports_count: r.reports_count, route_flags: r.route_flags, created_at: r.created_at, updated_at: r.updated_at,
  };
}
function fullDto(r: any) {
  return { ...publicDto(r), test_data: !!r.is_test, location: { lat: r.lat, lon: r.lon }, danger_flag: r.danger_flag, route_reason: r.route_reason, route_overridden: r.route_overridden,
    reopen_count: r.reopen_count, fixed_at: r.fixed_at, copy_org: r.copy_org_name ?? null,
    responsible_org_id: r.responsible_org_id ?? null, copy_org_id: r.copy_org_id ?? null, review_org_id: r.review_org_id ?? null };
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { cfg, db, keys, store } = deps;
  if (process.env.NODE_ENV === 'production' && cfg.policySource !== 'explicit') throw new Error('Refusing to start: policy values are provisional dev defaults. Set every POLICY_* variable explicitly.');
  const now = () => deps.now?.() ?? new Date();
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024, trustProxy: cfg.trustProxy });
  await app.register(rateLimit, { max: cfg.rateLimitMax, timeWindow: '1 minute' });

  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  // CORS: exact-origin allowlist only (CORS_ORIGINS). No wildcard, no credentials/cookies are used (bearer tokens).
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !cfg.corsOrigins.includes(origin)) { if (req.method === 'OPTIONS' && origin) return reply.status(403).send({ error: 'cors_denied', message: 'Origin not allowed' }); return; }
    reply.header('access-control-allow-origin', origin).header('vary', 'origin');
    if (req.method === 'OPTIONS') return reply.status(204).header('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS').header('access-control-allow-headers', 'authorization,content-type,idempotency-key').header('access-control-max-age', '600').send();
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer').header('cache-control', 'no-store')
      .header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
    console.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Internal error' });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Route not found' }));

  const auth = (req: FastifyRequest) => authenticate(req.headers.authorization, cfg, keys, db);
  async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await db.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  const orgIds = (ms: Membership[], roles?: string[]) => ms.filter((m) => !roles || roles.includes(m.role)).map((m) => m.org_id);
  const isStaffOf = (issue: any, ms: Membership[], roles: string[]) => ms.some((m) => roles.includes(m.role) && (m.org_id === issue.responsible_org_id || m.org_id === issue.copy_org_id));
  const isMunicipalStaff = (issue: any, ms: Membership[]) => ms.some((m) => (m.role === 'officer' || m.role === 'admin') && m.kind === 'municipality' && (m.org_id === issue.responsible_org_id || m.org_id === issue.copy_org_id));
  const isReviewer = (issue: any, ms: Membership[]) => issue.status === 'reported' && !!issue.review_org_id && ms.some((m) => (m.role === 'officer' || m.role === 'admin') && m.kind === 'municipality' && m.org_id === issue.review_org_id);
  // Unrouted pending report (no municipality could be chosen): any municipal officer/admin may see it (no photos) and claim it for review. Who should own such reports is an OPEN policy decision.
  const isTriager = (issue: any, ms: Membership[]) => cfg.unroutedTriage === 'any_municipal_staff' && issue.status === 'reported' && !issue.review_org_id && ms.some((m) => (m.role === 'officer' || m.role === 'admin') && m.kind === 'municipality' && m.synthetic === !!issue.is_test); // cohort guard: fixture staff only triage fixture reports, real staff only real ones
  const isAssignee = (issue: any, ms: Membership[]) => ms.some((m) => m.org_id === issue.responsible_org_id && ['contractor', 'utility', 'officer', 'admin'].includes(m.role));
  const isReporter = async (c: pg.Pool | pg.PoolClient, issueId: string, userId: string) => !!(await c.query('SELECT 1 FROM reports WHERE issue_id=$1 AND user_id=$2', [issueId, userId])).rowCount;

  app.get('/health', async () => ({ ok: true, verification_mode: cfg.verificationMode, unrouted_triage: cfg.unroutedTriage, policy: cfg.policySource === 'explicit' ? 'explicit' : 'PROVISIONAL-dev-defaults-not-for-real-use' }));

  // ---------- identity ----------
  app.get('/v1/me', async (req) => {
    const p = await auth(req);
    const u = (await db.query('SELECT id, alias, ward, points, created_at, is_test FROM users WHERE id=$1', [p.userId])).rows[0];
    const ms = await memberships(db, p.userId);
    return { ...u, memberships: ms };
  });
  app.get('/v1/me/badges', async (req) => {
    const p = await auth(req);
    const r = (await db.query(
      `SELECT (SELECT count(*) FROM reports WHERE user_id=$1)::int AS reports,
              (SELECT count(*) FROM confirmations WHERE user_id=$1 AND is_fixed)::int AS fix_confirms,
              (SELECT u.ward IS NOT NULL AND u.points > 0 AND NOT EXISTS (SELECT 1 FROM users o WHERE o.ward=u.ward AND o.id<>u.id AND o.points >= u.points) FROM users u WHERE u.id=$1) AS ward_top`, [p.userId])).rows[0];
    const earned = [
      { badge: 'First Report', earned: r.reports >= 1 },
      { badge: 'Road Guardian', earned: r.reports >= 10 },
      { badge: 'Fix Checker', earned: r.fix_confirms >= 10 },
      { badge: 'Ward Champion', earned: !!r.ward_top },
    ];
    return { badges: earned, progress: { reports: r.reports, fix_confirmations: r.fix_confirms }, note: 'Derived live from reports, confirmations and all-time ward points. Counts every submitted report: there is no verification or false-report step yet (PRD does not say who decides).' };
  });
  app.patch('/v1/me', async (req) => {
    const p = await auth(req);
    const b = parse(z.object({ alias: z.string().trim().min(2).max(40).optional(), ward: z.string().trim().max(60).optional() }).strict(), req.body);
    await db.query('UPDATE users SET alias=COALESCE($2,alias), ward=COALESCE($3,ward) WHERE id=$1', [p.userId, b.alias ?? null, b.ward ?? null]);
    return { ok: true };
  });

  // ---------- reporting ----------
  /**
   * Binds a staged photo to an issue as 'report' evidence. Must run inside the report
   * transaction: the row is locked FOR UPDATE, so a staged upload can never be consumed
   * twice, by another user, or after expiry. A location mismatch THROWS, rolling back
   * the report - no photo-less issue is left behind - while the staged row stays
   * unconsumed so the client can retry with corrected GPS.
   */
  async function bindStagedPhoto(c: pg.PoolClient, userId: string, issueId: string, uploadId: string, reportLon: number, reportLat: number) {
    // Atomic claim: one conditional UPDATE decides consumption. Two concurrent reports
    // carrying the same upload id cannot both pass - the loser's UPDATE matches no row.
    const claim = await c.query(
      `UPDATE staged_uploads SET consumed_at=now(), issue_id=$2
       WHERE id=$1 AND uploader_id=$3 AND consumed_at IS NULL AND expires_at > now()
       RETURNING *`, [uploadId, issueId, userId]);
    let s = claim.rows[0];
    if (!s) {
      // Claim failed. The ONLY distinguished case is an idempotent replay of a report
      // that already bound this upload to THIS issue (e.g. the client retried after a
      // crash): return the existing evidence instead of an error. Unknown id, another
      // user's upload, expiry and consumption by a different issue all get the same
      // 422 - the error must not reveal whether someone else's upload id exists.
      const ex = await c.query('SELECT issue_id, storage_key FROM staged_uploads WHERE id=$1 AND uploader_id=$2 AND consumed_at IS NOT NULL', [uploadId, userId]);
      if (ex.rowCount && ex.rows[0].issue_id === issueId) {
        const ev = await c.query('SELECT id FROM evidence WHERE issue_id=$1 AND storage_key=$2', [issueId, ex.rows[0].storage_key]);
        if (ev.rowCount) return { evidence_id: ev.rows[0].id as string, location_ok: true };
      }
      throw new HttpError(422, 'Photo upload is invalid, expired or already used - stage a fresh photo.', 'invalid_upload');
    }
    // Location: the photo's claimed point is checked against THIS REPORT's location
    // (the reporter's own GPS fix), not the issue's geom and never a centroid. For a
    // new issue the two are the same point. For a merged report this verifies the
    // photo against where this reporter actually stood; the merge rule already bounds
    // that to within the duplicate radius of the hazard, so the photo is provably near
    // the issue without falsely rejecting a legitimate reporter at the merge boundary.
    // (Post-hoc evidence uploads keep the stricter issue-geom rule.) A mismatch throws,
    // which rolls the whole report back - the claim above is undone with it, so the
    // upload stays consumable for a retry at the true location.
    const near = (await c.query(
      `SELECT ST_DWithin(ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, s.claimed_geom, $2) AS ok FROM staged_uploads s WHERE s.id=$1`,
      [uploadId, cfg.evidenceRadiusM, reportLon, reportLat])).rows[0].ok;
    if (!near) throw new HttpError(422, `Photo location must be within ${cfg.evidenceRadiusM} m of the report`, 'location_mismatch');
    const ev = await c.query(
      `INSERT INTO evidence (issue_id, uploader_id, kind, storage_key, sha256, content_type, byte_size, width, height, claimed_geom, location_ok)
       VALUES ($1,$2,'report',$3,$4,$5,$6,$7,$8,$9,true) RETURNING id`,
      [issueId, userId, s.storage_key, s.sha256, s.content_type, s.byte_size, s.width, s.height, s.claimed_geom]);
    return { evidence_id: ev.rows[0].id as string, location_ok: true };
  }

  app.post('/v1/reports', async (req, reply) => {
    const p = await auth(req);
    const b = parse(z.object({
      lat, lon, accuracy_m: z.number().min(0).max(100000).optional(), hazard: z.enum(HAZARDS), danger: z.boolean().default(false),
      // Multi-hazard reports: the full set observed at this spot. `hazard` stays the PRIMARY
      // (must be included); order of the rest is the reporter's. Old clients omit it => [hazard].
      hazards: z.array(z.enum(HAZARDS)).min(1).max(HAZARDS.length).optional(),
      note: z.string().trim().max(500).optional(), captured_at: z.string().datetime(),
      // Photo-mandatory reports: id from POST /v1/uploads/stage. Bound atomically in the
      // report transaction below. Optional in the schema for old-client compatibility;
      // PHOTO_REQUIRED=true (deployment owner, after the staging client is live) rejects
      // its absence - there is no photo-less bypass once the flag is on.
      photo_upload_id: uuid.optional(),
    }).strict(), req.body);
    if (!b.photo_upload_id && cfg.photoRequired)
      throw new HttpError(422, 'A photo is required to file a report. Upload it first (POST /v1/uploads/stage) and pass photo_upload_id.', 'photo_required');
    if (b.hazards && !b.hazards.includes(b.hazard))
      throw new HttpError(400, 'hazards must include the primary hazard', 'hazard_set_invalid');
    const hazardSet = [b.hazard, ...new Set((b.hazards ?? []).filter((h) => h !== b.hazard))];
    const idem = (req.headers['idempotency-key'] as string | undefined)?.slice(0, 128);
    const t = now();
    const captured = new Date(b.captured_at);
    if (captured.getTime() > t.getTime() + 2 * 60_000) throw new HttpError(422, 'captured_at is in the future', 'stale_report');
    if (t.getTime() - captured.getTime() > cfg.reportMaxAgeMin * 60_000) throw new HttpError(422, `Report must be captured within ${cfg.reportMaxAgeMin} minutes`, 'stale_report');
    if (b.accuracy_m !== undefined && b.accuracy_m > cfg.maxAccuracyM) throw new HttpError(422, `GPS accuracy worse than ${cfg.maxAccuracyM} m`, 'poor_gps');

    const result = await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['user:' + p.userId]);
      // Serialises issue creation so concurrent reports at one spot merge instead of creating twins. Fine for now; revisit (spatial cell locks) at scale.
      await c.query('SELECT pg_advisory_xact_lock(4201)');
      if (idem) {
        const ex = await c.query(
          `SELECT r.issue_id, r.id, ST_Y(r.geom::geometry) AS lat, ST_X(r.geom::geometry) AS lon, i.hazard, r.hazards
           FROM reports r JOIN issues i ON i.id = r.issue_id
           WHERE r.user_id=$1 AND r.idempotency_key=$2`, [p.userId, idem]);
        if (ex.rowCount) {
          // Replay = return the ORIGINAL result. It must NEVER consume a new upload:
          // under the atomic design there is no crash window between report creation
          // and photo binding (one transaction), so a replay carrying a DIFFERENT
          // upload id is a changed payload with a reused key, not a recovery - 409.
          const orig = ex.rows[0];
          if (orig.lat !== b.lat || orig.lon !== b.lon || orig.hazard !== b.hazard
              || pgEnumArray(orig.hazards).join(',') !== hazardSet.join(','))
            throw new HttpError(409, 'This idempotency key was already used with a different report', 'idempotency_mismatch');
          const bound = (await c.query(
            `SELECT s.id AS upload_id, e.id AS evidence_id FROM staged_uploads s
             JOIN evidence e ON e.issue_id = s.issue_id AND e.storage_key = s.storage_key
             WHERE s.issue_id=$1 AND s.uploader_id=$2 AND s.consumed_at IS NOT NULL LIMIT 1`, [orig.issue_id, p.userId])).rows[0];
          if (b.photo_upload_id && b.photo_upload_id !== bound?.upload_id)
            throw new HttpError(409, 'This idempotency key was already used with a different photo upload', 'idempotency_mismatch');
          const photo = bound ? { evidence_id: bound.evidence_id as string, location_ok: true } : null;
          return { issueId: orig.issue_id, reportId: orig.id, created: false, merged: false, replay: true, photo };
        }
      }
      const isTest = !!(await c.query('SELECT is_test FROM users WHERE id=$1', [p.userId])).rows[0]?.is_test;
      const cap = await c.query(`SELECT count(*)::int AS n FROM reports WHERE user_id=$1 AND created_at > now() - interval '24 hours'`, [p.userId]);
      if (cap.rows[0].n >= cfg.dailyReportCap) throw new HttpError(429, 'Daily report limit reached', 'daily_cap');

      const dup = await c.query(
        `SELECT id FROM issues WHERE hazards && $1::hazard_type[] AND status NOT IN ('fixed','rejected') AND is_test=$5
         AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography, $4)
         ORDER BY ST_Distance(geom, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography) LIMIT 1 FOR UPDATE`, [hazardSet, b.lat, b.lon, cfg.duplicateRadiusM, isTest]);
      let issueId: string; let created = false; let merged = false;
      if (dup.rowCount) {
        issueId = dup.rows[0].id;
        if (await isReporter(c, issueId, p.userId)) throw new HttpError(409, 'You already reported this hazard', 'already_reported');
        const cur = await lockIssue(c, issueId);
        const reports = cur.reports_count + 1;
        const sev = Math.max(cur.severity, severityOf(cur.hazard, cur.danger_flag || b.danger, reports));
        await c.query(`UPDATE issues i SET reports_count=$2, severity=$3, danger_flag = danger_flag OR $4, updated_at=now(),
          hazards = i.hazards || COALESCE((SELECT array_agg(u ORDER BY ord) FROM unnest($5::hazard_type[]) WITH ORDINALITY AS s(u, ord) WHERE u <> ALL (i.hazards)), '{}')
          WHERE id=$1`, [issueId, reports, sev, b.danger, hazardSet]);
        if (sev > cur.severity && cur.deadline_at && ['assigned', 'in_progress', 'reopened'].includes(cur.status)) {
          // Higher severity shortens the window from the existing assignment time; an existing deadline is never extended.
          const since = (await c.query(`SELECT max(created_at) t FROM status_events WHERE issue_id=$1 AND to_status IN ('assigned','reopened')`, [issueId])).rows[0].t;
          if (since) await c.query('UPDATE issues SET deadline_at = LEAST(deadline_at, $2::timestamptz) WHERE id=$1', [issueId, new Date(new Date(since).getTime() + deadlineHours(sev) * 3600_000)]);
        }
        await recordEvent(c, issueId, p.userId, cur.status, cur.status, 'duplicate_merged', null, { reports, severity: sev });
        merged = true;
      } else {
        const sev = severityOf(b.hazard, b.danger, 1);
        const route = await routeIssue(c, cfg, b.lat, b.lon, t, isTest);
        const ins = await c.query(
          `INSERT INTO issues (reporter_id, geom, hazard, hazards, danger_flag, severity, ward, road_id, is_test) VALUES ($1, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography, $4,$10,$5,$6,$7,$8,$9) RETURNING id`,
          [p.userId, b.lat, b.lon, b.hazard, b.danger, sev, route.ward, route.roadId, isTest, hazardSet]);
        issueId = ins.rows[0].id; created = true;
        await recordEvent(c, issueId, p.userId, null, 'reported', 'created');
        if (cfg.verificationMode === 'auto_checks' && route.orgId) {
          // PROVISIONAL mode, not agreed: plausibility checks alone verify and assign. Not the default.
          await recordEvent(c, issueId, null, 'reported', 'verified', 'auto_verified', 'Passed automatic freshness/accuracy/cap checks (auto_checks mode)');
          const deadline = new Date(t.getTime() + deadlineHours(sev) * 3600_000);
          await c.query(`UPDATE issues SET status='assigned', responsible_org_id=$2, responsible_kind=$3, copy_org_id=$4, route_reason=$5, route_flags=$6, deadline_at=$7, review_org_id=$8 WHERE id=$1`,
            [issueId, route.orgId, route.kind, route.copyOrgId, route.reason, route.flags, route.orgId ? deadline : null, route.reviewOrgId]);
          await recordEvent(c, issueId, null, 'verified', 'assigned', 'routed', route.reason, { flags: route.flags, deadline_at: deadline.toISOString() });
        } else {
          // Safe default: stay 'reported'. The routing result is only a suggestion for the reviewing officer; no authority is assigned.
          await c.query(`UPDATE issues SET review_org_id=$2, suggested_org_id=$3, suggested_kind=$4, suggested_copy_org_id=$5, suggested_reason=$6, suggested_flags=$7 WHERE id=$1`,
            [issueId, route.reviewOrgId, route.orgId, route.kind, route.copyOrgId, route.reason, route.flags]);
          await recordEvent(c, issueId, null, 'reported', 'reported', 'routing_suggested', route.reason, { flags: route.flags, awaiting: 'officer_verification' });
        }
      }
      const rep = await c.query(
        `INSERT INTO reports (issue_id, user_id, geom, accuracy_m, note, captured_at, idempotency_key, hazards) VALUES ($1,$2,ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,$5,$6,$7,$8,$9) RETURNING id`,
        [issueId, p.userId, b.lat, b.lon, b.accuracy_m ?? null, b.note ?? null, captured, idem ?? null, hazardSet]);
      const stNow = (await c.query('SELECT status FROM issues WHERE id=$1', [issueId])).rows[0].status;
      if (stNow !== 'reported') { // points only for reports on an issue that has been verified (PRD: "verified new report")
        await awardPoints(c, cfg, p.userId, 10, 'verified_report', issueId);
        if (created) await awardPoints(c, cfg, p.userId, 5, 'first_reporter_bonus', issueId);
      }
      const photo = b.photo_upload_id ? await bindStagedPhoto(c, p.userId, issueId, b.photo_upload_id, b.lon, b.lat) : null;
      return { issueId, reportId: rep.rows[0].id, created, merged, replay: false, photo };
    });
    const row = (await db.query(`SELECT ${ISSUE_COLS} ${ISSUE_FROM} WHERE i.id=$1`, [result.issueId])).rows[0];
    return reply.status(result.replay ? 200 : result.created ? 201 : 200).send({ report_id: result.reportId, merged_into_existing: result.merged, replayed: result.replay, issue: fullDto(row), ...(result.photo ? { photo: result.photo } : {}) });
  });

  // ---------- reading issues ----------
  app.get('/v1/issues', async (req) => {
    const p = await auth(req);
    const ms = await memberships(db, p.userId);
    const q = parse(z.object({ responsible: z.enum(['municipality','contractor','utility']).optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const mine = orgIds(ms);
    const r = await db.query(
      `SELECT ${ISSUE_COLS} ${ISSUE_FROM}
       WHERE (EXISTS (SELECT 1 FROM reports rp WHERE rp.issue_id=i.id AND rp.user_id=$1) OR i.responsible_org_id = ANY($2::uuid[]) OR i.copy_org_id = ANY($2::uuid[]) OR (i.status='reported' AND (i.review_org_id = ANY($6::uuid[]) OR (i.review_org_id IS NULL AND $7::boolean AND EXISTS (SELECT 1 FROM orgs tz WHERE tz.id = ANY($6::uuid[]) AND tz.is_synthetic = i.is_test)))))
       AND ($3::text IS NULL OR i.status::text=$3) AND ($5::text IS NULL OR i.responsible_kind::text=$5) ORDER BY i.created_at DESC LIMIT $4`, [p.userId, mine, q.status ?? null, q.limit, q.responsible ?? null, orgIds(ms.filter((m) => m.kind === 'municipality' && ['officer', 'admin'].includes(m.role))), cfg.unroutedTriage === 'any_municipal_staff']);
    // Unrouted reports seen only through triage get the public (rounded, no reporter) view.
    const rep = new Set((await db.query('SELECT DISTINCT issue_id FROM reports WHERE user_id=$1', [p.userId])).rows.map((x) => x.issue_id));
    return { issues: r.rows.map((x) => (x.status === 'reported' && !x.review_org_id && !rep.has(x.id) ? { ...publicDto(x), triage_only: true } : fullDto(x))) };
  });
  app.get('/v1/issues/:id', async (req) => {
    const p = await auth(req);
    const id = parse(uuid, (req.params as any).id);
    const ms = await memberships(db, p.userId);
    const r = await db.query(`SELECT ${ISSUE_COLS} ${ISSUE_FROM} WHERE i.id=$1`, [id]);
    if (!r.rowCount) throw new HttpError(404, 'Issue not found', 'not_found');
    const issue = r.rows[0];
    const staff = isStaffOf(issue, ms, ['admin', 'officer', 'contractor', 'utility']) || isReviewer(issue, ms) || isTriager(issue, ms);
    if (!staff && !(await isReporter(db, id, p.userId))) throw new HttpError(404, 'Issue not found', 'not_found');
    if (!isStaffOf(issue, ms, ['admin', 'officer', 'contractor', 'utility']) && !isReviewer(issue, ms) && !(await isReporter(db, id, p.userId))) return { ...publicDto(issue), triage_only: true, official_records: await publicOfficialRecords(db, issue) }; // triage view: public-level fields + official records from the public point
    const events = (await db.query('SELECT id, kind, from_status, to_status, reason, actor_id IS NULL AS system, created_at FROM status_events WHERE issue_id=$1 ORDER BY id', [id])).rows;
    const ev = (await db.query('SELECT id, kind, location_ok, created_at FROM evidence WHERE issue_id=$1 ORDER BY created_at', [id])).rows;
    // Dispute ids go only to staff of the issue's orgs (contractor/utility raise, municipal staff decide). Reporters never see them.
    const staffView = isStaffOf(issue, ms, ['admin', 'officer', 'contractor', 'utility']);
    const disputes = staffView ? (await db.query('SELECT id, status, reason, org_id, evidence_id, created_at, decided_at, decision_reason FROM disputes WHERE issue_id=$1 ORDER BY created_at', [id])).rows : undefined;
    return { ...fullDto(issue), events, evidence: ev, ...(disputes ? { disputes } : {}), official_records: await officialRecordsForPoint(db, issue.lat, issue.lon), redaction: 'none (photos are never public)' };
  });

  // ---------- public, no login ----------
  app.get('/v1/public/issues', async (req) => {
    const q = parse(z.object({ responsible: z.enum(['municipality','contractor','utility']).optional(), status: z.string().optional(), ward: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query);
    const r = await db.query(`SELECT ${ISSUE_COLS} ${ISSUE_FROM} WHERE NOT i.is_test AND ($1::text IS NULL OR i.status::text=$1) AND ($2::text IS NULL OR i.ward=$2) AND ($4::text IS NULL OR i.responsible_kind::text=$4) ORDER BY i.created_at DESC LIMIT $3`, [q.status ?? null, q.ward ?? null, q.limit, q.responsible ?? null]);
    return { issues: r.rows.map(publicDto) };
  });
  app.get('/v1/public/issues/:id', async (req) => {
    const id = parse(uuid, (req.params as any).id);
    const r = await db.query(`SELECT ${ISSUE_COLS} ${ISSUE_FROM} WHERE i.id=$1`, [id]);
    if (!r.rowCount || r.rows[0].is_test) throw new HttpError(404, 'Issue not found', 'not_found');
    const row = r.rows[0];
    return { ...publicDto(row), official_records: await publicOfficialRecords(db, row) };
  });
  app.get('/v1/public/gov-records/nhai-awards', async (req) => {
    const q = parse(z.object({ state: z.string().max(60).optional(), nh: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(352).default(100) }).strict(), req.query);
    return nhaiAwardsBrowse(db, q);
  });
  app.get('/v1/public/scorecards', async () => {
    if (!cfg.publicScorecards) throw new HttpError(404, 'Public scorecards are not enabled (legal review pending)', 'not_enabled');
    return { scorecards: await scorecards(db, false) };
  });
  app.get('/v1/leaderboard', async (req) => {
    const pr = await auth(req);
    const q = parse(z.object({ ward: z.string().max(60).optional(), period: z.enum(['weekly', 'all']).default('all') }), req.query);
    const r = await db.query(
      `SELECT u.alias, u.ward, COALESCE(SUM(l.delta),0)::int AS points FROM users u JOIN points_ledger l ON l.user_id=u.id
       WHERE ($1::text IS NULL OR u.ward=$1) AND ($2='all' OR l.created_at > now() - interval '7 days') AND u.is_test = (SELECT is_test FROM users WHERE id=$3) GROUP BY u.id ORDER BY points DESC LIMIT 50`, [q.ward ?? null, q.period, pr.userId]);
    return { leaderboard: r.rows };
  });

  // ---------- staged uploads (photo-mandatory reports) ----------
  app.post('/v1/uploads/stage', async (req, reply) => {
    const p = await auth(req);
    // Query strings are strings - coerce like the evidence endpoint does (a shared
    // z.number() here rejected every call with 400; caught by peer's live run).
    const q = parse(z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) }), req.query);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'Send the image as the raw request body (image/jpeg, image/png or image/webp)', 'bad_image');
    // Cheap pre-check BEFORE any expensive work (decode, blob write): reject accounts
    // already at the staging limits so a flood costs a count query, not storage. This
    // read is deliberately unlocked - it can lag under a burst, so the authoritative
    // check below runs again inside the per-account advisory lock; anything the
    // pre-check misses is caught there and its blob deleted. Exactness lives in the
    // lock; this exists only to protect resources.
    const pre = (await db.query(
      `SELECT count(*) FILTER (WHERE consumed_at IS NULL AND expires_at > now())::int AS pending,
              count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS recent
       FROM staged_uploads WHERE uploader_id=$1`, [p.userId])).rows[0];
    if (pre.pending >= 5) throw new HttpError(429, 'You have several staged photos waiting. Submit a report with one, or wait for them to expire (1 hour).', 'too_many_staged');
    if (pre.recent >= 30) throw new HttpError(429, 'Too many photo uploads - try again later.', 'rate_limited');
    // normalizeImage: 8 MB cap (Fastify bodyLimit 10 MB), magic-byte sniffing, bounded
    // pixel decode (24 MP), EXIF orientation applied, then everything re-encoded to
    // fresh JPEG - EXIF (incl. any embedded GPS) is stripped and never read.
    // claimed_geom below is the client's own GPS claim from the query string, NOT
    // photo metadata; it is verified against the report location at binding time.
    const img = await normalizeImage(req.body);
    const key = await store.put(img.data);
    try {
      const staged = await tx(async (c) => {
        // Serialises staging per account so the rate checks below are exact - two
        // concurrent stages cannot both pass a count taken before either inserts.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['stage:' + p.userId]);
        // Lazy expiry sweep, bounded to 100 rows per pass. ONLY unconsumed rows are
        // eligible - a consumed row's blob is live issue evidence. Rows are locked
        // FOR UPDATE SKIP LOCKED BEFORE any blob delete: a row a concurrent report is
        // consuming right now is either locked (skipped this pass) or already consumed
        // (filtered) - without the lock the old sequence (plain SELECT -> blob delete
        // -> conditional row DELETE) could delete the blob of a row that a racing
        // report consumed in between, leaving live evidence pointing at a missing
        // blob. A binder that arrives while we hold the lock blocks until commit and
        // then finds the row gone: 422 invalid_upload, correct for an expired upload.
        // The blob is deleted BEFORE the row: if the store delete fails the row is
        // KEPT and retried on a later pass, so blobs are not orphaned by a flaky
        // store. Backstop for a permanently failing store remains bucket lifecycle
        // policy (documented gap).
        const expired = await c.query(
          `SELECT id, storage_key FROM staged_uploads
           WHERE consumed_at IS NULL AND expires_at < now()
           ORDER BY expires_at LIMIT 100
           FOR UPDATE SKIP LOCKED`);
        for (const r of expired.rows) {
          try { await store.del?.(r.storage_key); } catch { continue; }
          await c.query('DELETE FROM staged_uploads WHERE id=$1', [r.id]);
        }
        // Per-user staging limits, inside the advisory lock: at most 5 unbound uploads
        // waiting and 30 stages per hour per account, so staging alone cannot fill storage.
        const load = (await c.query(
          `SELECT count(*) FILTER (WHERE consumed_at IS NULL AND expires_at > now())::int AS pending,
                  count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS recent
           FROM staged_uploads WHERE uploader_id=$1`, [p.userId])).rows[0];
        if (load.pending >= 5) throw new HttpError(429, 'You have several staged photos waiting. Submit a report with one, or wait for them to expire (1 hour).', 'too_many_staged');
        if (load.recent >= 30) throw new HttpError(429, 'Too many photo uploads - try again later.', 'rate_limited');
        const r = await c.query(
          `INSERT INTO staged_uploads (uploader_id, storage_key, sha256, content_type, byte_size, width, height, claimed_geom)
           VALUES ($1,$2,$3,$4,$5,$6,$7,ST_SetSRID(ST_MakePoint($9,$8),4326)::geography) RETURNING id, expires_at`,
          [p.userId, key, img.sha256, img.contentType, img.data.length, img.width, img.height, q.lat, q.lon]);
        return r.rows[0];
      });
      return reply.status(201).send({ upload_id: staged.id, expires_at: staged.expires_at, note: 'Private staged photo. It becomes issue evidence only when a report binds it; unbound uploads expire after one hour.' });
    } catch (e) {
      // Rejected or failed after the blob write - remove the blob instead of leaking it.
      // If THIS delete also fails the row is absent, so the sweep cannot retry: the
      // orphan leaks until bucket lifecycle policy. That residual gap is documented,
      // accepted, and bounded by the per-user rate limits above.
      try { await store.del?.(key); } catch { /* best-effort; documented residual leak */ }
      throw e;
    }
  });

  // ---------- evidence ----------
  app.post('/v1/issues/:id/evidence', async (req, reply) => {
    const p = await auth(req);
    const id = parse(uuid, (req.params as any).id);
    const q = parse(z.object({ kind: z.enum(['report', 'after', 'dispute']), lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) }), req.query);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'Send the image as the raw request body (image/jpeg, image/png or image/webp)', 'bad_image');
    const ms = await memberships(db, p.userId);
    const issue = (await db.query(`SELECT i.*, ST_Y(geom::geometry) AS ilat, ST_X(geom::geometry) AS ilon FROM issues i WHERE id=$1`, [id])).rows[0];
    if (!issue) throw new HttpError(404, 'Issue not found', 'not_found');
    if (q.kind === 'report') { if (!(await isReporter(db, id, p.userId))) throw new HttpError(404, 'Issue not found', 'not_found'); }
    else if (!isAssignee(issue, ms)) throw new HttpError(404, 'Issue not found', 'not_found');
    const near = (await db.query(`SELECT ST_DWithin(geom, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography, $4) AS ok FROM issues WHERE id=$1`, [id, q.lat, q.lon, cfg.evidenceRadiusM])).rows[0].ok;
    if (q.kind !== 'dispute' && !near) throw new HttpError(422, `Photo location must be within ${cfg.evidenceRadiusM} m of the issue`, 'location_mismatch');
    const img = await normalizeImage(req.body);
    const key = await store.put(img.data);
    const ev = await db.query(
      `INSERT INTO evidence (issue_id, uploader_id, kind, storage_key, sha256, content_type, byte_size, width, height, claimed_geom, location_ok)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,ST_SetSRID(ST_MakePoint($11,$10),4326)::geography,$12) RETURNING id`,
      [id, p.userId, q.kind, key, img.sha256, img.contentType, img.data.length, img.width, img.height, q.lat, q.lon, near]);
    return reply.status(201).send({ evidence_id: ev.rows[0].id, location_ok: near, note: 'Client-claimed location; metadata can be spoofed. Not public, not redacted.' });
  });
  app.get('/v1/issues/:id/evidence/:eid', async (req, reply) => {
    const p = await auth(req);
    const id = parse(uuid, (req.params as any).id); const eid = parse(uuid, (req.params as any).eid);
    const ms = await memberships(db, p.userId);
    const r = await db.query(`SELECT e.*, i.responsible_org_id, i.copy_org_id, i.review_org_id, i.status FROM evidence e JOIN issues i ON i.id=e.issue_id WHERE e.id=$1 AND e.issue_id=$2`, [eid, id]);
    if (!r.rowCount) throw new HttpError(404, 'Not found', 'not_found');
    const e = r.rows[0];
    const allowed = isStaffOf(e, ms, ['admin', 'officer', 'contractor', 'utility']) || isReviewer(e, ms) || e.uploader_id === p.userId || await isReporter(db, id, p.userId);
    if (!allowed) throw new HttpError(404, 'Not found', 'not_found');
    return reply.header('content-type', e.content_type).header('content-disposition', 'inline').send(await store.get(e.storage_key));
  });

  // ---------- repair workflow ----------
  app.post('/v1/issues/:id/claim-review', async (req) => {
    const p = await auth(req); const id = parse(uuid, (req.params as any).id); const ms = await memberships(db, p.userId);
    const b = parse(z.object({ org_id: uuid.optional(), reason: z.string().trim().min(10).max(500) }).strict(), req.body);
    const mine = orgIds(ms.filter((m) => m.kind === 'municipality' && ['officer', 'admin'].includes(m.role)));
    return tx(async (c) => {
      const issue = await lockIssue(c, id);
      if (!isTriager(issue, ms)) throw new HttpError(404, 'Issue not found', 'not_found');
      const target = b.org_id ?? (mine.length === 1 ? mine[0] : null);
      if (!target) throw new HttpError(422, 'org_id required when you belong to several municipalities', 'validation');
      if (!mine.includes(target)) throw new HttpError(403, 'Not staff of that municipality', 'forbidden');
      if (!ms.some((m) => m.org_id === target && m.synthetic === !!issue.is_test)) throw new HttpError(404, 'Issue not found', 'not_found');
      // Claiming only makes this municipality the reviewer. It assigns nothing; an officer must still verify.
      await c.query(`UPDATE issues SET review_org_id=$2, suggested_org_id=$2, suggested_kind='municipality', suggested_reason=$3, updated_at=now() WHERE id=$1`, [id, target, `Claimed for review: ${b.reason}`]);
      await recordEvent(c, id, p.userId, 'reported', 'reported', 'review_claimed', b.reason, { org_id: target });
      return { ok: true, status: 'reported' };
    });
  });
  app.post('/v1/issues/:id/verify', async (req) => {
    const p = await auth(req); const id = parse(uuid, (req.params as any).id); const ms = await memberships(db, p.userId);
    const b = parse(z.object({ decision: z.enum(['verify', 'reject']), reason: z.string().trim().min(10).max(500) }).strict(), req.body);
    return tx(async (c) => {
      const issue = await lockIssue(c, id);
      if (!isReviewer(issue, ms)) throw new HttpError(404, 'Issue not found', 'not_found');
      if (b.decision === 'reject') { await transition(c, issue, 'rejected', p.userId, 'rejected_by_officer', b.reason); return { status: 'rejected' }; }
      if (!issue.suggested_org_id) throw new HttpError(409, 'No routing suggestion (road not in registry and no single municipality). Needs manual routing before verification.', 'needs_manual_routing');
      await recordEvent(c, id, p.userId, 'reported', 'verified', 'verified_by_officer', b.reason);
      const deadline = new Date(now().getTime() + deadlineHours(issue.severity) * 3600_000);
      await c.query(`UPDATE issues SET status='assigned', responsible_org_id=suggested_org_id, responsible_kind=suggested_kind, copy_org_id=suggested_copy_org_id, route_reason=suggested_reason, route_flags=suggested_flags, deadline_at=$2, updated_at=now() WHERE id=$1`, [id, deadline]);
      await recordEvent(c, id, p.userId, 'verified', 'assigned', 'routed', issue.suggested_reason, { flags: issue.suggested_flags, deadline_at: deadline.toISOString() });
      // points deferred from intake: +10 to each reporter, +5 first-reporter bonus
      const reps = (await c.query('SELECT DISTINCT user_id FROM reports WHERE issue_id=$1', [id])).rows;
      for (const r of reps) await awardPoints(c, cfg, r.user_id, 10, 'verified_report', id);
      await awardPoints(c, cfg, issue.reporter_id, 5, 'first_reporter_bonus', id);
      return { status: 'assigned', responsible_kind: issue.suggested_kind };
    });
  });
  app.post('/v1/issues/:id/accept', async (req) => {
    const p = await auth(req); const id = parse(uuid, (req.params as any).id); const ms = await memberships(db, p.userId);
    return tx(async (c) => {
      const issue = await lockIssue(c, id);
      if (!isAssignee(issue, ms)) throw new HttpError(404, 'Issue not found', 'not_found');
      if (!['assigned', 'reopened'].includes(issue.status)) throw new HttpError(409, 'Only an assigned or reopened issue can be accepted', 'bad_state');
      const dup = await c.query(`SELECT 1 FROM status_events WHERE issue_id=$1 AND kind='accepted' AND created_at >= (SELECT COALESCE(max(created_at), '-infinity') FROM status_events WHERE issue_id=$1 AND to_status IN ('assigned','reopened'))`, [id]);
      if (dup.rowCount) return { accepted: true, already: true };
      await recordEvent(c, id, p.userId, issue.status, issue.status, 'accepted', null);
      return { accepted: true, already: false };
    });
  });
  app.post('/v1/issues/:id/start', async (req) => {
    const p = await auth(req); const id = parse(uuid, (req.params as any).id); const ms = await memberships(db, p.userId);
    return tx(async (c) => {
      const issue = await lockIssue(c, id);
      if (!isAssignee(issue, ms)) throw new HttpError(404, 'Issue not found', 'not_found');
      await transition(c, issue, 'in_progress', p.userId, 'started');
      return { status: 'in_progress' };
    });
  });
  app.post('/v1/issues/:id/submit-repair', async (req) => {
    const p = await auth(req); const id = parse(uuid, (req.params as any).id); const ms = await memberships(db, p.userId);
    const b = parse(z.object({ evidence_id: uuid }).strict(), req.body);
    return tx(async (c) => {
      const issue = await lockIssue(c, id);
      if (!isAssignee(issue, ms)) throw new HttpError(404, 'Issue not found', 'not_found');
      const ev = await c.query(`SELECT 1 FROM evidence WHERE id=$1 AND issue_id=$2 AND kind='after' AND location_ok AND uploader_id=$3`, [b.evidence_id, id, p.userId]);
      if (!ev.rowCount) throw new HttpError(422, 'Needs your own after-photo with a passing location check for this issue', 'no_valid_proof');
      await transition(c, issue, 'awaiting_confirmation', p.userId, 'repair_submitted', null, '', [], { evidence_id: b.evidence_id });
      return { status: 'awaiting_confirmation' };
    });
  });
  app.post('/v1/issues/:id/confirm', async (req) => {
    const p = await auth(req); const id = parse(uuid, (req.params as any).id); const ms = await memberships(db, p.userId);
    const b = parse(z.object({ is_fixed: z.boolean() }).strict(), req.body);
    return tx(async (c) => {
      const issue = await lockIssue(c, id);
      if (issue.status !== 'awaiting_confirmation') throw new HttpError(409, 'Issue is not awaiting confirmation', 'bad_state');
      if (!(await isReporter(c, id, p.userId))) throw new HttpError(403, 'Only citizens who reported this hazard can confirm the fix', 'not_eligible');
      if (ms.some((m) => m.org_id === issue.responsible_org_id || m.org_id === issue.copy_org_id)) throw new HttpError(403, 'Staff of the responsible organisations cannot confirm', 'not_eligible');
      if (p.ageHours < cfg.confirmMinAccountAgeHours) throw new HttpError(403, 'Account too new to confirm repairs', 'not_eligible');
      const dup = await c.query('SELECT 1 FROM confirmations WHERE issue_id=$1 AND user_id=$2 AND round=$3', [id, p.userId, issue.reopen_count]);
      if (dup.rowCount) throw new HttpError(409, 'Already voted this round', 'already_voted');
      await c.query('INSERT INTO confirmations (issue_id,user_id,round,is_fixed) VALUES ($1,$2,$3,$4)', [id, p.userId, issue.reopen_count, b.is_fixed]);
      await recordEvent(c, id, p.userId, issue.status, issue.status, b.is_fixed ? 'confirm_fixed' : 'confirm_not_fixed');
      const tally = (await c.query('SELECT is_fixed, count(*)::int n FROM confirmations WHERE issue_id=$1 AND round=$2 GROUP BY is_fixed', [id, issue.reopen_count])).rows;
      const yes = tally.find((t) => t.is_fixed)?.n ?? 0; const no = tally.find((t) => !t.is_fixed)?.n ?? 0;
      if (yes >= cfg.confirmationsToClose) {
        await transition(c, issue, 'fixed', null, 'fixed_by_citizens', `${yes} citizen confirmations`, ', fixed_at=now()');
        const voters = await c.query('SELECT user_id FROM confirmations WHERE issue_id=$1 AND round=$2 AND is_fixed', [id, issue.reopen_count]);
        for (const v of voters.rows) await awardPoints(c, cfg, v.user_id, 5, 'confirmed_fix', id);
        return { status: 'fixed' };
      }
      if (no >= cfg.confirmationsToClose) return { status: await reopen(c, cfg, issue, null, `${no} citizens rejected the repair`, now()) };
      return { status: 'awaiting_confirmation', fixed_votes: yes, not_fixed_votes: no };
    });
  });
  app.post('/v1/issues/:id/municipal-decision', async (req) => {
    const p = await auth(req); const id = parse(uuid, (req.params as any).id); const ms = await memberships(db, p.userId);
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(10).max(500) }).strict(), req.body);
    return tx(async (c) => {
      const issue = await lockIssue(c, id);
      if (!isMunicipalStaff(issue, ms)) throw new HttpError(404, 'Issue not found', 'not_found');
      if (issue.status !== 'awaiting_confirmation') throw new HttpError(409, 'Issue is not awaiting confirmation', 'bad_state');
      if (b.decision === 'approve') { await transition(c, issue, 'fixed', p.userId, 'fixed_by_municipal_approval', b.reason, ', fixed_at=now()'); return { status: 'fixed' }; }
      return { status: await reopen(c, cfg, issue, p.userId, b.reason, now()) };
    });
  });
  app.post('/v1/issues/:id/override-route', async (req) => {
    const p = await auth(req); const id = parse(uuid, (req.params as any).id); const ms = await memberships(db, p.userId);
    const b = parse(z.object({ org_id: uuid, reason: z.string().trim().min(10).max(500) }).strict(), req.body);
    return tx(async (c) => {
      const issue = await lockIssue(c, id);
      if (!isMunicipalStaff(issue, ms)) throw new HttpError(404, 'Issue not found', 'not_found');
      if (['fixed', 'rejected', 'awaiting_confirmation'].includes(issue.status)) throw new HttpError(409, 'Cannot re-route in this status', 'bad_state');
      const org = (await c.query('SELECT id, kind FROM orgs WHERE id=$1', [b.org_id])).rows[0];
      if (!org) throw new HttpError(422, 'Unknown organisation', 'validation');
      const muni = issue.copy_org_id ?? issue.responsible_org_id;
      const newStatus = issue.status === 'reopened' ? 'reopened' : 'assigned'; // an in_progress issue goes back to assigned: the new org has not started
      await c.query(`UPDATE issues SET responsible_org_id=$2, responsible_kind=$3, copy_org_id=$4, route_overridden=true, route_reason=$5, updated_at=now(), status = $6::issue_status WHERE id=$1`,
        [id, org.id, org.kind, org.kind === 'municipality' ? null : muni, `Officer override: ${b.reason}`, newStatus]);
      await recordEvent(c, id, p.userId, issue.status, newStatus, 'route_override', b.reason, { to_org: org.id });
      return { ok: true };
    });
  });

  // ---------- disputes ----------
  app.post('/v1/issues/:id/dispute', async (req, reply) => {
    const p = await auth(req); const id = parse(uuid, (req.params as any).id); const ms = await memberships(db, p.userId);
    const b = parse(z.object({ reason: z.string().trim().min(10).max(1000), evidence_id: uuid.optional() }).strict(), req.body);
    const out = await tx(async (c) => {
      const issue = await lockIssue(c, id);
      const m = ms.find((x) => x.org_id === issue.responsible_org_id && (x.role === 'contractor' || x.role === 'utility'));
      if (!m) throw new HttpError(404, 'Issue not found', 'not_found');
      if (!['assigned', 'in_progress', 'reopened'].includes(issue.status)) throw new HttpError(409, 'Cannot dispute in this status', 'bad_state');
      const asg = (await c.query(`SELECT max(created_at) AS t FROM status_events WHERE issue_id=$1 AND kind IN ('routed','route_override','reopened','dispute_upheld')`, [id])).rows[0].t;
      const since = asg ? new Date(asg).getTime() : new Date(issue.created_at).getTime();
      if (now().getTime() - since > cfg.disputeWindowHours * 3600_000) throw new HttpError(409, `Dispute window (${cfg.disputeWindowHours} h) has closed`, 'window_closed');
      if (b.evidence_id) {
        const ev = await c.query(`SELECT 1 FROM evidence WHERE id=$1 AND issue_id=$2 AND kind='dispute' AND uploader_id=$3`, [b.evidence_id, id, p.userId]);
        if (!ev.rowCount) throw new HttpError(422, 'Evidence must be your own dispute photo on this issue', 'validation');
      }
      const open = await c.query(`SELECT 1 FROM disputes WHERE issue_id=$1 AND status='open'`, [id]);
      if (open.rowCount) throw new HttpError(409, 'A dispute is already open', 'dispute_open');
      const d = await c.query(`INSERT INTO disputes (issue_id, raised_by, org_id, reason, evidence_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [id, p.userId, m.org_id, b.reason, b.evidence_id ?? null]);
      await recordEvent(c, id, p.userId, issue.status, issue.status, 'dispute_raised', b.reason);
      return { dispute_id: d.rows[0].id };
    });
    return reply.status(201).send(out);
  });
  app.post('/v1/disputes/:id/decide', async (req) => {
    const p = await auth(req); const id = parse(uuid, (req.params as any).id); const ms = await memberships(db, p.userId);
    const b = parse(z.object({ decision: z.enum(['upheld', 'rejected']), reason: z.string().trim().min(10).max(500) }).strict(), req.body);
    return tx(async (c) => {
      const dp = (await c.query('SELECT * FROM disputes WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!dp) throw new HttpError(404, 'Not found', 'not_found');
      const issue = await lockIssue(c, dp.issue_id);
      if (!isMunicipalStaff(issue, ms)) throw new HttpError(404, 'Not found', 'not_found');
      if (dp.status !== 'open') throw new HttpError(409, 'Already decided', 'bad_state');
      await c.query(`UPDATE disputes SET status=$2, decided_by=$3, decision_reason=$4, decided_at=now() WHERE id=$1`, [id, b.decision, p.userId, b.reason]);
      if (b.decision === 'upheld') {
        const muni = issue.copy_org_id ?? issue.responsible_org_id;
        const dl = new Date(now().getTime() + deadlineHours(issue.severity) * 3600_000);
        await c.query(`UPDATE issues SET responsible_org_id=$2, responsible_kind='municipality', copy_org_id=NULL, route_overridden=true, route_reason=$3, deadline_at=$4, status='assigned', updated_at=now() WHERE id=$1`,
          [issue.id, muni, `Dispute upheld: ${b.reason}`, dl]);
        await recordEvent(c, issue.id, p.userId, issue.status, 'assigned', 'dispute_upheld', b.reason);
      } else await recordEvent(c, issue.id, p.userId, issue.status, issue.status, 'dispute_rejected', b.reason);
      return { status: b.decision };
    });
  });

  // ---------- admin ----------
  // Contractor/utility orgs are owned by one municipality. Same name in another city is a different org.
  async function ownedOrg(c: pg.Pool | pg.PoolClient, ownerId: string, kind: string, name: string, synthetic: boolean): Promise<string> {
    await c.query('INSERT INTO orgs (kind,name,is_synthetic,owner_org_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [kind, name, synthetic, ownerId]);
    const ex = (await c.query('SELECT id, is_synthetic FROM orgs WHERE owner_org_id=$1 AND kind=$2 AND name=$3', [ownerId, kind, name])).rows[0];
    if (ex.is_synthetic !== synthetic) throw new HttpError(409, `Organisation "${name}" already exists with a different synthetic flag`, 'conflict');
    return ex.id;
  }
  const adminMunis = async (userId: string) => (await memberships(db, userId)).filter((m) => m.role === 'admin' && m.kind === 'municipality');
  app.post('/v1/admin/orgs', async (req, reply) => {
    const p = await auth(req);
    if (!(await adminMunis(p.userId)).length) throw new HttpError(403, 'Municipal admin only', 'forbidden');
    const b = parse(z.object({ municipality_org_id: uuid, kind: z.enum(['contractor', 'utility']), name: z.string().trim().min(2).max(120), is_synthetic: z.boolean().default(false) }).strict(), req.body);
    if (!(await adminMunis(p.userId)).some((m) => m.org_id === b.municipality_org_id)) throw new HttpError(403, 'Admin of this municipality only', 'forbidden');
    const org = await ownedOrg(db, b.municipality_org_id, b.kind, b.name, b.is_synthetic);
    return reply.status(201).send({ org_id: org });
  });
  app.post('/v1/admin/memberships', async (req, reply) => {
    const p = await auth(req);
    const b = parse(z.object({ user_id: uuid, org_id: uuid, role: z.enum(['admin', 'officer', 'contractor', 'utility']) }).strict(), req.body);
    const mine = await adminMunis(p.userId);
    const org = (await db.query('SELECT id, kind, owner_org_id FROM orgs WHERE id=$1', [b.org_id])).rows[0];
    if (!org) throw new HttpError(422, 'Unknown organisation', 'validation');
    const ownedByMine = !!org.owner_org_id && mine.some((m) => m.org_id === org.owner_org_id);
    const ok = (org.kind === 'municipality' && (b.role === 'admin' || b.role === 'officer') && mine.some((m) => m.org_id === org.id))
      || (org.kind === 'contractor' && b.role === 'contractor' && ownedByMine) || (org.kind === 'utility' && b.role === 'utility' && ownedByMine);
    if (!ok) throw new HttpError(403, 'Not allowed to grant this role', 'forbidden');
    if (!(await db.query('SELECT 1 FROM users WHERE id=$1', [b.user_id])).rowCount) throw new HttpError(422, 'Unknown user', 'validation');
    await db.query('INSERT INTO memberships (user_id, org_id, role, granted_by) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, org_id, role) DO UPDATE SET revoked_at=NULL, revoked_by=NULL, granted_by=EXCLUDED.granted_by WHERE memberships.revoked_at IS NOT NULL', [b.user_id, b.org_id, b.role, p.userId]);
    return reply.status(201).send({ ok: true });
  });
  app.post('/v1/admin/memberships/revoke', async (req) => {
    const p = await auth(req);
    const b = parse(z.object({ user_id: uuid, org_id: uuid, role: z.enum(['admin', 'officer', 'contractor', 'utility']) }).strict(), req.body);
    const mine = await adminMunis(p.userId);
    const org = (await db.query('SELECT id, kind, owner_org_id FROM orgs WHERE id=$1', [b.org_id])).rows[0];
    if (!org) throw new HttpError(404, 'Not found', 'not_found');
    const scope = org.kind === 'municipality' ? org.id : org.owner_org_id;
    if (!scope || !mine.some((m) => m.org_id === scope)) throw new HttpError(403, 'Not allowed to revoke this role', 'forbidden');
    if (b.user_id === p.userId && org.kind === 'municipality') throw new HttpError(409, 'Admins cannot revoke their own municipal role', 'conflict');
    const r = await db.query('UPDATE memberships SET revoked_at=now(), revoked_by=$4 WHERE user_id=$1 AND org_id=$2 AND role=$3 AND revoked_at IS NULL', [b.user_id, b.org_id, b.role, p.userId]);
    if (!r.rowCount) throw new HttpError(404, 'Not found', 'not_found');
    return { ok: true };
  });
  const importSchema = z.object({
      municipality_org_id: uuid, source_label: z.string().trim().min(3).max(200), is_synthetic: z.boolean(),
      roads: z.array(z.object({ code: z.string().min(1).max(60), name: z.string().min(1).max(120), ward: z.string().max(60).optional(), coordinates: z.array(z.tuple([lon, lat])).min(2).max(2000) })).max(5000),
      contracts: z.array(z.object({ road_code: z.string(), contractor_name: z.string().min(2).max(120), completion_date: z.string().date(), warranty_end: z.string().date() })).max(20000).default([]),
      utility_cuts: z.array(z.object({ road_code: z.string(), utility_name: z.string().min(2).max(120), cut_date: z.string().date() })).max(20000).default([]),
    }).strict();
  async function doImport(p: Principal, b: z.infer<typeof importSchema>) {
    if (!(await adminMunis(p.userId)).some((m) => m.org_id === b.municipality_org_id)) throw new HttpError(403, 'Admin of this municipality only', 'forbidden');
    const codes = new Set<string>();
    for (const r of b.roads) { if (codes.has(r.code)) throw new HttpError(400, `Duplicate road code ${r.code}`, 'validation'); codes.add(r.code); }
    const out = await tx(async (c) => {
      const existing = (await c.query('SELECT code FROM road_segments WHERE code = ANY($1::text[])', [[...codes]])).rows;
      if (existing.length) throw new HttpError(409, `Road codes already exist: ${existing.map((e) => e.code).join(', ')}`, 'conflict');
      const ids = new Map<string, string>();
      for (const r of b.roads) {
        const wkt = 'LINESTRING(' + r.coordinates.map(([x, y]) => `${x} ${y}`).join(',') + ')';
        const ins = await c.query(`INSERT INTO road_segments (code,name,ward,municipality_org_id,geom,is_synthetic) VALUES ($1,$2,$3,$4,ST_GeogFromText($5),$6) RETURNING id`, [r.code, r.name, r.ward ?? null, b.municipality_org_id, 'SRID=4326;' + wkt, b.is_synthetic]);
        ids.set(r.code, ins.rows[0].id);
      }
      const org = (kind: string, name: string) => ownedOrg(c, b.municipality_org_id, kind, name, b.is_synthetic);
      const roadId = async (code: string) => { const id = ids.get(code) ?? (await c.query('SELECT id FROM road_segments WHERE code=$1 AND municipality_org_id=$2', [code, b.municipality_org_id])).rows[0]?.id; if (!id) throw new HttpError(400, `Unknown road_code ${code}`, 'validation'); return id; };
      for (const k of b.contracts) {
        if (k.warranty_end < k.completion_date) throw new HttpError(400, `Contract on ${k.road_code}: warranty_end before completion_date`, 'validation');
        await c.query(`INSERT INTO contracts (road_id, contractor_org_id, completion_date, warranty_end, is_synthetic) VALUES ($1,$2,$3,$4,$5)`, [await roadId(k.road_code), await org('contractor', k.contractor_name), k.completion_date, k.warranty_end, b.is_synthetic]);
      }
      for (const u of b.utility_cuts) await c.query(`INSERT INTO utility_cuts (road_id, utility_org_id, cut_date, is_synthetic) VALUES ($1,$2,$3,$4)`, [await roadId(u.road_code), await org('utility', u.utility_name), u.cut_date, b.is_synthetic]);
      await c.query(`INSERT INTO registry_imports (admin_id, org_id, source_label, is_synthetic, rows_ok) VALUES ($1,$2,$3,$4,$5)`, [p.userId, b.municipality_org_id, b.source_label, b.is_synthetic, b.roads.length + b.contracts.length + b.utility_cuts.length]);
      return { roads: b.roads.length, contracts: b.contracts.length, utility_cuts: b.utility_cuts.length };
    });
    return out;
  }
  app.post('/v1/admin/registry/import', async (req, reply) => {
    const p = await auth(req);
    return reply.status(201).send(await doImport(p, parse(importSchema, req.body)));
  });
  // CSV variant. roads: code,name,ward,coordinates ("lon lat;lon lat;..."). contracts: road_code,contractor_name,completion_date,warranty_end. utility_cuts: road_code,utility_name,cut_date.
  app.post('/v1/admin/registry/import-csv', async (req, reply) => {
    const p = await auth(req);
    const b = parse(z.object({ municipality_org_id: uuid, source_label: z.string().trim().min(3).max(200), is_synthetic: z.boolean(),
      roads_csv: z.string().max(3_000_000), contracts_csv: z.string().max(3_000_000).default(''), utility_cuts_csv: z.string().max(3_000_000).default('') }).strict(), req.body);
    let json: unknown;
    try {
      const roads = csvRows(b.roads_csv, ['code', 'name', 'ward', 'coordinates']).map((r) => ({ code: r.code, name: r.name, ward: r.ward || undefined,
        coordinates: r.coordinates.split(';').map((pt) => { const [x, y] = pt.trim().split(/\s+/).map(Number); return [x, y]; }) }));
      const contracts = b.contracts_csv ? csvRows(b.contracts_csv, ['road_code', 'contractor_name', 'completion_date', 'warranty_end']) : [];
      const utility_cuts = b.utility_cuts_csv ? csvRows(b.utility_cuts_csv, ['road_code', 'utility_name', 'cut_date']) : [];
      json = { municipality_org_id: b.municipality_org_id, source_label: b.source_label, is_synthetic: b.is_synthetic, roads, contracts, utility_cuts };
    } catch (e) { throw new HttpError(400, 'CSV error: ' + (e as Error).message, 'validation'); }
    return reply.status(201).send(await doImport(p, parse(importSchema, json)));
  });
  app.post('/v1/admin/jobs/escalate', async (req) => {
    const p = await auth(req);
    if (!(await adminMunis(p.userId)).length) throw new HttpError(403, 'Municipal admin only', 'forbidden');
    return tx((c) => runEscalations(c, cfg, now()));
  });
  app.get('/v1/admin/scorecards', async (req) => {
    const p = await auth(req);
    const ms = await memberships(db, p.userId);
    if (!ms.some((m) => (m.role === 'admin' || m.role === 'officer') && m.kind === 'municipality')) throw new HttpError(403, 'Municipal staff only', 'forbidden');
    return { scorecards: await scorecards(db, !!(await db.query('SELECT is_test FROM users WHERE id=$1', [p.userId])).rows[0]?.is_test), note: 'Counts only issues with no open dispute (PRD). Not public until legal review.' };
  });

  registerStreakRoutes(app, { cfg, db, keys });
  // Follow-up reminder pipeline: mounted only when the deployment owner enables it
  // (FOLLOWUP_PIPELINE=true) after migration 011 is applied. Off => 404 => honest client fallback.
  if (cfg.followupPipeline) registerFollowupRoutes(app, { cfg, db, keys, fetchImpl: deps.fetchImpl });

  return app;
}

async function reopen(c: pg.PoolClient, cfg: Config, issue: any, actor: string | null, reason: string, t: Date) {
  const dl = new Date(t.getTime() + deadlineHours(issue.severity) * 3600_000);
  await transition(c, issue, 'reopened', actor, 'reopened', reason, ', reopen_count=reopen_count+1, deadline_at=$2', [dl]);
  return 'reopened';
}

async function scorecards(db: pg.Pool, test: boolean) {
  const r = await db.query(
    `SELECT o.id AS org_id, o.name, o.is_synthetic,
       count(*) FILTER (WHERE i.status='fixed')::int AS fixed, count(*)::int AS total,
       COALESCE(avg(EXTRACT(EPOCH FROM (i.fixed_at - i.created_at))/3600) FILTER (WHERE i.status='fixed'),0)::float AS avg_fix_hours,
       count(*) FILTER (WHERE i.reopen_count>0)::int AS reopened
     FROM orgs o JOIN issues i ON i.responsible_org_id=o.id AND i.responsible_kind='contractor'
     WHERE i.is_test=$1 AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.issue_id=i.id AND d.status='open') GROUP BY o.id`, [test]);
  return r.rows.map((x) => ({ org_id: x.org_id, name: x.name, synthetic_data: x.is_synthetic, issues: x.total, fix_rate: x.total ? x.fixed / x.total : 0, avg_fix_hours: x.avg_fix_hours, reopen_rate: x.total ? x.reopened / x.total : 0 }));
}

/** Minimal RFC-4180 style parser: header row required, quoted fields, "" escapes. Throws with the line number on problems. */
export function csvRows(text: string, columns: string[]): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let f = ''; let q = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"' && f === '') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else f += ch;
  }
  if (q) throw new Error('unterminated quote');
  row.push(f); if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) throw new Error('empty file');
  const header = rows[0].map((h) => h.trim());
  if (header.join(',') !== columns.join(',')) throw new Error(`header must be exactly: ${columns.join(',')}`);
  return rows.slice(1).map((r, i) => {
    if (r.length !== columns.length) throw new Error(`line ${i + 2}: expected ${columns.length} columns, got ${r.length}`);
    return Object.fromEntries(columns.map((c, j) => [c, r[j].trim()]));
  });
}
