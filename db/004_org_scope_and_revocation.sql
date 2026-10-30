-- Contractor/utility orgs belong to the municipality that created them, so a grant can never reach another city's data.
ALTER TABLE orgs ADD COLUMN owner_org_id uuid REFERENCES orgs(id);
ALTER TABLE orgs DROP CONSTRAINT orgs_kind_name_key;
CREATE UNIQUE INDEX orgs_owner_kind_name ON orgs ((COALESCE(owner_org_id, '00000000-0000-0000-0000-000000000000'::uuid)), kind, name);
-- Memberships are revoked, never deleted or rewritten.
ALTER TABLE memberships ADD COLUMN revoked_at timestamptz, ADD COLUMN revoked_by uuid REFERENCES users(id);
GRANT UPDATE (revoked_at, revoked_by, granted_by) ON memberships TO nagartrace_runtime;
