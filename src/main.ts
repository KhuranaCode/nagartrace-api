import pg from 'pg';
import { createRemoteJWKSet } from 'jose';
import { fromEnv } from './config.ts';
import { buildApp } from './app.ts';
import { localStore, s3Store } from './storage.ts';

const cfg = fromEnv();
const db = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 });
function makeStore() {
  const e = process.env;
  if (!e.S3_ENDPOINT) { if (e.S3_BUCKET || e.S3_ACCESS_KEY_ID || e.S3_SECRET_ACCESS_KEY || e.S3_REGION) throw new Error('S3_* variables are set but S3_ENDPOINT is missing'); return localStore(cfg.storageDir); }
  const missing = ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !e[k]);
  if (missing.length) throw new Error(`S3_ENDPOINT is set but these are missing: ${missing.join(', ')}`);
  return s3Store({ endpoint: e.S3_ENDPOINT, region: e.S3_REGION!, bucket: e.S3_BUCKET!, accessKeyId: e.S3_ACCESS_KEY_ID!, secretAccessKey: e.S3_SECRET_ACCESS_KEY! });
}
const app = await buildApp({ cfg, db, keys: createRemoteJWKSet(new URL(cfg.authJwksUrl!)), store: makeStore() });
await app.listen({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0' });

// Graceful shutdown: stop accepting, let in-flight requests finish, close the pool.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { try { await app.close(); await db.end(); } finally { process.exit(0); } });
}
