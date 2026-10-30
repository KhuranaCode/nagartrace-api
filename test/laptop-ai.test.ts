import test from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, userToken, client } from './helpers.ts';
import { validateLaptopAiConfig, admitReportCheck, parseAdvisory, LaptopAiError } from '../src/laptop-ai.ts';

test('report-check: invalid input is 400 and never consumes a budget slot (leak regression)', async () => {
  const w = await newWorld(); // laptop UNCONFIGURED (default)
  try {
    const c = client(w, await userToken('u-leak'));
    for (let i = 0; i < 3; i++) {
      assert.equal((await c.post('/v1/ai/report-check', { hazard: 'nonsense', lat: 1, lon: 2 })).status, 400);
      assert.equal((await c.post('/v1/ai/report-check', { hazard: 'pothole', lat: 999, lon: 2 })).status, 400);
    }
    // After 6 invalid requests a valid one must reach the config check, never 503 busy:
    const r = await c.post('/v1/ai/report-check', { hazard: 'pothole', lat: 30.7, lon: 76.7 });
    assert.equal(r.status, 503);
    assert.equal(r.json.reason, 'not_configured');
  } finally { await w.close(); }
});

test('report-check: budget slots are released on every error path', async () => {
  const w = await newWorld();
  try {
    const c = client(w, await userToken('u-release'));
    // 6 valid-shaped requests against an unconfigured laptop: each must 503 not_configured,
    // never flip to busy/rate_limited below the per-user cap of 5... the 6th IS rate_limited (user cap 5).
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/v1/ai/report-check', { hazard: 'pothole', lat: 30.7, lon: 76.7 });
      assert.equal(r.status, 503, `call ${i}`);
      assert.equal(r.json.reason, 'not_configured', `call ${i}: slot leaked`);
    }
    const sixth = await c.post('/v1/ai/report-check', { hazard: 'pothole', lat: 30.7, lon: 76.7 });
    assert.equal(sixth.status, 503);
    assert.equal(sixth.json.reason, 'rate_limited'); // user cap works
    // a DIFFERENT user is unaffected by u-release's cap or any in-flight leak
    const c2 = client(w, await userToken('u-other'));
    const r2 = await c2.post('/v1/ai/report-check', { hazard: 'pothole', lat: 30.7, lon: 76.7 });
    assert.equal(r2.json.reason, 'not_configured');
  } finally { await w.close(); }
});

test('report-check: unauthenticated is rejected before anything else', async () => {
  const w = await newWorld();
  try {
    const r = await w.app.inject({ method: 'POST', url: '/v1/ai/report-check', payload: { hazard: 'pothole', lat: 1, lon: 2 } });
    assert.equal(r.statusCode, 401);
  } finally { await w.close(); }
});

test('config gate: https + token + model + sane timeout required', () => {
  const base = { model: 'qwen3.5:4b', timeoutMs: 25000 };
  assert.deepEqual(validateLaptopAiConfig({ ...base }), { ok: false, reason: 'not_configured' });
  assert.deepEqual(validateLaptopAiConfig({ ...base, url: 'http://1.2.3.4:11434' }), { ok: false, reason: 'misconfigured' }); // no plain HTTP
  assert.deepEqual(validateLaptopAiConfig({ ...base, url: 'https://gw.example' }), { ok: false, reason: 'misconfigured' }); // token required
  assert.deepEqual(validateLaptopAiConfig({ ...base, url: 'https://gw.example', token: 't', timeoutMs: 50 }), { ok: false, reason: 'misconfigured' }); // timeout bounded
  assert.deepEqual(validateLaptopAiConfig({ ...base, url: 'not a url', token: 't' }), { ok: false, reason: 'misconfigured' });
  const ok = validateLaptopAiConfig({ ...base, url: 'https://gw.example/', token: 't' });
  assert.equal(ok.ok, true);
});

test('budgets: 2 in flight max, done() releases, 5 per user per window', () => {
  const a = admitReportCheck('u1'); assert.equal(a.ok, true);
  const b = admitReportCheck('u2'); assert.equal(b.ok, true);
  const c = admitReportCheck('u3'); assert.deepEqual(c, { ok: false, reason: 'busy' });
  if (a.ok) a.done();
  const d = admitReportCheck('u3'); assert.equal(d.ok, true);
  if (b.ok) b.done(); if (d.ok) d.done();
  for (let i = 0; i < 4; i++) { const r = admitReportCheck('cap'); assert.equal(r.ok, true); if (r.ok) r.done(); }
  const sixth = admitReportCheck('cap'); // 5 prior admissions in window (a/b/d released but counted? no - different users)
  assert.equal(sixth.ok, true); // 'cap' has 5 admissions now (4 + this one)
  const seventh = admitReportCheck('cap');
  assert.deepEqual(seventh, { ok: false, reason: 'rate_limited' });
  if (sixth.ok) sixth.done();
});

test('output validation: strict enum, no invented hazards, bounded fields', () => {
  const good = parseAdvisory(JSON.stringify({ summary: 'Deep pothole at the junction.', severity_hint: 'high', suggested_hazard: 'pothole', missing_details: ['exact lane'] }), 'm');
  assert.equal(good.advisory, true); assert.equal(good.severity_hint, 'high'); assert.equal(good.suggested_hazard, 'pothole');
  // STRICT: every schema violation rejects the whole reply - no partial normalization.
  assert.throws(() => parseAdvisory(JSON.stringify({ summary: 'x', severity_hint: 'catastrophic', suggested_hazard: null, missing_details: [] }), 'm'), LaptopAiError);
  assert.throws(() => parseAdvisory(JSON.stringify({ summary: 'x', suggested_hazard: null, missing_details: [] }), 'm'), LaptopAiError); // severity missing
  assert.throws(() => parseAdvisory(JSON.stringify({ summary: '', severity_hint: 'low', suggested_hazard: null, missing_details: [] }), 'm'), LaptopAiError);
  assert.throws(() => parseAdvisory('not json', 'm'), LaptopAiError);
  assert.throws(() => parseAdvisory(JSON.stringify({ summary: 'x', severity_hint: 'low', suggested_hazard: null, missing_details: 'lots' }), 'm'), LaptopAiError);
  assert.throws(() => parseAdvisory(JSON.stringify({ summary: 'x', severity_hint: 'low', suggested_hazard: null }), 'm'), LaptopAiError); // details missing
  assert.throws(() => parseAdvisory(JSON.stringify({ summary: 'x', severity_hint: 'low', suggested_hazard: null, missing_details: ['y'.repeat(200)] }), 'm'), LaptopAiError);
  assert.throws(() => parseAdvisory(JSON.stringify({ summary: 'x', severity_hint: 'low', suggested_hazard: null, missing_details: ['a','b','c','d','e','f'] }), 'm'), LaptopAiError); // >5 rejects, no truncation
  assert.throws(() => parseAdvisory(JSON.stringify({ summary: 'x', severity_hint: 'low', suggested_hazard: 'alien_base', missing_details: [] }), 'm'), LaptopAiError); // invented hazard rejects
  const nullish = parseAdvisory(JSON.stringify({ summary: 'x', severity_hint: null, suggested_hazard: null, missing_details: [] }), 'm');
  assert.equal(nullish.severity_hint, null); // explicit null is in-contract
});
