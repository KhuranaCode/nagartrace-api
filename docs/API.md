# NagarTrace API contract (DRAFT v0.1 - to be agreed with the frontend, not final)

Base: `/v1`. JSON in and out unless noted. Auth: `Authorization: Bearer <JWT>` (issuer and audience set by deployment config; provider not chosen yet). Errors: `{ "error": "<code>", "message": "..." }`. All unknown body fields are rejected (400).
Status values: `reported, verified, assigned, in_progress, awaiting_confirmation, fixed, reopened, rejected`. Hazards: `pothole, crack, waterlogging, broken_edge, missing_cover, other`.
Rate limits apply. Where a record is hidden from you the API returns 404, not 403.

## Public (no login)
- `GET /public/issues?status=&ward=&limit=` -> `{issues:[PublicIssue]}`
- `GET /public/issues/:id` -> PublicIssue
- `GET /public/scorecards` -> 404 until enabled (legal review pending)
PublicIssue: `id, hazard, status, severity, ward, location{lat,lon (rounded ~11 m)}, responsible{kind,name,synthetic_data}|null, deadline_at, reports_count, route_flags[], created_at, updated_at`. No reporter, no photos.
Show a "Synthetic data" badge when `responsible.synthetic_data` is true. `route_flags` may contain `road_not_in_registry`, `needs_manual_routing`.
Authenticated issue DTO (`/issues`, `/issues/:id`) = PublicIssue plus detail fields and `test_data: boolean`. The public DTO never carries `test_data` (public endpoints list genuine data only). `GET /me` returns the caller's own `is_test` and memberships `{org_id, kind, role, synthetic, ...}`. See `docs/DATA_SEPARATION.md`.

## Me
- `GET /me` -> `{id, alias, ward, points, memberships:[{org_id, role, kind}]}` (the first call creates the account as a plain citizen)
- `PATCH /me` `{alias?, ward?}`

