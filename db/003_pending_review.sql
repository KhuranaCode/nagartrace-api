-- Intake no longer assigns. The router's result is stored as a SUGGESTION until an officer verifies (or the operator picks the provisional auto_checks mode).
ALTER TABLE issues
  ADD COLUMN review_org_id uuid REFERENCES orgs(id),
  ADD COLUMN suggested_org_id uuid REFERENCES orgs(id),
  ADD COLUMN suggested_kind org_kind,
  ADD COLUMN suggested_copy_org_id uuid REFERENCES orgs(id),
  ADD COLUMN suggested_reason text,
  ADD COLUMN suggested_flags text[] NOT NULL DEFAULT '{}';
CREATE INDEX issues_review_org_idx ON issues (review_org_id) WHERE status = 'reported';
