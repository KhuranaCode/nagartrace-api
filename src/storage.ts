import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Private blob storage. Local-disk implementation for development/tests; an S3-compatible
 *  implementation of the same interface is needed for hosted deployment (not built yet). */
export interface BlobStore {
  put(data: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
  /** Best-effort delete (staged-upload expiry sweep). Optional: stores without it just leak the orphan blob. */
  del?(key: string): Promise<void>;
}

export function localStore(dir: string): BlobStore {
  const root = path.resolve(dir);
  const file = (key: string) => {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new Error('bad key');
    return path.join(root, key.slice(0, 2), key);
  };
  return {
    async put(data) {
      const key = crypto.randomBytes(16).toString('hex');
      await fs.mkdir(path.dirname(file(key)), { recursive: true });
      await fs.writeFile(file(key), data, { mode: 0o600 });
      return key;
    },
    async get(key) { return fs.readFile(file(key)); },
    async del(key) { await fs.rm(file(key), { force: true }); },
  };
}

export type S3Opts = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; fetchFn?: typeof fetch; now?: () => Date };

const hmac = (k: Buffer | string, d: string) => crypto.createHmac('sha256', k).update(d).digest();
const sha = (d: Buffer | string) => crypto.createHash('sha256').update(d).digest('hex');

/** S3-compatible private store (path-style, AWS SigV4). Verified once against Supabase Storage (S3 endpoint with a /storage/v1/s3 path prefix); also mock-tested. Objects are never public; reads go through the API's authorization. */
export function s3Store(o: S3Opts): BlobStore {
  const f = o.fetchFn ?? fetch;
  const base = new URL(o.endpoint);
  const sign = (method: string, key: string, body: Buffer) => {
    const t = (o.now ?? (() => new Date()))();
    const amz = t.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amz.slice(0, 8);
    const prefix = base.pathname.replace(/\/+$/, '');
    const p = `${prefix}/${o.bucket}/${key}`;
    const payload = sha(body);
    const headers: Record<string, string> = { host: base.host, 'x-amz-content-sha256': payload, 'x-amz-date': amz };
    const names = Object.keys(headers).sort();
    const canonical = [method, p, '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payload].join('\n');
    const scope = `${day}/${o.region}/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amz, scope, sha(canonical)].join('\n');
    const k = hmac(hmac(hmac(hmac('AWS4' + o.secretAccessKey, day), o.region), 's3'), 'aws4_request');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${crypto.createHmac('sha256', k).update(sts).digest('hex')}`;
    return { url: `${base.origin}${p}`, headers };
  };
  const okKey = (key: string) => { if (!/^[a-f0-9]{32}$/.test(key)) throw new Error('bad key'); };
  return {
    async put(data) {
      const key = crypto.randomBytes(16).toString('hex');
      const s = sign('PUT', key, data);
      const r = await f(s.url, { method: 'PUT', headers: s.headers, body: new Uint8Array(data) });
      if (!r.ok) throw new Error(`blob put failed: ${r.status}`);
      return key;
    },
    async get(key) {
      okKey(key);
      const s = sign('GET', key, Buffer.alloc(0));
      const r = await f(s.url, { method: 'GET', headers: s.headers });
      if (!r.ok) throw new Error(`blob get failed: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async del(key) {
      okKey(key);
      const s = sign('DELETE', key, Buffer.alloc(0));
      const r = await f(s.url, { method: 'DELETE', headers: s.headers });
      if (!r.ok && r.status !== 404) throw new Error(`blob delete failed: ${r.status}`);
    },
  };
}
