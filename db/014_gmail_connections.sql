-- 014: Gmail product connections (user-consented OAuth, least scope gmail.send) and the
-- authority emails sent through them. Refresh tokens are AES-256-GCM encrypted at rest with
-- a deployment-owner key (GMAIL_TOKEN_KEY); the plaintext never touches the DB or logs.
-- 'accepted' means the Gmail API accepted the message (id returned); it is never 'delivered'.

CREATE TABLE gmail_connection (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  google_sub text NOT NULL,
  email text NOT NULL,
  refresh_token_enc bytea NOT NULL, -- AES-256-GCM: 12B iv || 16B tag || ciphertext
  scopes text NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (google_sub)
);

CREATE TABLE authority_email (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  sender_user_id uuid NOT NULL REFERENCES users(id),
  to_address text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_sha256 text NOT NULL, -- exact-body proof: the reviewed bytes are the sent bytes
  status text NOT NULL CHECK (status IN ('accepted','failed')),
  gmail_message_id text,      -- present ONLY on a real API acceptance
  gmail_thread_id text,
  error text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sender_user_id, idempotency_key)
);

GRANT SELECT, INSERT, UPDATE ON gmail_connection TO nagartrace_runtime;
GRANT SELECT, INSERT ON authority_email TO nagartrace_runtime;
