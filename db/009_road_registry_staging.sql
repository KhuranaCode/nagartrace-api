-- DRAFT, not applied. Additive only. Does not touch road_segments / contracts.
-- Holds real national road geometry (OSM, ODbL) with jurisdiction left UNRESOLVED
-- until a real boundary source assigns it. Nothing here is a contractor record.
CREATE TABLE IF NOT EXISTS road_registry_staging (
  id bigserial PRIMARY KEY,
  source text NOT NULL,                 -- 'osm' | 'pmgsy'
  source_id text NOT NULL,              -- e.g. OSM way id
  source_label text NOT NULL,           -- dataset + extract date, for audit
  attribution text NOT NULL,            -- ODbL credit string
  name text,
  ref text,
  road_class text,                      -- OSM highway=* value
  surface text,
  operator text,                        -- raw OSM operator tag, NOT verified authority
  geom geography(LineString,4326) NOT NULL,
  jurisdiction_status text NOT NULL DEFAULT 'unresolved'
    CHECK (jurisdiction_status IN ('unresolved','urban_resolved','rural_unmapped')),
  municipality_org_id uuid REFERENCES orgs(id),  -- only set by boundary containment
  maintainer_verified boolean NOT NULL DEFAULT false,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id),
  CHECK (jurisdiction_status <> 'urban_resolved' OR municipality_org_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS road_registry_staging_geom_idx ON road_registry_staging USING gist (geom);
-- Promotion to road_segments is a separate, explicit step per municipality that
-- has a real boundary polygon; rural roads stay here (no fake municipality/ward).

-- Runtime API role reads staged geometry for official-record lookups (imports run as admin).
GRANT SELECT ON road_registry_staging TO nagartrace_runtime;
