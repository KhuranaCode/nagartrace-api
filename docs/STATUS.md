# NagarTrace API - status

Backend built from the NagarTrace product requirements (v1.0). Not production-ready. Policy values the requirements leave open are provisional config.

## What exists and is tested (51 tests (api + hardening + findings + contract), real PostgreSQL 14 + PostGIS 3.2, API connects as a restricted DB role)
- Token verification: issuer, audience, expiry, signature, algorithm allowlist. Identity = (issuer, subject). Roles come only from the database. Self-grant attempts (token claims, profile fields, admin endpoints) tested.
- Reports: photo-less intake with GPS/time/accuracy checks, per-user daily cap, idempotency key, duplicate merge within 30 m (same hazard type), concurrent-report test (6 parallel -> 1 issue).
- Routing per PRD order: unknown road -> municipality + flag; recent utility cut -> utility (beats warranty); warranty -> contractor, municipality copied; else municipality. Deadlines 7 d / 48 h (severity >= 4).
- Registry import (JSON), all-or-nothing, validated, scoped to the municipality admin. `is_synthetic` flag carried to API responses.
- Repair flow: start, location-checked after-photo, submit, citizen confirmations (reporters only, not staff, one vote per round, account-age gate), 2 confirmations -> Fixed, 2 rejections -> Reopened with reset deadline, municipal approve/reject with required reason.
- Disputes: 48 h window, one open dispute, officer decision (upheld re-routes to municipality), evidence ownership.
- Officer route override with required reason.
- Escalation: records level 1 (engineer) and level 2 (department head) idempotently. Nothing is sent.
- Audit trail and points ledger are append-only (enforced by DB triggers and role grants; tested).
- Points with daily cap. Public endpoints expose no reporter, evidence or exact coordinates (rounded ~11 m). Scorecards disabled publicly by default (legal review is a PRD open question).
- Image uploads: content sniffing, bounded decode, JPEG re-encode, metadata stripped. Private; never public.

## Not built / not claimed
- Hosting, hosted auth provider, object storage (local-disk store only), backups, monitoring.
- Face/number-plate blur (no evaluated mechanism). Re-encoding is not redaction. Photos stay private.
- Weekly ward leaderboard polish, "false report" penalty (-10), report rejection flow, offline queue, email/SMS/in-app notifications, filters by responsible party, map tiles, hotspot analytics, AI suggestions.
- Severity does not use road type (not in the data model).
- Real registry/authority data. All test data is synthetic.

## Assumptions the PRD does not settle: PROVISIONAL, block production
Every value is a POLICY_* env var; NODE_ENV=production refuses to start on dev defaults. CSV import: POST /v1/admin/registry/import-csv. Full gap list: docs/PRD_GAP_LIST.md.

Values:
Auto-verification by checks; 25 m road match; 90-day "recent" utility cut; 50 m evidence radius; 15-minute report freshness; 100 m max GPS accuracy; 10 reports/day; 50 points/day; 48 h between escalation levels; confirmers = original reporters, account age >= 24 h (anti-abuse, not independent-resident proof).

## Gates before anything is called live
Hosted DB + auth provider, S3-compatible storage, real end-to-end test on the hosted URL (roles, permissions, uploads), privacy review for photos, a real registry source, and decisions on the open policy questions.

## Run locally
Needs PostgreSQL with PostGIS. `ADMIN_DATABASE_URL=... npm run migrate`, then `npm test` (set TEST_OWNER_URL to a superuser connection).

## Verification policy (provisional)
- Default `POLICY_VERIFICATION_MODE=officer_review`: intake leaves the issue `reported`, stores only a routing SUGGESTION (event `routing_suggested`), no responsible org, no deadline, no points.
- `POST /v1/issues/:id/verify {decision: verify|reject, reason>=10 chars}` - only a municipal officer/admin of the review org. Verify assigns the suggested routing, starts the clock, awards deferred points. Reject: status `rejected`.
- `auto_checks` exists only as an explicit operator option; plausible GPS/time is never proof of a real pothole. Production blocker until the team agrees who verifies.
- Not defined: escalation of issues never verified.


## Recent changes
Contractor/utility orgs are owned by one municipality (grants and revokes tested). Unrouted reports stay `reported`; the shared triage/claim path is OFF by default (`POLICY_UNROUTED_TRIAGE`). A severity increase on a merged duplicate shortens the deadline, never extends it. `override-route` records the real transition. CSV import caps fit the body limit and the Docker image runs as a non-root user (Docker not yet tested).
