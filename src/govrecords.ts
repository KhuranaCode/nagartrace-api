/**
 * Official government-record linkage.
 *
 * Sources and their honest limits:
 *  - road_registry_staging (009): real road geometry from OSM (ODbL). Coverage is PARTIAL
 *    (only loaded extracts). jurisdiction_status stays 'unresolved' until a real boundary
 *    source assigns it; the raw OSM operator tag is NOT a verified maintainer and is never
 *    served as one.
 *  - nhai_award_records (010): verbatim NHAI "Awarded Projects FY2024-25" PDF rows
 *    (nhai.gov.in). Historical snapshot of that FY only. Rows carry match_status='unmatched'
 *    by constraint: the table itself never claims a join. The ONLY join made here is the
 *    exact NH-number token between the nearest staged road's ref and the award's
 *    nh_from_name. Chainage-level point matching is not available from the source, so all
 *    awards on that NH are listed with their exact official section text.
 * Absence of a match is always reported as absence of a LINKED RECORD, never as absence of
 * a road, a contractor, or a maintainer.
 */
import type pg from 'pg';
import { HttpError } from './auth.js';

const NEAREST_ROAD_RADIUS_M = 200; // engineering threshold for point-to-road lookup

/** Extract normalized NH number tokens from an OSM ref ('NH-44', 'NH44;NH-48', '44' -> ['44','48']). */
export function nhTokens(ref: string | null | undefined): string[] {
  if (!ref) return [];
  const out = new Set<string>();
  for (const part of ref.split(/[;,/\s]+/)) {
    const m = /^NH-?(\d{1,3}[A-Z]{0,2})$/i.exec(part.trim()) ?? /^(\d{1,3})$/.exec(part.trim());
    if (m) out.add(m[1].toUpperCase());
  }
  return [...out];
}

export const CANDIDATE_WARNING = 'Possible historical award candidates only - NOT this report\'s verified contractor or current responsible party. The source has no chainage-level resolution, so every FY2024-25 NHAI award on this highway is listed.';

export interface OfficialRecords {
  road: null | {
    name: string | null; ref: string | null; road_class: string | null; distance_m: number;
    source: string; source_label: string; attribution: string;
    jurisdiction_status: string; maintainer: 'unknown';
  };
  /** Verbatim award rows on the nearest road's NH token. Candidates, never an assignment. */
  candidate_awards: unknown[];
  /** Prominent semantics label - must stay beside the candidates, never buried. */
  candidate_warning: string;
  /** Always 'unknown': no source links a contractor to this report. Never promote candidates here. */
  responsible_contractor: 'unknown';
  coverage_note: string;
}

export async function officialRecordsForPoint(db: pg.Pool | pg.PoolClient, lat: number, lon: number): Promise<OfficialRecords> {
  const pt = `ST_SetSRID(ST_MakePoint($2,$1),4326)::geography`;
  const road = await db.query(
    `SELECT name, ref, road_class, source, source_label, attribution, jurisdiction_status,
            ROUND(ST_Distance(geom, ${pt}))::int AS distance_m
     FROM road_registry_staging
     WHERE ST_DWithin(geom, ${pt}, ${NEAREST_ROAD_RADIUS_M})
     ORDER BY geom <-> ${pt} LIMIT 1`, [lat, lon]);
  const r = road.rows[0];
  if (!r) {
    return { road: null, candidate_awards: [], candidate_warning: '', responsible_contractor: 'unknown', coverage_note: 'No staged road geometry within 200 m of this report. Geometry coverage is partial (loaded OSM extracts only); this says nothing about whether an official road record exists.' };
  }
  const roadDto = {
    name: r.name, ref: r.ref, road_class: r.road_class, distance_m: r.distance_m,
    source: r.source, source_label: r.source_label, attribution: r.attribution,
    jurisdiction_status: r.jurisdiction_status, maintainer: 'unknown' as const, // until a boundary source resolves it
  };
  const tokens = nhTokens(r.ref);
  if (!tokens.length) {
    return { road: roadDto, candidate_awards: [], candidate_warning: '', responsible_contractor: 'unknown', coverage_note: `Nearest staged road${r.name ? ` (${r.name})` : ''} has no national-highway reference, so no NHAI award record is linked to it. That does not rule out an award existing outside this catalog. Municipal/rural maintainer records are not linked yet; the maintainer stays unknown.` };
  }
  const a = await db.query(
    `SELECT sr, project_name, state, length_km, loa_date, awarded_cost_cr, piu, mode,
            contractor_name, project_stage, project_type, chainage_km_marks, nh_from_name, page, source_url, source_label
     , 'candidate' AS match_status FROM nhai_award_records WHERE nh_from_name && $1::text[] ORDER BY state, sr`, [tokens]);
  if (!a.rowCount) {
    return { road: roadDto, candidate_awards: [], candidate_warning: '', responsible_contractor: 'unknown', coverage_note: `No FY2024-25 NHAI award record is linked to ${tokens.map((t) => 'NH-' + t).join(' / ')} in this catalog. Coverage is NHAI awarded projects FY2024-25 only; an award may exist outside this catalog.` };
  }
  return {
    road: roadDto,
    candidate_awards: a.rows,
    candidate_warning: CANDIDATE_WARNING,
    responsible_contractor: 'unknown',
    coverage_note: `Official NHAI FY2024-25 award record(s) on ${tokens.map((t) => 'NH-' + t).join(' / ')}. Chainage-level point matching is not available from the source; every record for the highway is listed with its exact official section text. The responsible contractor for this report is UNKNOWN. Awarded costs are verbatim from the source PDF.`,
  };
}

export async function nhaiAwardsBrowse(db: pg.Pool | pg.PoolClient, q: { state?: string; nh?: string; limit: number }) {
  if (q.nh !== undefined) {
    const raw = q.nh.trim().replace(/^nh[-\s]?/i, '');
    if (!/^\d+[A-Za-z]{0,2}$/.test(raw)) throw new HttpError(400, 'Invalid nh filter: expected a national-highway number like 44', 'validation');
    if (!nhTokens(q.nh).length) throw new HttpError(400, 'Invalid nh filter: expected a national-highway number like 44', 'validation');
  }
  const nh = q.nh ? nhTokens(q.nh) : null;
  const r = await db.query(
    `SELECT sr, project_name, state, length_km, loa_date, awarded_cost_cr, piu, mode,
            contractor_name, project_stage, project_type, chainage_km_marks, nh_from_name, page, source_url, source_label
     FROM nhai_award_records
     WHERE ($1::text IS NULL OR lower(state)=lower($1)) AND ($2::text[] IS NULL OR nh_from_name && $2)
     ORDER BY sr LIMIT $3`, [q.state ?? null, nh && nh.length ? nh : null, q.limit]);
  const total = (await db.query('SELECT count(*)::int AS c, min(source_label) AS sl FROM nhai_award_records')).rows[0];
  return {
    awards: r.rows,
    dataset: { rows: total.c, source_label: total.sl, coverage: 'NHAI Awarded Projects FY2024-25 (historical snapshot)', anomaly_note: 'One source row (sr 20) carries an apparent unit error in awarded_cost_cr, kept verbatim; treat aggregates with care.' },
  };
}
