# Current-responsibility finder - design note (LOCAL, unshipped)

## What the user actually wants
"Find the CURRENT responsible contractor for this road / area / report" - not an award-history
search. The shipped contractor brief (NHAI FY2024-25 registry) is a history tool and stays
labeled that way; it never names a current responsible party.

## What already exists (verified in code)
- `road_registry_staging` (db 009): OSM/PMGSY road geometry, `ref`, `operator` (raw, unverified),
  `jurisdiction_status` (unresolved/urban_resolved/rural_unmapped), `municipality_org_id`
  (set only by boundary containment).
- `nhai_award_records` (db 010): FY2024-25 NHAI awards, section text verbatim, no chainage matching.
- `src/govrecords.ts`: nearest-staged-road resolution (200 m), NH-ref token extraction, candidate
  award linkage by highway, and it ALWAYS returns `responsible_contractor: 'unknown'` with an
  explicit coverage note. This is the honest core to build on.
- Issue routing (`route_reason` on issues) decides owner CLASS (utility cut / contractor under
  warranty / city) per the guide corpus - a class, not a named party.

## What a real "current responsible" answer requires (all missing today)
1. A verified maintainer registry: who maintains which stretch NOW (PIU/DLP data for NHAI,
   municipal ward-level maintenance records for city roads). No source ingested.
2. Chainage-level matching: point-on-stretch, not highway-level candidate listing.
3. Defect-liability/warranty windows per award: whether the contractor is still liable today.
4. Org resolution coverage: most roads are `jurisdiction_status='unresolved'`.

## Proposal
- Phase 1 (honest, shippable when the lane opens): expose the existing resolution as
  "Responsibility evidence" on issue detail: nearest staged road (name/ref/class), jurisdiction
  status, municipality when boundary-resolved, NHAI candidate awards with the existing verbatim
  warning. NEVER asserts THE contractor; 'unknown' is a first-class answer with its reason.
- Phase 2 (data-dependent, peer/owner decisions): maintainer registry ingestion, DLP windows,
  chainage matching. Only then may the UI say "current responsible" - with source citation.
- AI's role stays advisory: summarize retrieved registry rows; retrieval boundary unchanged
  (backend rows only, zero rows short-circuit, record-count-exact validation).

## Explicit non-goals for phase 1
No naming a responsible party from award records alone; no complaint-to-contractor linkage;
no scraping of live sources at request time.
