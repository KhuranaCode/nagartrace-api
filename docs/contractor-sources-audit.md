# Contractor retrieval - source audit trail (2026-10-31, ~03:47-03:54 IST)

All fetches were public readable GETs, no login, no scraping of private data.
Server-side fetching from the eventual deployment host is UNTESTED and must
be re-verified there.

## S1. Punjab eProcurement - enumerable tender list (CAPTCHA-FREE)
- URL fetched: https://eproc.punjab.gov.in/nicgep/app?component=$DirectLink&page=FrontEndTendersByOrganisation&service=direct&sp=S4fOW%2By4lfko37f6uDHrBBw%3D%3D
- Fetched: 2026-10-31 ~03:53 IST. Result: 37 live rows, fields per row:
  S.No | e-Published Date | Closing Date | Opening Date | [Title] [RefNo]
  [TenderID] | Organisation Chain.
- Road-relevant verbatim examples:
  - 2026_CEPW_178261_1 "Balance work of special repair of various link roads
    under special repair program 2022-23,2023-24 and 2024-25 including 5 year
    routine maintenance in MC Patran (Group 4) District Patiala"
    [Bid no. 17/2 dated 23.10.2026] - CE-PWD(B and R)||Construction Circle
    No.1-Patiala||Construction Division-Patiala
  - 2026_CEPW_178042_1 "Preparation of Detailed Project Report for
    Rehabilitation/Upgradation of 2-Lane to 4 Laning of Patiala Samana Patran
    Road SH 10 ..." - same Patiala chain
- Caveat: the sp= URL token may rotate; parser is pinned to the row shape by
  test/contractor-retrieval.test.ts using verbatim live rows.
- These are ACTIVE tenders (bidding stage). They name the executing division
  but NOT a contractor: no award has happened for these rows.

## S2. Punjab eProcurement - tender DETAIL page (public direct link)
- URL fetched: https://eproc.punjab.gov.in/nicgep/app?component=$DirectLink&page=FrontEndLatestActiveTenders&service=direct&sp=SP9SiiQ2%2FBqcUO3IIoDCJvQ%3D%3D
- Fetched: 2026-10-31 ~03:48 IST. Resolved to detail of Tender ID
  2025_CEPW_137072_1 "Bid No 55 Dt. 19-03-2025", chain CE-PWD(B and R)||
  Construction Circle-Sangrur||Provincial Division-Sangrur; fee/EMD/cover
  structure visible. Proves per-tender detail pages are public.

## S3. Punjab eProcurement - "Latest Active Tenders" search (CAPTCHA-GATED)
- URL fetched: https://eproc.punjab.gov.in/nicgep/app?page=FrontEndLatestActiveTenders&service=page
- Fetched: 2026-10-31 ~03:53 IST. Result: "Provide Captcha and click on
  Search button to list all active tenders." Bulk search is NOT automatable.
  Use S1 for enumeration instead.

## S4. Awarded-contractor names (AOC / tender status) - UNVERIFIED
- The portal has public award-of-contract/tender-status pages in the same
  app, but no live AOC fetch was performed in this audit. Retrieving an
  actual awarded contractor name is therefore UNVERIFIED; the adapter never
  returns a contractor name until that path is exercised and pinned by test.
- Even when verified: an award names the contractor for THAT work and period,
  not today's responsible maintainer. Semantics stay candidates-only.

## S5. PMGSY OMMS contractor registry (form-verified, POST unverified)
- URL: https://omms.nic.in/MasterArea/Master/ContractorInformationLayout
- Fetched: 2026-10-31 ~03:47 IST. Public form: State (Punjab present),
  Registration Status, Contractor Status (Active/Inactive/Blacklisted/
  Expired). ASP.NET ViewState postback; a live POST round-trip was NOT
  performed. Adapter returns 501 until verified - never fabricated rows.
- Note: omms.nic.in header says OMMAS application services are redirecting to
  https://pmgsy.dord.gov.in (that portal returned a fetch error in this
  audit). Migration risk for this source.

## S6. PMGSY GRRIS National GIS (live)
- URL: https://pmgsy-grris.nic.in/ fetched 2026-10-31 ~03:48 IST. Punjab
  listed; geospatial rural-road presentation over live OMMAS data. Useful for
  road-level drill; no API contract documented yet.
