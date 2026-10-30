-- DRAFT, UNEXECUTED (no Postgres in the authoring sandbox). Additive; no FK to roads.
-- Evidence catalog of NHAI award rows. NOT a road registry, NOT a maintainer record.
CREATE TABLE IF NOT EXISTS nhai_award_records (
  id bigserial PRIMARY KEY,
  source_url text NOT NULL,
  source_label text NOT NULL,           -- file + fetch date; FY2024-25 snapshot
  page int NOT NULL,
  sr int NOT NULL,
  project_name text NOT NULL,
  nh_new_raw text,                      -- verbatim PDF cell, never decoded
  nh_from_name text[] NOT NULL DEFAULT '{}',
  chainage_km_marks real[] NOT NULL DEFAULT '{}',
  length_km numeric,
  loa_date date,                        -- source format dd-mm-yyyy
  awarded_cost_cr numeric,
  piu text,
  mode text,
  contractor_name text,                 -- NULL when the PDF cell is blank (row 352)
  project_stage text,
  state text,
  project_type text,
  match_status text NOT NULL DEFAULT 'unmatched' CHECK (match_status = 'unmatched'),
  UNIQUE (source_label, sr)
);

-- Runtime API role reads the award catalog for official-record lookups (loads run as admin).
GRANT SELECT ON nhai_award_records TO nagartrace_runtime;
