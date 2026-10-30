import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Drift guard: every route in src/app.ts must be in docs/openapi.json, and vice versa.
test('openapi draft lists exactly the registered routes', () => {
  const src = readFileSync('src/app.ts', 'utf8');
  const routes = new Set([...src.matchAll(/app\.(get|post|patch|put|delete)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2].replace(/:(\w+)/g, '{$1}')}`));
  const doc = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
  const documented = new Set<string>();
  for (const [p, ops] of Object.entries<any>(doc.paths)) for (const m of Object.keys(ops)) documented.add(`${m} ${p}`);
  const norm = (s: string) => s.replace(/\{(id|eid)\}/g, '{x}');
  const a = [...routes].map(norm).sort(), b = [...documented].map(norm).sort();
  assert.deepEqual(a, b);
});
