/**
 * Contractor / current-responsibility retrieval prototype (Punjab-first).
 *
 * LIVE-VERIFIED 2026-10-31 ~03:53 IST through readable GETs (markdown fetch):
 *  1. Punjab eProcurement (eproc.punjab.gov.in/nicgep):
 *     - "Tenders by Organisation" public page: NOT captcha-gated; returned 37
 *       live rows with S.No / e-Published / Closing / Opening / Title+RefNo+
 *       TenderID / Organisation Chain (e.g. 2026_CEPW_178261_1, "Balance work
 *       of special repair of various link roads ... MC Patran (Group 4)
 *       District Patiala", chain CE-PWD(B and R)||Construction Circle
 *       No.1-Patiala||Construction Division-Patiala). This is the enumerable
 *       path. NOTE: its URL carries an sp= token that may rotate.
 *     - "Latest Active Tenders" search page IS captcha-gated (verified:
 *       "Provide Captcha and click on Search button") - bulk search is NOT
 *       automatable.
 *     - Tender DETAIL pages are public direct links (verified: Tender ID
 *       2025_CEPW_137072_1, "Bid No 55 Dt. 19-03-2025", chain CE-PWD(B and
 *       R)||Construction Circle-Sangrur||Provincial Division-Sangrur).
 *     - Awarded-contractor names appear on the portal's tender-status/AOC
 *       pages; a live AOC fetch has NOT been performed yet, so contractor
 *       name retrieval is UNVERIFIED, only page availability is claimed.
 *  2. PMGSY OMMS contractor registry (omms.nic.in/MasterArea/Master/
 *     ContractorInformationLayout) - public, State dropdown includes Punjab,
 *     filters Registration Status / Contractor Status (Active/Blacklisted/
 *     Expired). Form is ASP.NET postback (ViewState); the GET page and its
 *     field structure are verified, a live POST round-trip is UNVERIFIED from
 *     this environment; re-verify from the deployment host before relying on it.
 *  3. PMGSY GRRIS National GIS (pmgsy-grris.nic.in) - live, Punjab listed;
 *     geospatial rural-road presentation over the OMMAS database.
 *
 * Honest limits (same discipline as govrecords.ts):
 *  - A tender award names the contractor for THAT work, not today's maintainer.
 *  - Absence of a result is absence of a LINKED RECORD, never of a contractor.
 *  - responsible_contractor stays 'unknown' unless a source row explicitly
 *    names one; candidates are always labelled candidates.
 */
import { HttpError } from './auth.js';

export const EPROC_PUNJAB_BASE = 'https://eproc.punjab.gov.in/nicgep/app';
export const OMMS_CONTRACTOR_REGISTRY = 'https://omms.nic.in/MasterArea/Master/ContractorInformationLayout';
export const GRRIS_HOME = 'https://pmgsy-grris.nic.in/';

export interface RetrievedRecord {
  source: 'punjab_eproc' | 'pmgsy_omms' | 'pmgsy_grris';
  source_url: string;
  fetched_at: string;
  /** Verbatim fields from the source; never normalized into claims they do not make. */
  fields: Record<string, string>;
  match_status: 'candidate';
}

export interface ContractorRetrievalResult {
  records: RetrievedRecord[];
  responsible_contractor: 'unknown';
  candidate_warning: string;
  coverage_note: string;
}

export const CANDIDATE_WARNING_EPROC =
  'Tender/award records name who won a specific work. They are candidates for historical context only - NOT proof of the current responsible party or maintenance contractor for this road.';

/** Parse one Punjab eProc tender-detail page (public GET) into verbatim fields. */
export function parseEprocTenderDetail(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const grab = (label: string) => {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\|?\\s*</t[dh]>\\s*<t[dh][^>]*>([^<]+)', 'i');
    const m = re.exec(html);
    if (m) out[label] = m[1].trim();
  };
  ['Tender Reference Number', 'Tender ID', 'Tender Type', 'Tender Category', 'Organisation Chain'].forEach(grab);
  // Title rows on list pages: "Title and Ref.No./Tender ID"
  const t = /Title[^<]*<\/t[dh]>\s*<t[dh][^>]*>([^<]{10,300})/i.exec(html);
  if (t) out['Title'] = t[1].trim();
  return out;
}

export interface EprocOrgRow {
  sno: string; published: string; closing: string; opening: string;
  title: string; ref_no: string; tender_id: string; org_chain: string;
}

/**
 * Parse the captcha-free "Tenders by Organisation" table. Rows look like:
 *   [title] [ref no][2026_CEPW_178261_1]  with an org chain cell.
 * Pure function over fetched HTML/text - unit-testable without network.
 */
export function parseEprocOrgRows(text: string): EprocOrgRow[] {
  const rows: EprocOrgRow[] = [];
  const rowRe = /\[(.{10,400}?)\]\s*\[(.{2,120}?)\]\[(\d{4}_[A-Z]{4,5}_\d{4,7}_\d)\]/gs;
  for (const m of text.matchAll(rowRe)) {
    rows.push({ sno: '', published: '', closing: '', opening: '',
      title: m[1].replace(/\s+/g, ' ').trim(), ref_no: m[2].replace(/\s+/g, ' ').trim(),
      tender_id: m[3], org_chain: '' });
  }
  return rows;
}

/**
 * Fetch the captcha-free "Tenders by Organisation" page and return one
 * candidate record per parsed row, each carrying the exact page URL it was
 * read from and the fetch time (per-record provenance for audit).
 * Throws HttpError(502) on network failure - the caller reports the source as
 * UNAVAILABLE, never fabricates rows. The page URL carries an sp= token that
 * may rotate; the caller must supply a currently valid one.
 */
export async function fetchPunjabEprocOrgTenders(pageUrl: string, fetchImpl: typeof fetch = fetch): Promise<RetrievedRecord[]> {
  const res = await fetchImpl(pageUrl, { headers: { 'user-agent': 'NagarTrace-research/0.1 (+contact: app owner)' } });
  if (!res.ok) throw new HttpError(502, `Punjab eProc fetch failed: HTTP ${res.status}`, 'upstream');
  const html = await res.text();
  if (/provide captcha/i.test(html)) throw new HttpError(502, 'Punjab eProc page is captcha-gated from this fetch path', 'upstream');
  const fetchedAt = new Date().toISOString();
  return parseEprocOrgRows(html).map((r) => ({
    source: 'punjab_eproc' as const,
    source_url: pageUrl,
    fetched_at: fetchedAt,
    fields: { 'Tender ID': r.tender_id, 'Title': r.title, 'Ref No': r.ref_no },
    match_status: 'candidate' as const,
  }));
}

/**
 * PMGSY OMMS contractor registry: the public query is an ASP.NET postback form
 * (State / Registration Status / Contractor Status). Page structure verified
 * live; the POST round-trip is NOT yet verified end-to-end, so this adapter
 * documents the mechanism and refuses to return fabricated rows.
 */
export async function queryOmmsContractorRegistry(_state: string): Promise<RetrievedRecord[]> {
  throw new HttpError(501, 'PMGSY OMMS registry adapter: ViewState postback not yet verified live; no rows returned rather than fabricated ones', 'unimplemented');
}

export function emptyRetrievalResult(note: string): ContractorRetrievalResult {
  return { records: [], responsible_contractor: 'unknown', candidate_warning: CANDIDATE_WARNING_EPROC, coverage_note: note };
}
