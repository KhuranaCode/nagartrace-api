-- PENDING, NOT IN THE MIGRATION PATH (db-pending/). The migrator only runs db/*.sql;
-- this file applies ONLY when the deployment owner copies it into db/ during the
-- coordinated 011 apply, after review clearance. Additive only.
-- Follow-up reminder pipeline: consent, approved campaigns, idempotent deliveries.
-- Nothing here sends anything; sending needs a separately authorized provider scope.
CREATE TABLE IF NOT EXISTS user_mail_consent (
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,                       -- 'report_reminders'
  scope_version text NOT NULL,              -- must equal the server's current consent text version
  granted boolean NOT NULL,
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS followup_campaign (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),  -- the approving reporter (access-checked)
  audience text NOT NULL CHECK (audience IN ('reporter','authority')),
  recipient_descriptor text NOT NULL,        -- 'self' or the verified authority identity
  recipient_address text,                    -- 'self' = the AUTHENTICATED sign-in email from the verified token
  recipient_verified boolean NOT NULL DEFAULT false,
  stages jsonb NOT NULL,                     -- [{day, subject, body_text, body_html?, content_sha256}] EXACT approved content
  consent_scope_version text NOT NULL,       -- snapshot: the consent text version under which this was approved
  approved_at timestamptz NOT NULL,
  approved_by uuid NOT NULL REFERENCES users(id),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','completed','stopped_resolved','blocked_no_recipient')),
  idempotency_key text NOT NULL,             -- scoped per owner: a key is only ever the approving user's own
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, idempotency_key)
);
-- one active campaign per issue+owner+audience
CREATE UNIQUE INDEX IF NOT EXISTS followup_campaign_one_active
  ON followup_campaign (issue_id, owner_user_id, audience) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS followup_delivery (
  id bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES followup_campaign(id),
  stage_day int NOT NULL,
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','blocked_no_provider','blocked_no_consent','blocked_no_recipient','attempting','accepted','unknown','failed','delivered_callback','suppressed')),
  send_key text NOT NULL UNIQUE,             -- sha256(campaign_id|stage_day|content_sha256): dup guard across retries
  -- Immutable payload: rendered ONCE ({{status}} substituted) at the first attempt, reused for
  -- every retry, so a retry is byte-identical under the same provider idempotency key.
  rendered_subject text,
  rendered_text text,
  rendered_html text,
  first_attempt_at timestamptz,              -- anchors the provider idempotency window (TTL is bound to the FIRST attempt, never refreshed)
  attempt_count int NOT NULL DEFAULT 0,
  provider text,
  provider_message_id text,                  -- real provider id only; a missing id is not a failure claim and a synthetic id is never stored as delivered
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, stage_day)
);

-- Runtime role access (same pattern as 007/008). The API connects as nagartrace_runtime.
-- No DELETE: campaigns/deliveries are revoked/suppressed, never erased (audit trail).
GRANT SELECT, INSERT, UPDATE ON user_mail_consent, followup_campaign, followup_delivery TO nagartrace_runtime;
GRANT USAGE, SELECT ON SEQUENCE followup_delivery_id_seq TO nagartrace_runtime;
