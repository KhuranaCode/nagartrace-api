#!/usr/bin/env python3
"""Validate (and generate example) NagarTrace registry import CSVs.

Mirrors the server rules in nagartrace-api src/app.ts:
POST /v1/admin/registry/import-csv + csvRows() + importSchema.
Stdlib only. Exit 0 = valid, 1 = errors (printed with line numbers).
"""
import re, sys
from datetime import date

LIMITS = {
    "roads": {"header": ["code", "name", "ward", "coordinates"], "max_rows": 5000},
    "contracts": {"header": ["road_code", "contractor_name", "completion_date", "warranty_end"], "max_rows": 20000},
    "utility_cuts": {"header": ["road_code", "utility_name", "cut_date"], "max_rows": 20000},
}

EXAMPLE_ROADS = '''code,name,ward,coordinates
EX-W12-001,"Example Marg, Sector 12",W-12,77.0266 28.4595;77.0290 28.4601;77.0315 28.4610
EX-W12-002,"Example Link Road",W-12,77.0290 28.4601;77.0302 28.4625
EX-W07-003,"Example Cross Street, Block C",W-07,77.0411 28.4488;77.0430 28.4496;77.0449 28.4502
'''
EXAMPLE_CONTRACTS = '''road_code,contractor_name,completion_date,warranty_end
EX-W12-001,Example Infra Pvt Ltd,2025-03-31,2028-03-30
EX-W12-002,Example Infra Pvt Ltd,2024-11-15,2027-11-14
EX-W07-003,Example Constructions LLP,2025-06-01,2026-05-31
'''
EXAMPLE_CUTS = '''road_code,utility_name,cut_date
EX-W12-001,Example Water Board,2026-01-20
EX-W07-003,Example Fibre Networks,2026-04-11
'''

def fail(errors, msg):
    errors.append(msg)

def server_csv_rows(text):
    """Exact port of the server csvRows() parser from nagartrace-api src/app.ts.
    A quote opens a quoted field only at field start; "" inside quotes escapes;
    BOM stripped; CR/LF/CRLF endings; blank lines skipped. Returns list of rows."""
    t = text.lstrip("\ufeff")
    rows, row, f, q = [], [], '', False
    i = 0
    while i < len(t):
        ch = t[i]
        if q:
            if ch == '"':
                if i + 1 < len(t) and t[i + 1] == '"':
                    f += '"'; i += 1
                else:
                    q = False
            else:
                f += ch
        elif ch == '"' and f == '':
            q = True
        elif ch == ',':
            row.append(f); f = ''
        elif ch in '\r\n':
            if ch == '\r' and i + 1 < len(t) and t[i + 1] == '\n':
                i += 1
            row.append(f); f = ''
            if any(x.strip() != '' for x in row):
                rows.append(row)
            row = []
        else:
            f += ch
        i += 1
    if q:
        raise ValueError('unterminated quote')
    row.append(f)
    if any(x.strip() != '' for x in row):
        rows.append(row)
    if not rows:
        raise ValueError('empty file')
    return rows


def parse_csv_text(text, kind, errors):
    """Server-parity parsing + header/column checks, then trimmed field dicts."""
    spec = LIMITS[kind]
    if len(text) > 3_000_000:
        fail(errors, f"{kind}: exceeds 3,000,000 character limit")
        return []
    try:
        rows = server_csv_rows(text)
    except ValueError as e:
        fail(errors, f"{kind}: CSV error: {e}")
        return []
    header = [h.strip() for h in rows[0]]
    if header != spec["header"]:
        fail(errors, f"{kind}: header must be exactly: {','.join(spec['header'])}")
        return []
    out = []
    for i, r in enumerate(rows[1:], start=2):
        if len(r) != len(spec["header"]):
            fail(errors, f"{kind}: line {i}: expected {len(spec['header'])} columns, got {len(r)}")
            continue
        out.append((i, dict(zip(spec["header"], (x.strip() for x in r)))))
    if len(out) > spec["max_rows"]:
        fail(errors, f"{kind}: {len(out)} rows exceeds limit {spec['max_rows']}")
    return out

def check_date(s):
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None

