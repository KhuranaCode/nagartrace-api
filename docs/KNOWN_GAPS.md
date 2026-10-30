# Known gaps against the product requirements

Method: PRD v1.0 text read line by line against src/app.ts routes, db schema and docs/API.md. 51 passing tests are NOT a completeness claim. Not a security certification.

## Built and covered by a test
Photo-less report with GPS/time checks; duplicate merge (30 m); routing order (registry, utility cut, warranty, municipality) with registry flag; 7 d / 48 h deadlines; status flow to Fixed; 2 confirmations; reject -> Reopened with reset deadline; dispute with 48 h window and officer decision; override with reason; escalation records (engineer, then head); points ledger +10/+5/+5 with cap; public status page and aliases-only leaderboard; JSON and CSV registry import; synthetic-data flag; append-only audit trail (DB role tested); evidence private to participants.

## Gaps against the PRD (not built)
| PRD item | State |
|---|---|
| Photo on report ("snap") | Report endpoint takes no photo; evidence upload is a separate step. Frontend flow needs agreeing. |
| Report rejected as false, -10 points | NOT built. PRD does not say who decides. Open decision. |
| Badges | Built as derived values (GET /v1/me/badges). Counts submitted reports since there is no verification step. |
| Email and SMS notices to contractor | NOT built. Only in-app data; escalation is recorded, never sent. |
| Contractor inbox "accept" | Built (POST /v1/issues/:id/accept), tested. |
| Severity uses road type | Not possible: no road type in the data model. |
| Filters by responsible party (P1) | Built (?responsible=). |
| Offline queue (P1) | Client-side; API has idempotency keys to support it. |
| Hotspot analytics, photo hazard suggestion (P2) | Not built. |
| Face / number-plate blur | No evaluated mechanism. Photos stay private. |
| Object storage | Local disk, plus S3 adapter (SigV4). Mock-tested, and one upload/read/denial run against Supabase Storage (private bucket) on synthetic data. Supabase S3 access keys are project-wide (all buckets, bypass RLS), so keep them server-only. |
| Per-contract configurable warranty/deadline (open question) | Not built; deadlines are global config. |
| Municipality can change deadlines | Not built. |
| Hosting, hosted auth, backups, monitoring | Not done. |
| Under-30-second report goal, success metrics | Not measured. |

## Provisional policy (blocks production until agreed)
All values are POLICY_* env vars. The app refuses to start with NODE_ENV=production unless every one is set explicitly and POLICY_SPOOF_RESIDENCY_ACK is given. Dev defaults show "PROVISIONAL" in /health. Open choices: 90-day utility-cut window, reporters-only confirmation, 2 confirmations to close and rejections to reopen, points cap, report limits, 25 m road match, 50 m evidence radius, escalation delay.

## Known limits
- Two accounts are not independent-resident proof. Account-age gate only slows abuse.
- GPS/time come from the client and can be spoofed; checks are plausibility only. Photo metadata does not prove a repair.
- Rate limits are per-process in memory; a multi-instance deploy needs a shared store.
- Tests ran on one local PostgreSQL 14 only; nothing hosted.

- Auto-verification vs officer review: OPEN, user decision needed. Escalation for never-verified reports: undefined.

## Owner-scoped reads: operational consequences (2026-10-31)
- Dispute discoverability: municipal staff no longer see dispute ids/reasons in `GET /v1/issues/:id` (owner-only payload). `POST /disputes/:id/decide` still authorises municipal staff, but staff currently have no in-API way to learn a dispute id. If staff adjudication is meant to continue, a follow-up should add a narrow staff-visible "open dispute exists" signal or route decisions through the owner. Deliberate trade-off of the settled policy, flagged for the reviewer.
- Evidence metadata list (`evidence[]` on the issue detail) is owner-only; uploaders learn their evidence ids from the upload/report responses.
- Reporters and staff no longer receive precise coordinates or route narrative on their own issues; the client must render the minimal public payload.
- Public candidate linkage removed: `/v1/public/issues/:id` no longer serves `official_records` (complaint-linked NHAI candidate associations) to anyone but the owner; only the standalone historical catalog `/v1/public/gov-records/nhai-awards` remains public. Clients that rendered candidates on the public issue page lose that block.
- `PUBLIC_SCORECARDS=true` is now an owner-preview, not a public feature: the route authenticates softly and serves only the exact owner principal (404 for everyone else, same as disabled). A genuinely public scoreboard would need a non-targeting aggregate redesign the owner approves.
- Public map minimisation (peer blocker 2026-10-31): PublicIssue no longer carries the assigned organisation's name, the assignment deadline, or route flags - only the responsible KIND remains. Clients that showed "assigned to <contractor>", due dates, or routing flags on public/non-owner views lose them; the owner view restores them.
