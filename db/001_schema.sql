CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE org_kind AS ENUM ('municipality','contractor','utility');
CREATE TYPE member_role AS ENUM ('admin','officer','contractor','utility');
CREATE TYPE hazard_type AS ENUM ('pothole','crack','waterlogging','broken_edge','missing_cover','other');
CREATE TYPE issue_status AS ENUM ('reported','verified','assigned','in_progress','awaiting_confirmation','fixed','reopened','rejected');
CREATE TYPE evidence_kind AS ENUM ('report','before','after','dispute');

CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind org_kind NOT NULL,
  name text NOT NULL,
  is_synthetic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);

-- Identity is bound to the verified token issuer + subject. Roles never come from the token.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  subject text NOT NULL,
  alias text NOT NULL,
  ward text,
  points integer NOT NULL DEFAULT 0,
  suspended boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id),
  org_id uuid NOT NULL REFERENCES orgs(id),
  role member_role NOT NULL,
  granted_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id, role)
);

CREATE TABLE road_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  ward text,
  municipality_org_id uuid NOT NULL REFERENCES orgs(id),
  geom geography(LineString,4326) NOT NULL,
  is_synthetic boolean NOT NULL DEFAULT false
);
CREATE INDEX road_geom_idx ON road_segments USING gist (geom);

CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  road_id uuid NOT NULL REFERENCES road_segments(id),
  contractor_org_id uuid NOT NULL REFERENCES orgs(id),
  completion_date date NOT NULL,
  warranty_end date NOT NULL,
  is_synthetic boolean NOT NULL DEFAULT false,
  CHECK (warranty_end >= completion_date)
);

CREATE TABLE utility_cuts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  road_id uuid NOT NULL REFERENCES road_segments(id),
  utility_org_id uuid NOT NULL REFERENCES orgs(id),
  cut_date date NOT NULL,
  is_synthetic boolean NOT NULL DEFAULT false
);

CREATE TABLE issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id),
  geom geography(Point,4326) NOT NULL,
  hazard hazard_type NOT NULL,
  danger_flag boolean NOT NULL DEFAULT false,
  severity smallint NOT NULL CHECK (severity BETWEEN 1 AND 5),
  status issue_status NOT NULL DEFAULT 'reported',
  road_id uuid REFERENCES road_segments(id),
  ward text,
  responsible_org_id uuid REFERENCES orgs(id),
  responsible_kind org_kind,
  copy_org_id uuid REFERENCES orgs(id),
  route_reason text,
  route_flags text[] NOT NULL DEFAULT '{}',
  route_overridden boolean NOT NULL DEFAULT false,
  deadline_at timestamptz,
  reports_count integer NOT NULL DEFAULT 1,
  reopen_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  fixed_at timestamptz
);
CREATE INDEX issues_geom_idx ON issues USING gist (geom);
CREATE INDEX issues_status_idx ON issues (status);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  user_id uuid NOT NULL REFERENCES users(id),
  geom geography(Point,4326) NOT NULL,
  accuracy_m real,
  note text,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  uploader_id uuid NOT NULL REFERENCES users(id),
  kind evidence_kind NOT NULL,
  storage_key text NOT NULL UNIQUE,
  sha256 text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  width integer, height integer,
  claimed_geom geography(Point,4326),
  location_ok boolean,
  -- no face/plate redaction mechanism exists yet: photos are NEVER publicly visible
  redaction_status text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE status_events (
  id bigserial PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES issues(id),
  actor_id uuid REFERENCES users(id),
  from_status issue_status,
  to_status issue_status,
  kind text NOT NULL,
  reason text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_events_issue_idx ON status_events (issue_id, id);

CREATE TABLE disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  raised_by uuid NOT NULL REFERENCES users(id),
  org_id uuid NOT NULL REFERENCES orgs(id),
  reason text NOT NULL,
  evidence_id uuid REFERENCES evidence(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','rejected')),
  decided_by uuid REFERENCES users(id),
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX one_open_dispute ON disputes (issue_id) WHERE status = 'open';

CREATE TABLE confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  user_id uuid NOT NULL REFERENCES users(id),
  round integer NOT NULL,
  is_fixed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id, user_id, round)
);

CREATE TABLE points_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  issue_id uuid REFERENCES issues(id),
  delta integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX points_user_day ON points_ledger (user_id, created_at);

-- Recorded only. Nothing is delivered to any authority from this table.
CREATE TABLE escalation_events (
  id bigserial PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES issues(id),
  level smallint NOT NULL CHECK (level IN (1,2)),
  target text NOT NULL,
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id, level, deadline_at)
);

CREATE TABLE registry_imports (
  id bigserial PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES users(id),
  org_id uuid NOT NULL REFERENCES orgs(id),
  source_label text NOT NULL,
  is_synthetic boolean NOT NULL,
  rows_ok integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Audit trail is append-only.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'append-only table'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER status_events_immutable BEFORE UPDATE OR DELETE ON status_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER points_ledger_immutable BEFORE UPDATE OR DELETE ON points_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER escalation_immutable BEFORE UPDATE OR DELETE ON escalation_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
