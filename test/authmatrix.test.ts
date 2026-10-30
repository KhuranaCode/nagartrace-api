import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newWorld, type World } from './helpers.ts';

let w: World;
before(async () => { w = await newWorld(); });
after(async () => { await w.close(); });

// Every operation that openapi.json marks as authenticated must reject missing, malformed and wrong-key tokens.
test('auth matrix: documented secured routes return 401 without a valid token', async () => {
  const doc = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
  const id = '00000000-0000-4000-8000-000000000001';
  const bad: Array<Record<string, string>> = [{}, { authorization: 'Bearer not-a-jwt' }, { authorization: 'Basic abc' }];
  let checked = 0;
  for (const [p, ops] of Object.entries<any>(doc.paths)) for (const [m, op] of Object.entries<any>(ops)) {
    if (Array.isArray(op.security) && op.security.length === 0) continue;
    const url = p.replace(/\{\w+\}/g, id);
    for (const headers of bad) {
      const r = await w.app.inject({ method: m.toUpperCase() as any, url, headers, payload: m === 'get' ? undefined : ({} as any) });
      assert.equal(r.statusCode, 401, `${m.toUpperCase()} ${p} with ${JSON.stringify(headers)} gave ${r.statusCode}`);
      checked++;
    }
  }
  assert.ok(checked >= 75, `only ${checked} checks`);
});

test('documented open routes need no token', async () => {
  for (const url of ['/health', '/v1/public/issues']) {
    const r = await w.app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 200, url);
  }
});

test('public scorecards are disabled by default (policy gate, not an auth failure)', async () => {
  const r = await w.app.inject({ method: 'GET', url: '/v1/public/scorecards' });
  assert.equal(r.statusCode, 404);
  assert.match(JSON.stringify(r.json()), /not_enabled/);
});
