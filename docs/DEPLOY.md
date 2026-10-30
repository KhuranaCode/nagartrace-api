# Deploying a hosted TEST instance (not production)

Nothing in this repo is production-ready. Use synthetic data only. Photos stay private and no face or plate blur exists.

Needs: PostgreSQL with PostGIS, a JWT issuer (issuer, audience, sub, RS256/ES256 via JWKS), a Node 22 host for the long-running Fastify server, and optionally S3-compatible private storage.

## Steps
1. Create a Postgres database with PostGIS. On Supabase, install PostGIS into the `extensions` schema, not `public`, and turn the Data API off: this API connects with its own Postgres role.
2. Owner connection: `ADMIN_DATABASE_URL=... npm run migrate` applies `db/*.sql` and creates the restricted role `nagartrace_runtime`. Set that role's password with the owner connection. Use it in `DATABASE_URL`.
3. Auth: set `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AUTH_JWKS_URL` from your identity provider. Check the real `aud` and that the JWKS is not empty (Supabase serves it only with asymmetric signing keys).
4. Storage: private bucket, server-only keys. The SigV4 adapter is mock-tested and was run once against Supabase Storage (endpoint `https://<ref>.storage.supabase.co/storage/v1/s3`, region from the dashboard). Supabase S3 keys cover all buckets, so treat them as server-only secrets.
5. API host: `npm ci`, `npm start`, env from `.env.example`, `NODE_ENV=staging`, `POLICY_USE_DEV_DEFAULTS=synthetic-test-only`, `CORS_ORIGINS` = the frontend origin, `TRUST_PROXY=true` only behind a trusted proxy. `/health` reports PROVISIONAL.
6. Bootstrap the first municipality admin: `npx tsx src/bootstrap.ts "<municipality>" <issuer> <subject>` (owner connection only). Import a synthetic registry and run the flow with two or more test accounts.

Free tiers idle or pause (for example Render free after 15 minutes, Supabase free after a week of inactivity). That is fine for a demo.

## Local run
`npm ci`, set `DATABASE_URL` and `ADMIN_DATABASE_URL`, `npm run migrate`, `npm start`. Tests: `npm test` with `TEST_OWNER_URL` pointing at a superuser connection on a PostGIS-enabled server. Set `POLICY_VERIFICATION_MODE=officer_review`. AI is disabled by default and no provider is wired.

## Migrations
Migration 004 (org ownership, membership revocation) assumes a fresh database. Start from an empty database. Re-granting a revoked membership overwrites `revoked_at`, `revoked_by` and `granted_by`, so membership history is not append-only.

## Notes from a hosted Supabase test (synthetic data)
- Use the session pooler host with user `<role>.<project-ref>`. Node `pg` accepts `?sslmode=no-verify` in the URL; verify the CA if you can.
- A changed role password can take a few seconds to work through the pooler.
- Migration 001 installs PostGIS into `public` (not the recommended `extensions` schema). `db/005_revoke_supabase_api_roles.sql` revokes `anon`, `authenticated` and `service_role` on our tables. PostGIS system views stay owned by `supabase_admin`; keep the Data API off.
- Render free web service: build `npm ci`, start `npm start`, `NODE_ENV=staging`. It sleeps after 15 minutes idle, so the first request can take about a minute.
