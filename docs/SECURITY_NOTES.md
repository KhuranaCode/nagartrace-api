# Security notes (author review, not a certification)

Checked by reading the code and by tests (51 local tests, restricted DB role):
- AuthN: jose verify with issuer, audience, exp, signature, RS256/ES256 only; identity = (iss, sub). Roles only from memberships table, written only by admin endpoints or the owner connection.
- AuthZ: issue reads, evidence reads and every mutation check reporter or responsible/copy org membership; non-participants get 404 (no existence leak). Tested with a second municipality and a second contractor.
- DB: runtime role cannot DDL, DELETE, or UPDATE audit/ledger/evidence/reports/memberships; users only alias, ward, points. Tested by attempting the statements.
- Public API: allowlisted DTO, rounded coordinates, no reporter/evidence. Tested.
- Input: zod strict bodies, uuid params, 10 MB body cap, image content sniffing and bounded decode.
- Headers: nosniff, no-store, CSP none. CORS exact-origin allowlist.

Known weaknesses and open items:
1. Rate limit is per IP, in memory, per process. Not per user; multi-instance needs a shared store; TRUST_PROXY must match the real proxy.
2. Auth creates a users row for any valid token of the configured issuer. Sign-up abuse is limited only by the issuer's own controls.
3. GPS, time and photo EXIF are client-supplied. Plausibility checks only. Spoofing is not prevented.
4. Account-age gate and reporters-only voting do not prove independent residents; collusion is possible.
5. No security headers beyond API ones, no WAF, no secrets manager, no backups, no monitoring.
6. S3 adapter never run against a real store. Photo blur is not implemented; photos stay private.
7. Policy values are provisional; production refuses to start until set explicitly.
8. No penetration test.

Dependency check 2026-10-29: npm audit --omit=dev reported 0 known vulnerabilities (advisory database at that time; not a guarantee).
