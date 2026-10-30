-- Separates fixture/test records from genuine ones without deleting anything.
-- Columns only: safe to apply before the matching API version is deployed (older API ignores them, defaults are false).
-- Fixture rows are flagged by a separate, explicit data step (docs/ops), never inferred here.
ALTER TABLE users  ADD COLUMN is_test boolean NOT NULL DEFAULT false;
ALTER TABLE issues ADD COLUMN is_test boolean NOT NULL DEFAULT false;
CREATE INDEX issues_public_idx ON issues (created_at DESC) WHERE NOT is_test;