## Citizen
- `POST /reports` (header `Idempotency-Key` optional) `{lat, lon, accuracy_m?, hazard, danger?, note?, captured_at (ISO, within 15 min)}` -> 201 new issue / 200 merged or replayed: `{report_id, merged_into_existing, replayed, issue:Issue}`. Errors: 422 `stale_report|poor_gps`, 409 `already_reported`, 429 `daily_cap`.
- `POST /issues/:id/evidence?kind=report|after|dispute&lat=&lon=` body: raw image bytes (`image/jpeg|png|webp`, max 8 MB). Returns `{evidence_id, location_ok}`. `report`: reporters only. `after`/`dispute`: assigned organisation only. 422 `location_mismatch` if more than 50 m from the issue (not for `dispute`).
- `GET /issues?status=&limit=` your issues (or your organisation's). `GET /issues/:id` -> Issue + `events[]` (audit trail) + `evidence[]` metadata. `GET /issues/:id/evidence/:eid` -> image bytes (participants only).
- `POST /issues/:id/confirm` `{is_fixed}` while `awaiting_confirmation`. Reporters only, one vote per round. Returns `{status}`.
- `GET /leaderboard?ward=&period=weekly|all` -> aliases and points.
Issue: PublicIssue fields plus exact `location`, `danger_flag`, `route_reason`, `route_overridden`, `reopen_count`, `fixed_at`, `copy_org`.

## Contractor / utility (assigned organisation)
- `POST /issues/:id/start`
- `POST /issues/:id/evidence?kind=after...` then `POST /issues/:id/submit-repair {evidence_id}` (needs your own after-photo with a passing location check)
- `POST /issues/:id/dispute {reason (10+ chars), evidence_id?}` within 48 h of assignment. 201 `{dispute_id}`.

## Municipal officer / admin
- `POST /issues/:id/municipal-decision {decision: approve|reject, reason (10+ chars)}` while `awaiting_confirmation`.
- `POST /issues/:id/override-route {org_id, reason (10+ chars)}`
- `POST /disputes/:id/decide {decision: upheld|rejected, reason (10+ chars)}`
- `GET /admin/scorecards` (not public)
Admin only: `POST /admin/orgs {kind, name, is_synthetic?}`, `POST /admin/memberships {user_id, org_id, role}`, `POST /admin/registry/import {municipality_org_id, source_label, is_synthetic, roads[{code,name,ward?,coordinates[[lon,lat]...]}], contracts[{road_code,contractor_name,completion_date,warranty_end}], utility_cuts[{road_code,utility_name,cut_date}]}`, `POST /admin/jobs/escalate`.

## Not yet in the contract
CSV upload, notifications, badges, public scorecards, photo display on public pages (needs redaction first), pagination cursors, hosted base URL, login/signup flow (depends on the auth provider decision).


## Addendum (6 PM)
### POST /v1/admin/registry/import-csv
Municipality admin only. JSON body: municipality_org_id, source_label, is_synthetic, roads_csv, contracts_csv, utility_cuts_csv (strict headers, quoted fields, per-row errors, all-or-nothing).
### Policy gate
GET /health shows policy "PROVISIONAL-dev-defaults-not-for-real-use" unless set explicitly. Behaviour values may change once the open decisions are agreed; do not hard-code them in the client.

### More endpoints (draft, to be agreed)
- POST /v1/issues/:id/accept - assignee (contractor/utility/officer/admin of the responsible org) acknowledges an assigned or reopened issue. Idempotent. Records an "accepted" event, status unchanged. 409 in other states.
- GET /v1/issues?responsible=municipality|contractor|utility and GET /v1/public/issues?responsible=... - filter by responsible party (also status, ward on public). Bad value gives 400.
- GET /v1/me/badges - First Report (1 report), Road Guardian (10 reports), Fix Checker (10 fix confirmations), Ward Champion (top all-time points in own ward). Derived live; not awardable by clients. Counts submitted reports because there is no verification or false-report step yet.
- CORS: only origins in CORS_ORIGINS (comma-separated, exact match). Bearer tokens, no cookies. Set TRUST_PROXY=true only behind a trusted proxy, or rate limits see the proxy address.

## Verify (provisional)
`POST /v1/issues/:id/verify` body `{decision:"verify"|"reject", reason}`; municipal officer/admin of review org only, issue must be `reported`. Intake responses in officer_review mode show status `reported` with no responsible org.

## Machine-readable draft
`docs/openapi.json` (OpenAPI 3.0, DRAFT v0.2) lists every route; a test fails if routes and this file drift. Unknown routes return `{error:"not_found"}`; malformed JSON 400; bodies over 10 MB 413.

## Recent changes (API is still a DRAFT)
- `POST /v1/admin/orgs` now needs `municipality_org_id` (you must administer it). Contractor/utility orgs are owned by one municipality; the same name in another city is a different org.
- `POST /v1/admin/memberships`: contractor/utility roles only for orgs owned by your own municipality. `POST /v1/admin/memberships/revoke {user_id, org_id, role}` revokes (soft, history kept). You cannot revoke your own municipal role.
- Unrouted pending report (no municipality chosen, several exist): visible without photos to all municipal officers/admins in `GET /v1/issues` and `GET /v1/issues/:id`; `POST /v1/issues/:id/claim-review {org_id?, reason}` makes your municipality the reviewer (assigns nothing). WHO should own such reports is an OPEN policy decision.
- A severity increase from a merged duplicate shortens the deadline from the assignment time, never extends it. `override-route` records the real status change (in_progress becomes assigned).

### Unrouted-report triage is OFF by default
`POST /v1/issues/:id/claim-review` and the shared view of unrouted reports only work when `POLICY_UNROUTED_TRIAGE=any_municipal_staff` (provisional, synthetic-demo use; `/health` shows `unrouted_triage`). Default `off`: such reports are visible only to their reporters and need an operator to decide ownership. In triage the viewer gets public-level fields only (rounded location, `triage_only:true`, no events, evidence, reporter or danger flag) until their municipality claims it.


## Dispute ids and org ids (local change, not yet committed)
`GET /v1/issues/:id` returns `disputes[]` (id, status, reason, org_id, evidence_id, created_at, decided_at, decision_reason) only to staff of the responsible or copy organisation. Reporters, other organisations and public routes never get dispute ids. The authenticated issue view (not public) also carries `responsible_org_id`, `copy_org_id`, `review_org_id`.
