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
