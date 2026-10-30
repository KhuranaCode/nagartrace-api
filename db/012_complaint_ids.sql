-- 012: human-readable complaint numbers for issues (e.g. NT-000123).
-- Adds a sequence-backed bigint; existing issues are backfilled in creation order.
-- The formatted "NT-000123" rendering lives in the API DTO layer, not the DB.
CREATE SEQUENCE IF NOT EXISTS complaint_no_seq;

ALTER TABLE issues ADD COLUMN IF NOT EXISTS complaint_no bigint;

-- Backfill rows that predate this migration, oldest first, continuing after any
-- values already assigned (idempotent: rows with a value are skipped).
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
  FROM issues WHERE complaint_no IS NULL
), base AS (
  SELECT COALESCE(max(complaint_no), 0) AS m FROM issues WHERE complaint_no IS NOT NULL
)
UPDATE issues i SET complaint_no = o.rn + (SELECT m FROM base) FROM ordered o WHERE i.id = o.id;

SELECT setval('complaint_no_seq', COALESCE((SELECT max(complaint_no) FROM issues), 0) + 1, false);

ALTER TABLE issues ALTER COLUMN complaint_no SET DEFAULT nextval('complaint_no_seq');
UPDATE issues SET complaint_no = DEFAULT WHERE complaint_no IS NULL; -- safety net for races during deploy
SELECT setval('complaint_no_seq', COALESCE((SELECT max(complaint_no) FROM issues), 0) + 1, false);
ALTER TABLE issues ALTER COLUMN complaint_no SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS issues_complaint_no_key ON issues (complaint_no);

GRANT USAGE, SELECT ON SEQUENCE complaint_no_seq TO nagartrace_runtime;
