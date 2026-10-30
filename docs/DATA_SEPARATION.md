# Test data vs genuine data (built, tested locally; NOT applied to the live database)

Two cohorts, kept apart in the API. Self-checks only; no independent review of this doc's claims yet.

- `users.is_test` / `issues.is_test`: fixture (synthetic-login) data. `orgs.is_synthetic`: fixture organisations.
- A report inherits `is_test` from its reporter. Duplicate merge only happens within the same cohort.
- Public endpoints (`/v1/public/issues`, `/v1/public/issues/:id`, `/v1/public/scorecards`): only genuine data (`NOT is_test`). The public issue DTO has no `test_data` field and the public allowlist is unchanged.
- Authenticated issue DTO (`/v1/issues`, `/v1/issues/:id` and the other full-DTO responses): adds `test_data: boolean`. Visible only to people who can already see that issue.
- `/v1/me`: returns the caller's own `is_test` flag and their memberships (each now with `synthetic`). Own data only.
- Leaderboard: a caller sees only their own cohort.
- `/v1/admin/scorecards` (municipal staff): the caller's cohort. `/v1/public/scorecards`: genuine only, and 404 unless public scorecards are enabled in config.
- Unrouted triage (`POLICY_UNROUTED_TRIAGE=any_municipal_staff`, default off): cohort guard. Municipal staff of a synthetic org can only list/read/claim fixture issues, staff of a real org only genuine ones. Claiming into an org of the other cohort returns 404.

Known limits: the flags are an operational label, not a security boundary against a malicious admin. Photos and GPS stay private. See `ops_backfill_fixtures.sql` (kept outside the repo) for the live backfill plan.
