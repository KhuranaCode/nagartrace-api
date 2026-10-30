-- Supabase-hosted only: the Data API roles must not touch application tables.
-- NagarTrace is reached only through its own API using the nagartrace_runtime role.
-- No-op on plain Postgres where these roles do not exist.
-- Limits: default-privilege revokes cover objects created by the migration role only; objects made by other
-- roles (e.g. supabase_admin extensions) are not covered. EXECUTE granted to PUBLIC on functions is not revoked
-- (the runtime role currently gets function access through PUBLIC; tightening needs explicit runtime grants first), so keep the Supabase Data API OFF.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
