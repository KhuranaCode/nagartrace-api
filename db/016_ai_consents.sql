-- 016: per-user, per-feature AI processing consent (versioned, revocable).
-- Each row is one user's current consent state for ONE AI feature; grants and revokes are
-- append-only events so the audit trail survives. An AI content route in 'consented' mode
-- MUST check: row exists, revoked_at IS NULL, notice_version = the server's current notice.
CREATE TABLE ai_consents (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature text NOT NULL CHECK (feature IN ('guide_chat', 'email_draft', 'report_check', 'photo_advisory', 'contractor_finder')),
  notice_version text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (user_id, feature)
);
CREATE TABLE ai_consent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature text NOT NULL,
  action text NOT NULL CHECK (action IN ('granted', 'revoked')),
  notice_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_consents TO nagartrace_runtime;
GRANT SELECT, INSERT ON ai_consent_events TO nagartrace_runtime;
