# Streaks (gamification)

Per-user activity streaks, derived from the existing points ledger. Added for the website
gamification request (streaks + real database persistence). Purely additive: one new migration,
one new module, no changes to existing tables, routes, or files.

## What counts as a streak day

A calendar day **in the user's timezone** on which at least one **positive** `points_ledger`
entry landed for them. Positive entries are written only by `awardPoints()` for:

- `verified_report` (+10) - a report on an issue that passed verification
- `first_reporter_bonus` (+5)
- `confirmed_fix` (+5)

Consequences, by design:

- **Unverified reports never move a streak.** In `officer_review` mode no points exist until an
  officer verifies, so a streak day appears only after real verification. Raw report spam cannot
  farm streaks; the existing daily report cap and daily points cap stay the upstream guardrails.
- **No separate streak write path.** Streaks are computed from the append-only ledger, so there
  is no counter a client can bump directly. All streak tables are derived caches and can be
  rebuilt from `points_ledger` at any time.
- Negative/zero ledger entries (e.g. a future false-report penalty) never credit a day.

## Semantics

- `current_streak`: length of the consecutive-day run ending at the most recent credited day,
  shown only while that day is today or yesterday (local time). Older means the streak is
  broken (`current_streak: 0`, `streak_alive: false`).
- `longest_streak`: best run ever; never decreases except after a timezone change re-buckets days.
- `milestones`: 3/7/14/30/100-day chips, derived from `longest_streak`.
- Default timezone: `Asia/Kolkata` (**ASSUMPTION** - the PRD does not define streak day
  boundaries and NagarTrace is India-focused). Users can override via
  `PATCH /v1/me/streaks/timezone` with any IANA name. Changing timezone re-derives every
  credited day from the ledger; this is honest re-bucketing, not editing history.

## API

- `GET /v1/me/streaks` - `{ timezone, current_streak, longest_streak, streak_alive,
  today_credited, last_credited_date, credited_days, recent_days (last 14), milestones, note }`.
  Lazily refreshes derived state inside one transaction before reading.
- `PATCH /v1/me/streaks/timezone` - body `{ "timezone": "Europe/London" }`; validates the IANA
  name (422 `bad_timezone` otherwise), re-buckets, returns the same shape as GET.

## Idempotence and concurrency

- `user_streaks.watermark_ledger_id` tracks the highest processed `points_ledger.id`
  (append-only `bigserial`). Re-runs process only newer rows; `user_streak_days` has
  `PRIMARY KEY (user_id, local_date)` with `ON CONFLICT DO NOTHING`.
- Refreshes take `pg_advisory_xact_lock` per user, so concurrent `GET`s stay consistent.

## Files

- `db/007_streaks.sql` - new tables `user_streak_prefs`, `user_streak_days`, `user_streaks`
  plus runtime-role grants matching the db/002 pattern. `user_streak_days` allows DELETE
  (derived cache, needed for timezone re-bucketing); `points_ledger` is untouched and stays
  append-only.
- `src/streaks.ts` - routes + pure streak math (`computeStreaks`, `addDays`, `isValidTimeZone`).
- `test/streaks.test.ts` - 9 unit tests (pure math, no DB) + 12 integration tests against real
  Postgres, gated on `STREAK_TEST_DB_URL`. The integration harness builds a minimal schema
  (users + points_ledger subsets + `db/007_streaks.sql` verbatim) because the full migration
  chain needs PostGIS; streak queries never touch geography.

## Integration steps (for the main build)

1. Apply `db/007_streaks.sql` through the normal migration runner (it is idempotent with the
   `schema_migrations` table like every other migration). Live DB apply stays with whoever owns
   deployments.
2. In `src/app.ts` `buildApp`, after the existing routes:

   ```ts
   import { registerStreakRoutes } from './streaks.ts';
   // ... inside buildApp, before `return app`:
   registerStreakRoutes(app, { cfg, db, keys });
   ```

   Optional: `registerStreakRoutes(app, { cfg, db, keys, defaultTz: 'Asia/Kolkata' })` to
   override the default; wiring it to a `POLICY_STREAK_DEFAULT_TZ` env var would match the
   repo's explicit-policy posture but is not required.
3. Website: import `StreakCard` from the new `web/src/components/StreakCard.tsx` into
   `Dashboard.tsx` (sits next to the points KPI). It calls `GET /v1/me/streaks` and renders a
   calm "unavailable" state on 404/network error, so it can ship before the API deploy catches up.
4. Run the full API suite (`npm test`) against the real PostGIS setup before deploy; this
   contribution was tested against plain Postgres only (no PostGIS available in the patch
   environment), plus typecheck (`npx tsc --noEmit`, clean).

## Known limits

- Badges at `GET /v1/me/badges` still count submitted (not verified) reports - unchanged,
  documented there. Streaks deliberately use the stricter verified-points signal instead.
- Streak state is per-user only; no public streak leaderboard is added (matches the existing
  aliases-only leaderboard posture and scorecard legal-review caution).
