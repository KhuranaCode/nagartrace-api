# NagarTrace Registry CSV Import — Format & Operations Guide

Derived line-by-line from the deployed backend (`nagartrace-api` c637d6b, `src/app.ts`, `POST /v1/admin/registry/import-csv` and `csvRows`). Nothing in this document invents fields; every rule below is enforced by the server code quoted in the source file.

## Endpoints

| Endpoint | Body | Use |
| --- | --- | --- |
| `POST /v1/admin/registry/import-csv` | JSON envelope carrying three CSV strings | spreadsheet/registry exports |
| `POST /v1/admin/registry/import` | structured JSON arrays | programmatic imports |

Both run the same validation and the same single-transaction import (`doImport`).

## Auth

- `Authorization: Bearer <token>` required (401 `unauthenticated` if missing).
- Caller must hold the `admin` role on the municipality org given in `municipality_org_id` (403 `Admin of this municipality only`).

## Envelope fields (import-csv)

| Field | Rule |
| --- | --- |
| `municipality_org_id` | UUID of the municipality org |
| `source_label` | 3-200 chars, trimmed. Recorded in the `registry_imports` audit row. Use a real provenance, e.g. `MC <city> road warranty register 2024-25, ward office export` (placeholder - no city has been selected yet) |
| `is_synthetic` | boolean. `true` for test fixtures, `false` for genuine records. Propagates to every road/org/contract/cut row created |
| `roads_csv` | string, max 3,000,000 chars, required |
| `contracts_csv` | string, max 3,000,000 chars, optional (default empty) |
| `utility_cuts_csv` | string, max 3,000,000 chars, optional (default empty) |

Response `201`: `{ "roads": n, "contracts": n, "utility_cuts": n }` — row counts inserted.

## CSV parsing rules (applies to all three files)

- Header row required and must match exactly after trimming: wrong header = `400 CSV error: header must be exactly: ...`
- RFC-4180 style quoting: fields may be double-quoted; `""` inside quotes = literal quote. Unterminated quote is an error.
- UTF-8 BOM is stripped. CRLF, CR, or LF line endings all accepted. Blank lines skipped.
- Every data row must have exactly the header's column count, else `400 CSV error: line N: expected X columns, got Y` (N is the real file line number).
- Fields are trimmed. An empty `ward` is stored as null.

## roads.csv — header `code,name,ward,coordinates`

| Column | Rule |
| --- | --- |
| `code` | 1-60 chars. Unique within the file (`400 Duplicate road code <code>`). Must not already exist in the database (`409 Road codes already exist: ...`) |
| `name` | 1-120 chars |
| `ward` | max 60 chars, may be empty |
| `coordinates` | `lon lat;lon lat;...` — pairs separated by `;`, lon/lat separated by whitespace. Min 2, max 2000 points. lon in [-180,180], lat in [-90,90]. Stored as a `SRID=4326` LINESTRING geography |

Max 5000 road rows per import.

## contracts.csv — header `road_code,contractor_name,completion_date,warranty_end`

| Column | Rule |
| --- | --- |
| `road_code` | must resolve to a road in this import or an existing road of the same municipality (`400 Unknown road_code <code>`) |
| `contractor_name` | 2-120 chars. Contractor orgs are auto-created (idempotent `ON CONFLICT DO NOTHING`) |
| `completion_date` | ISO date `yyyy-mm-dd` |
| `warranty_end` | ISO date, must be on/after `completion_date` (`400 Contract on <road_code>: warranty_end before completion_date`) |

Max 20000 rows.

## utility_cuts.csv — header `road_code,utility_name,cut_date`

Same rules: `road_code` must resolve, `utility_name` 2-120 chars (auto-created), `cut_date` ISO date. Max 20000 rows.

## Semantics worth knowing

- **All-or-nothing**: the whole import runs in one transaction. Any error rolls everything back; nothing is half-imported.
- **Idempotent org creation, not road creation**: re-running with the same contractor/utility names is fine; re-running with the same road codes fails with 409.
- **Synthetic flag conflicts**: if an org name already exists with a different `is_synthetic` value, the import fails with `409 Organisation "<name>" already exists with a different synthetic flag`.
- **Audit**: every import writes one `registry_imports` row (admin id, org id, source label, synthetic flag, total rows). This is the provenance trail — set `source_label` to something an auditor can trace.
- **Real-data discipline**: `is_synthetic: false` is a claim that these are genuine municipal records. Do not mark generated/sample data as real. Synthetic rows are excluded from public surfaces by the backend (verified live 2026-10-30: a synthetic issue visible before deploy a2c1ed4 returns 404 on `/v1/public/issues/:id` and the public list comes back empty), and public scorecards are disabled entirely (`GET /v1/public/scorecards` returns 404 pending legal review). Do not claim the synthetic flag is publicly exposed - it is not part of the public allowlist.

## curl example

```bash
curl -X POST https://nagartrace-api.onrender.com/v1/admin/registry/import-csv \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  --data @<(jq -n \
    --arg muni "$MUNICIPALITY_ORG_ID" \
    --rawfile roads roads.csv \
    --rawfile contracts contracts.csv \
    --rawfile cuts utility_cuts.csv \
    '{municipality_org_id:$muni, source_label:"MC <city> ward office export YYYY-MM (placeholder, synthetic fixture)", is_synthetic:true, roads_csv:$roads, contracts_csv:$contracts, utility_cuts_csv:$cuts}')
```

## Files in this bundle

- `examples/roads.example.csv`, `examples/contracts.example.csv`, `examples/utility_cuts.example.csv` — a minimal three-file fixture (synthetic; always import with `is_synthetic: true`). Coordinates are example lon/lat points chosen only to be syntactically valid (they happen to sit in the Gurgaon area); they select NO geography and represent no real roads, contracts, or warranty records. Real imports require sourced municipal records, a resolved city/coverage answer, and separate authorization - none of which exist yet.
- `registry_csv_tool.py` — stdlib-only validator (`validate`) and fixture generator (`example`).

## Validator scope and parity (read before trusting "OK")

`validate` implements the SAME parsing algorithm as the server's `csvRows` (ported line for line, including its exact quoting rules) and re-checks every client-visible field rule. A local OK means the file passes all of these local checks - it is NOT a guarantee the server will accept the import. Server-only checks a local tool cannot perform:

- road codes must not already exist in the database (409 conflict)
- `road_code` references in contracts/utility_cuts must resolve to a road in this import OR an existing road of the same municipality (the validator checks the file and prints a `note:` for external references; only the server can confirm them)
- caller must be a municipal admin of `municipality_org_id` (401/403)
- org-name synthetic-flag conflicts (409)

Parity notes: quoting now matches the server exactly (a quote opens a quoted field only at field start; `""` inside quotes escapes; everything else is literal). Empty coordinate segments (trailing/double `;`) are rejected, matching server behavior.
