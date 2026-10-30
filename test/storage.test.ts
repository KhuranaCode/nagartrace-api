import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s3Store } from '../src/storage.ts';

test('s3 store (mock only): signed private PUT/GET, key validation, errors', async () => {
  const seen: { m: string; url: string; h: Record<string, string> }[] = []; const objs = new Map<string, Buffer>();
  const fetchFn = (async (url: string, init: any) => {
    seen.push({ m: init.method, url, h: init.headers });
    if (init.method === 'PUT') { objs.set(url, Buffer.from(init.body as Uint8Array)); return new Response(null, { status: 200 }); }
    const b = objs.get(url); return b ? new Response(new Uint8Array(b)) : new Response(null, { status: 404 });
  }) as any;
  const s = s3Store({ endpoint: 'https://s3.example.test', region: 'ap-south-1', bucket: 'nt', accessKeyId: 'AK', secretAccessKey: 'SK', fetchFn, now: () => new Date('2026-10-29T12:00:00Z') });
  const key = await s.put(Buffer.from('abc'));
  assert.match(key, /^[a-f0-9]{32}$/);
  assert.equal((await s.get(key)).toString(), 'abc');
  const h = seen[0].h;
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AK\/20261029\/ap-south-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
  assert.ok(!('x-amz-acl' in h), 'never sets a public ACL');
  await assert.rejects(s.get('../etc/passwd'));
  await assert.rejects(s.get('a'.repeat(32)));
});

test('s3 store: endpoint path prefix (e.g. /storage/v1/s3) is part of the signed and requested path', async () => {
  const urls: string[] = [];
  const fetchFn = (async (url: string, init: any) => { urls.push(url); return init.method === 'PUT' ? new Response(null, { status: 200 }) : new Response(new Uint8Array([1])); }) as any;
  const s = s3Store({ endpoint: 'https://p.example.test/storage/v1/s3/', region: 'r', bucket: 'nt', accessKeyId: 'AK', secretAccessKey: 'SK', fetchFn });
  const key = await s.put(Buffer.from('x'));
  assert.equal(urls[0], `https://p.example.test/storage/v1/s3/nt/${key}`);
});
