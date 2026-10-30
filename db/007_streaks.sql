-- Streaks / engagement progress (website gamification request).
-- Every streak number here is DERIVED from points_ledger (the append-only source of truth) and can be
-- rebuilt from it at any time. A "streak day" is credited only when a POSITIVE points_ledger entry lands
-- for the user: verified_report, first_reporter_bonus, confirmed_fix. Those are written only after the
-- existing verification flow and daily points cap (awardPoints in src/domain.ts), so raw report spam or
-- unverified submissions can never credit a streak day. There is no separate streak write path to abuse.

-- Per-user streak preferences. Kept out of the users table so this migration stays purely additive.
CREATE TABLE IF NOT EXISTS user_streak_prefs (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  -- IANA timezone name (e.g. 'Asia/Kolkata'), validated by the API before every write.
  -- Streak day boundaries are calendar days in THIS timezone, not UTC.
  tz text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Derived cache: one row per user per credited local day. Rebuilt from points_ledger when the
-- timezone changes, hence DELETE is granted to the runtime role (unlike the ledger itself).
CREATE TABLE IF NOT EXISTS user_streak_days (
  user_id uuid NOT NULL REFERENCES users(id),
  local_date date NOT NULL,
  first_ledger_id bigint NOT NULL REFERENCES points_ledger(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, local_date)
);

-- Derived cache: materialized streak state per user. Recomputed from a FULL scan of the user's
-- positive ledger rows on every refresh (a MAX(id) watermark would skip late-committing lower-id
-- rows); watermark_ledger_id is kept for observability only and no correctness depends on it.
CREATE TABLE IF NOT EXISTS user_streaks (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  current_streak integer NOT NULL DEFAULT 0,
  longest_streak integer NOT NULL DEFAULT 0,
  credited_days integer NOT NULL DEFAULT 0,
  last_credited_date date,
  -- Observability only: highest positive ledger id seen at last refresh. NOT a processing
  -- watermark - refresh always re-derives from the full ledger, so commit order cannot lose rows.
  watermark_ledger_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Match the runtime-role grant pattern from db/002_runtime_role.sql (blanket grants there only cover
-- tables that existed at the time). user_streak_days is derived cache, so DELETE is allowed for
-- timezone re-bucketing; points_ledger stays append-only and untouched.
GRANT SELECT, INSERT, UPDATE ON user_streak_prefs, user_streaks TO nagartrace_runtime;
GRANT SELECT, INSERT, DELETE ON user_streak_days TO nagartrace_runtime;

-- Idempotence: CREATE TABLE IF NOT EXISTS above plus plain GRANT/REVOKE make the whole file safe
-- to re-run even where the migration runner does not skip already-applied files.

-- Match db/005_revoke_supabase_api_roles.sql: the Supabase Data API roles must never touch these
-- tables. 005's REVOKE ALL ON ALL TABLES covered only tables that existed when it ran, and its
-- ALTER DEFAULT PRIVILEGES applies only to objects created by the role that ran it - so rather
-- than rely on that chain, revoke explicitly here (verifiable per migration). No-op on plain
-- Postgres where these roles do not exist.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON user_streak_prefs, user_streak_days, user_streaks FROM %I', r);
    END IF;
  END LOOP;
END $$;
