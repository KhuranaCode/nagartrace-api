-- 013: multiple hazards per report and issue (user-requested: one report can cover several
-- hazard types at one spot). issues.hazard stays the PRIMARY hazard and is always hazards[1];
-- issues.hazards is the full distinct set (>= 1). Pre-013 merged reports all shared the issue
-- hazard (duplicate matching required an exact hazard match), so the backfill is exact, not
-- approximate. reports.hazards records what THIS report asserted, for replay equality.

CREATE OR REPLACE FUNCTION hazards_ok(h hazard_type[]) RETURNS boolean
LANGUAGE sql IMMUTABLE RETURNS NULL ON NULL INPUT AS $$
  -- 1-D 1-based arrays only (a 0-based '[0:0]={crack}' or a 2-D literal is not a hazard set),
  -- at least one element, no NULLs, no duplicates.
  SELECT h IS NOT NULL AND array_ndims(h) = 1 AND array_lower(h, 1) = 1
     AND cardinality(h) >= 1 AND NOT EXISTS (SELECT 1 FROM unnest(h) u WHERE u IS NULL)
     AND (SELECT count(DISTINCT u) FROM unnest(h) u) = cardinality(h)
$$;

ALTER TABLE issues ADD COLUMN hazards hazard_type[];
UPDATE issues SET hazards = ARRAY[hazard];
ALTER TABLE issues ALTER COLUMN hazards SET NOT NULL;
ALTER TABLE issues ADD CONSTRAINT issues_hazards_valid CHECK (hazards_ok(hazards));
ALTER TABLE issues ADD CONSTRAINT issues_hazards_primary CHECK ((hazards[1] = hazard) IS TRUE);

ALTER TABLE reports ADD COLUMN hazards hazard_type[];
UPDATE reports r SET hazards = ARRAY[i.hazard] FROM issues i WHERE i.id = r.issue_id;
ALTER TABLE reports ALTER COLUMN hazards SET NOT NULL;
ALTER TABLE reports ADD CONSTRAINT reports_hazards_valid CHECK (hazards_ok(hazards));
