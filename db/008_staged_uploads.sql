-- Staged photo uploads for photo-mandatory reports (product requirement: a NEW report
-- must carry a photo; a failed report transaction must not leave a photo-less issue,
-- and one user's staged photo must never bind to another user's report).
-- Flow: the client POSTs the image to /v1/uploads/stage (same normalizeImage pipeline as
-- evidence: JPEG re-encode, EXIF drop, 8 MB / JPEG / PNG / WebP checks) and receives an
-- upload id; /v1/reports then binds that id INSIDE the same transaction as issue
-- creation. Unconsumed rows expire after one hour and are lazily swept (blob included
-- when the store implements delete).
CREATE TABLE IF NOT EXISTS staged_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id uuid NOT NULL REFERENCES users(id),
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  claimed_geom geography(Point, 4326) NOT NULL,
  issue_id uuid REFERENCES issues(id),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour'
);
CREATE INDEX IF NOT EXISTS staged_uploads_sweep ON staged_uploads (expires_at) WHERE consumed_at IS NULL;

-- Runtime role: full access incl. DELETE for the lazy expiry sweep. Revokes match
-- db/005/db/007, guarded so this file is a no-op where those roles do not exist and
-- idempotent when re-run.
GRANT SELECT, INSERT, UPDATE, DELETE ON staged_uploads TO nagartrace_runtime;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON staged_uploads FROM %I', r);
    END IF;
  END LOOP;
END $$;
