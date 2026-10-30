import pg from 'pg';
import { createRemoteJWKSet } from 'jose';
import { fromEnv } from './config.ts';
import { buildApp } from './app.ts';
import { localStore, s3Store } from './storage.ts';

const cfg = fromEnv();
const db = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 });
const app = await buildApp({ cfg, db, keys: createRemoteJWKSet(new URL(cfg.authJwksUrl!)), store: process.env.S3_ENDPOINT ? s3Store({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION!, bucket: process.env.S3_BUCKET!, accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! }) : localStore(cfg.storageDir) });
await app.listen({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0' });

// Graceful shutdown: stop accepting, let in-flight requests finish, close the pool.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { try { await app.close(); await db.end(); } finally { process.exit(0); } });
}
