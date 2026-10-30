-- DRAFT, additive only. Follow-up reminder pipeline: consent, approved campaigns, idempotent deliveries.
-- Nothing here sends anything; sending needs a configured provider + verified recipient + granted consent.
CREATE TABLE IF NOT EXISTS user_mail_consent (
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,                       -- 'report_reminders'
  scope_version text NOT NULL,              -- pins the exact consent text shown
  granted boolean NOT NULL,
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS followup_campaign (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),  -- the approving reporter
  audience text NOT NULL CHECK (audience IN ('reporter','authority')),
  recipient_descriptor text NOT NULL,        -- 'self' or the verified authority address/identity
  recipient_address text,                    -- concrete send-to address; 'self' = the sign-in address the user confirmed at approval time (owner-visible only)
  recipient_verified boolean NOT NULL DEFAULT false,
  stages jsonb NOT NULL,                     -- [{day, subject, body_text, body_html_sha256}] EXACT approved content
  approved_at timestamptz NOT NULL,
  approved_by uuid NOT NULL REFERENCES users(id),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','completed','stopped_resolved','blocked_no_recipient')),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
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
  attempt_count int NOT NULL DEFAULT 0,
  provider text,                             -- 'brevo' | 'none'
  provider_message_id text,                  -- set on accepted; used for reconciliation, never resend-blind
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, stage_day)
);
