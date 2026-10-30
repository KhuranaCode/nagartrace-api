-- Run by an owner/admin connection. The API connects as nagartrace_runtime (no DDL, no superuser).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='nagartrace_runtime') THEN
    CREATE ROLE nagartrace_runtime LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO nagartrace_runtime;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO nagartrace_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nagartrace_runtime;
-- append-only: no update/delete
REVOKE UPDATE ON status_events, points_ledger, escalation_events, registry_imports FROM nagartrace_runtime;
-- identity binding is immutable from the API; users.role does not exist, memberships only via admin endpoints
REVOKE UPDATE ON memberships FROM nagartrace_runtime;
-- PostGIS helper tables are readable
GRANT SELECT ON spatial_ref_sys TO nagartrace_runtime;
-- identity binding and suspension cannot be changed through the API role
REVOKE UPDATE ON users FROM nagartrace_runtime;
GRANT UPDATE (alias, ward, points) ON users TO nagartrace_runtime;
-- evidence rows are never edited
REVOKE UPDATE ON evidence, reports FROM nagartrace_runtime;
