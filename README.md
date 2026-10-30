# NagarTrace API

Backend for NagarTrace, a civic app where residents report road hazards and the responsible authority is routed, deadlined and tracked until the repair is confirmed.

Stack: Node 22, TypeScript, Fastify 5, PostgreSQL + PostGIS (`pg`), `jose` for JWT verification, `sharp` for image handling, `zod`.

**Status: pre-release.** It passes its own test suite on local PostgreSQL 14 + PostGIS 3.2 and has not been run in a hosted environment or against a frontend. Photo blur, notifications and AI features are not built. Open policy choices (who verifies, escalation recipients and timing, unrouted-report ownership) are provisional config and block production use. Use synthetic data only.

## Quick start
```bash
npm ci
export ADMIN_DATABASE_URL=postgresql://...   # owner connection, PostGIS available
npm run migrate
export DATABASE_URL=postgresql://...         # restricted role nagartrace_runtime
# set AUTH_ISSUER, AUTH_AUDIENCE, AUTH_JWKS_URL, CORS_ORIGINS (see .env.example)
POLICY_USE_DEV_DEFAULTS=synthetic-test-only npm start
npm test   # TEST_OWNER_URL=postgresql://<superuser>@host/postgres
```

## Docs
- [docs/API.md](docs/API.md) and [docs/openapi.json](docs/openapi.json): routes (draft contract)
- [docs/STATUS.md](docs/STATUS.md): what exists, what does not
- [docs/DEPLOY.md](docs/DEPLOY.md): hosted test setup
- [docs/SECURITY_NOTES.md](docs/SECURITY_NOTES.md), [docs/KNOWN_GAPS.md](docs/KNOWN_GAPS.md), [docs/AI_PLAN.md](docs/AI_PLAN.md)

## Design points
Roles come only from the database, never from token claims. The API connects as a role that cannot run DDL or delete or change audit data. Routing is only a suggestion until an officer verifies. Public endpoints expose no reporter, evidence or exact coordinates. Photos are private.