def validate(roads_text, contracts_text="", cuts_text=""):
    errors = []
    roads = parse_csv_text(roads_text, "roads", errors)
    contracts = parse_csv_text(contracts_text, "contracts", errors) if contracts_text else []
    cuts = parse_csv_text(cuts_text, "utility_cuts", errors) if cuts_text else []

    codes = set()
    for i, r in roads:
        c = r["code"]
        if not (1 <= len(c) <= 60):
            fail(errors, f"roads: line {i}: code must be 1-60 chars")
        if c in codes:
            fail(errors, f"roads: line {i}: Duplicate road code {c}")
        codes.add(c)
        if not (1 <= len(r["name"]) <= 120):
            fail(errors, f"roads: line {i}: name must be 1-120 chars")
        if len(r["ward"]) > 60:
            fail(errors, f"roads: line {i}: ward must be max 60 chars")
        raw_pts = r["coordinates"].split(";")
        if any(p.strip() == "" for p in raw_pts):
            fail(errors, f"roads: line {i}: empty coordinate point (trailing or doubled ';') - server rejects these")
        pts = [p.strip() for p in raw_pts if p.strip()]
        if not (2 <= len(pts) <= 2000):
            fail(errors, f"roads: line {i}: coordinates need 2-2000 points, got {len(pts)}")
        for p in pts:
            parts = re.split(r"\s+", p)
            try:
                x, y = float(parts[0]), float(parts[1])
                if len(parts) != 2:
                    raise ValueError
                if not (-180 <= x <= 180) or not (-90 <= y <= 90):
                    fail(errors, f"roads: line {i}: coordinate out of range: {p}")
            except (ValueError, IndexError):
                fail(errors, f"roads: line {i}: bad coordinate pair: {p!r} (want 'lon lat')")

    for kind, rows, namefield, datefields in (
        ("contracts", contracts, "contractor_name", ("completion_date", "warranty_end")),
        ("utility_cuts", cuts, "utility_name", ("cut_date",)),
    ):
        for i, r in rows:
            if not (2 <= len(r[namefield]) <= 120):
                fail(errors, f"{kind}: line {i}: {namefield} must be 2-120 chars")
            rc = r["road_code"]
            if rc not in codes:
                # may still resolve against pre-existing DB roads; server checks at import
                print(f"note: {kind} line {i}: road_code {rc!r} not in this file's roads; "
                      f"server will require an existing road in the same municipality", file=sys.stderr)
            for df in datefields:
                if check_date(r[df]) is None:
                    fail(errors, f"{kind}: line {i}: {df} must be ISO date yyyy-mm-dd, got {r[df]!r}")
        if kind == "contracts":
            for i, r in rows:
                cd, we = check_date(r["completion_date"]), check_date(r["warranty_end"])
                if cd and we and we < cd:
                    fail(errors, f"contracts: line {i}: Contract on {r['road_code']}: warranty_end before completion_date")
    return errors

def main(argv):
    if len(argv) >= 2 and argv[1] == "example":
        import os
        outdir = argv[2] if len(argv) > 2 else "examples"
        os.makedirs(outdir, exist_ok=True)
        for fn, content in (("roads.example.csv", EXAMPLE_ROADS),
                            ("contracts.example.csv", EXAMPLE_CONTRACTS),
                            ("utility_cuts.example.csv", EXAMPLE_CUTS)):
            with open(os.path.join(outdir, fn), "w") as f:
                f.write(content)
        print(f"wrote 3 example files to {outdir}/ (synthetic fixture; import with is_synthetic=true)")
        return 0
    if len(argv) >= 2 and argv[1] == "validate" and len(argv) >= 3:
        roads_text = open(argv[2], encoding="utf-8-sig").read()
        contracts_text = open(argv[3], encoding="utf-8-sig").read() if len(argv) > 3 else ""
        cuts_text = open(argv[4], encoding="utf-8-sig").read() if len(argv) > 4 else ""
        errors = validate(roads_text, contracts_text, cuts_text)
        if errors:
            for e in errors:
                print("ERROR:", e)
            return 1
        print("OK: files pass all local checks (server still re-validates, incl. existing road codes and admin auth)")
        return 0
    print(__doc__)
    print("usage: registry_csv_tool.py validate roads.csv [contracts.csv] [utility_cuts.csv]")
    print("       registry_csv_tool.py example [outdir]")
    return 2

if __name__ == "__main__":
    sys.exit(main(sys.argv))
