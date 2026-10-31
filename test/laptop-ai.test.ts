import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, userToken, client } from './helpers.ts';
import { validateLaptopAiConfig, admitReportCheck, parseAdvisory, stripThinking, buildChatPayload, buildLocationLine, validateDraftGrounding, LaptopAiError } from '../src/laptop-ai.ts';

test('report-check: invalid input is 400 and never consumes a budget slot (leak regression)', async () => {
  const w = await newWorld({ aiAccessMode: 'test' }); // laptop UNCONFIGURED (default)
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
  const w = await newWorld({ aiAccessMode: 'test' });
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
  const w = await newWorld({ aiAccessMode: 'test' });
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

// ---------- four-route additions: chat, email-draft, image-check, contractor-brief ----------

test('chat: unauthenticated 401, invalid message 400 without consuming a budget slot', async () => {
  const w = await newWorld({ aiAccessMode: 'test' });
  try {
    assert.equal((await w.app.inject({ method: 'POST', url: '/v1/ai/chat', payload: { message: 'hi' } })).statusCode, 401);
    const c = client(w, await userToken('u-chat'));
    for (let i = 0; i < 3; i++) {
      assert.equal((await c.post('/v1/ai/chat', { message: '' })).status, 400);
      assert.equal((await c.post('/v1/ai/chat', { message: 'x'.repeat(1001) })).status, 400);
      assert.equal((await c.post('/v1/ai/chat', { message: 'ok', issue_id: 'not-a-uuid' })).status, 400);
    }
    const r = await c.post('/v1/ai/chat', { message: 'What does reported mean?' });
    assert.equal(r.status, 503);
    assert.equal(r.json.reason, 'not_configured'); // slot reached config check, never leaked on 400s
  } finally { await w.close(); }
});

test('email-draft: invalid input 400, valid input honest not_configured, contract is draft-only', async () => {
  const w = await newWorld({ aiAccessMode: 'test' });
  try {
    const c = client(w, await userToken('u-draft'));
    assert.equal((await c.post('/v1/ai/email-draft', { hazard: 'nonsense', lat: 1, lon: 2 })).status, 400);
    assert.equal((await c.post('/v1/ai/email-draft', { hazard: 'pothole', lat: 999, lon: 2 })).status, 400);
    const r = await c.post('/v1/ai/email-draft', { hazard: 'pothole', lat: 30.7, lon: 76.7, ward: 'Ward 9' });
    assert.equal(r.status, 503);
    assert.equal(r.json.reason, 'not_configured');
  } finally { await w.close(); }
});

test('image-check: rejects bad image payloads before budget, honest not_configured otherwise', async () => {
  const w = await newWorld({ aiAccessMode: 'test' });
  try {
    assert.equal((await w.app.inject({ method: 'POST', url: '/v1/ai/image-check', payload: { image_base64: 'A'.repeat(200) } })).statusCode, 401);
    const c = client(w, await userToken('u-img'));
    assert.equal((await c.post('/v1/ai/image-check', { image_base64: 'short' })).status, 400);
    assert.equal((await c.post('/v1/ai/image-check', { image_base64: 'A'.repeat(200) + '!!!' })).status, 400);
    assert.equal((await c.post('/v1/ai/image-check', { image_base64: 'A'.repeat(200), hazard: 'nonsense' })).status, 400);
    const r = await c.post('/v1/ai/image-check', { image_base64: 'A'.repeat(200), hazard: 'pothole' });
    assert.equal(r.status, 503);
    assert.equal(r.json.reason, 'not_configured');
  } finally { await w.close(); }
});

test('contractor-brief: validation 400; no rows/registry short-circuits found:false with NO model call', async () => {
  const w = await newWorld({ aiAccessMode: 'test' });
  try {
    const c = client(w, await userToken('u-contr'));
    assert.equal((await c.post('/v1/ai/contractor-brief', { contractor_name: 'x' })).status, 400);
    const r = await c.post('/v1/ai/contractor-brief', { contractor_name: 'Some Builder Ltd' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ai_available, true);
    assert.equal(r.json.found, false); // empty test registry (or absent table): honest, model never consulted
    assert.ok(r.json.reason === 'no_matching_records' || r.json.reason === 'registry_not_loaded');
    assert.equal(r.json.brief, null);
  } finally { await w.close(); }
});

test('chat is guide-scope: issue context rejected, plain message reaches the laptop gate', async () => {
  const w = await newWorld({ aiAccessMode: 'test' });
  try {
    const c = client(w, await userToken('u-ctx'));
    // Capability isolation: any issue_id - valid or not - is refused, no DB read happens.
    const bad = await c.post('/v1/ai/chat', { message: 'status?', issue_id: '00000000-0000-0000-0000-000000000000' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.message, /platform guide/);
    // Plain guide question still reaches the (unconfigured) laptop gate.
    const r = await c.post('/v1/ai/chat', { message: 'how do I report a pothole?' });
    assert.equal(r.status, 503);
    assert.equal(r.json.reason, 'not_configured');
  } finally { await w.close(); }
});

// ---------- unit: strict output parsers ----------

test('chat/email/contractor parsers: strict shapes, no partial passes', async () => {
  const { parseChatReply, parseEmailDraft, parseContractorBrief, contractorBrief } = await import('../src/laptop-ai.ts');
  assert.throws(() => parseChatReply('not json', 'm'), /not JSON/);
  assert.throws(() => parseChatReply('{"reply":""}', 'm'), /missing\/empty\/oversized/);
  assert.throws(() => parseChatReply(`{"reply":"${'x'.repeat(1501)}"}`, 'm'), /oversized/);
  assert.equal(parseChatReply('{"reply":"Your report is listed as reported."}', 'm').reply, 'Your report is listed as reported.');
  assert.throws(() => parseEmailDraft('{"subject":"s"}', 'm'), /body/);
  assert.throws(() => parseEmailDraft('{"subject":"","body":"b"}', 'm'), /subject/);
  const d = parseEmailDraft('{"subject":"Pothole on NH-44","body":"Dear sir"}', 'm');
  assert.equal(d.draft, true);
  assert.throws(() => parseContractorBrief('{"summary":"s","record_count":3,"key_facts":[]}', 'm', 2), /record_count/); // count mismatch = fabrication guard
  assert.throws(() => parseContractorBrief(`{"summary":"s","record_count":1,"key_facts":["${'x'.repeat(161)}"]}`, 'm', 1), /key_facts item/);
  const b = parseContractorBrief('{"summary":"Two awards listed.","record_count":2,"key_facts":["Project A"]}', 'm', 2);
  assert.equal(b.record_count, 2);
  await assert.rejects(() => contractorBrief({ url: 'https://gw.example.com', token: 't', model: 'm', timeoutMs: 5000 }, []), /no rows/); // empty rows never reach the model
});

test('vision gate: text-only model refuses photo checks honestly', async () => {
  const { requireVisionModel } = await import('../src/laptop-ai.ts');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 })) as any;
    await assert.rejects(
      () => requireVisionModel({ url: 'https://gw.example.com', token: 't', model: 'qwen-text', timeoutMs: 5000 }),
      (e: any) => e instanceof LaptopAiError && e.reason === 'model_not_vision');
    globalThis.fetch = (async () => new Response(JSON.stringify({ capabilities: ['completion', 'vision'] }), { status: 200 })) as any;
    await requireVisionModel({ url: 'https://gw.example.com', token: 't', model: 'qwen-vl', timeoutMs: 5000 }); // passes
    await assert.rejects(
      () => requireVisionModel({ token: 't', model: 'm', timeoutMs: 5000 } as any),
      (e: any) => e.reason === 'not_configured');
  } finally { globalThis.fetch = realFetch; }
});

test('shared budget: chat/email/image/contractor draw on the SAME per-user and in-flight counters as report-check', async () => {
  const { admitInference } = await import('../src/laptop-ai.ts');
  // Per-user window is shared: 5 sequential admit+release cycles via the new routes still
  // count against the same user cap that report-check checks.
  for (let i = 0; i < 5; i++) {
    const a = admitInference('u-shared');
    assert.ok(a.ok, `slot ${i}`);
    if (a.ok) a.done(); // release in-flight; the per-user timestamp remains
  }
  const sixth = admitReportCheck('u-shared');
  assert.equal(sixth.ok, false);
  if (!sixth.ok) assert.equal(sixth.reason, 'rate_limited'); // same user window across ALL AI routes
  // In-flight ceiling is also shared across routes: 2 open slots (one per route family)
  // make a third route's admission 'busy' even for a fresh user.
  const s1 = admitInference('u-inf-a'); assert.ok(s1.ok);
  const s2 = admitReportCheck('u-inf-b'); assert.ok(s2.ok);
  const s3 = admitInference('u-inf-c');
  assert.equal(s3.ok, false);
  if (!s3.ok) assert.equal(s3.reason, 'busy');
  if (s1.ok) s1.done(); if (s2.ok) s2.done();
  const other = admitInference('u-shared-other');
  assert.ok(other.ok); // different user unaffected by u-shared's window
  if (other.ok) other.done();
});

test('stripThinking: complete think blocks removed, final JSON parsed; reasoning never reaches callers', () => {
  const json = '{"summary":"ok","severity_hint":null,"suggested_hazard":null,"missing_details":[]}';
  assert.equal(stripThinking(`<think>long reasoning here</think>${json}`), json);
  assert.equal(stripThinking(`  <think>a</think>\n<think>b</think>\n${json}  `), json);
  assert.equal(stripThinking(json), json); // untouched when no think block
  assert.equal(stripThinking('no tags at all'), 'no tags at all');
  // an UNCLOSED think block is not stripped - the strict parser must reject it downstream
  const unclosed = stripThinking('<think>never closed {"summary":"x"}');
  assert.ok(unclosed.startsWith('<think>'));
  assert.throws(() => parseAdvisory(unclosed, 'm'), /not JSON/);
  // full path: wrapped advisory parses to the same strict shape
  const adv = parseAdvisory(stripThinking(`<think>thinking</think>${json}`), 'qwen3.5:2b');
  assert.equal(adv.summary, 'ok');
});


test('payload contract: EVERY structured call sends think:false (measured 2B failures); images ride the user message', () => {
  const cfg = { url: 'https://gw.example', token: 't', model: 'qwen3.5:2b', timeoutMs: 5000 } as any;
  const img = buildChatPayload(cfg, 'sys', { hazard: 'pothole' }, ['QUJD']);
  assert.equal(img.think, false);
  assert.equal(img.format, 'json');
  assert.equal(img.stream, false);
  assert.equal(img.model, 'qwen3.5:2b');
  const msgs = img.messages as any[];
  assert.equal(msgs[1].role, 'user');
  assert.deepEqual(msgs[1].images, ['QUJD']); // image rides the user message, not the body root
  const text = buildChatPayload(cfg, 'sys', { message: 'hi' }, undefined);
  assert.equal(text.think, false); // thinking disabled for text calls too: default-on emptied/invalidated outputs
  const textMsgs = text.messages as any[];
  assert.equal('images' in textMsgs[1], false);
});

test('draft grounding: invented city rejected, deterministic location line required, complaint ref unaltered', () => {
  const input = { hazard: 'pothole', note: 'gehra gaddha main road pe', lat: 30.3398, lon: 76.3869, ward: 'Ward 12', complaint_no: 'NT-TEST-1' };
  const line = buildLocationLine(input);
  assert.equal(line, 'Location: lat 30.339800, lon 76.386900, Ward 12 (Ref: NT-TEST-1)');
  // the exact 2B failure observed live: model invented "Nagpur"
  assert.throws(() => validateDraftGrounding({ subject: 'Grievance: Pothole (Nagpur)', body: `Dear sir, ${line} in Nagpur ref NT-TEST-1` }, input), /invented place/);
  // dropped location line rejected
  assert.throws(() => validateDraftGrounding({ subject: 's', body: 'Dear sir, there is a pothole. Ref NT-TEST-1' }, input), /location line/);
  // altered complaint ref rejected
  assert.throws(() => validateDraftGrounding({ subject: 's', body: `${line.replace('NT-TEST-1','XX-9')} and more` }, input), /location line|complaint/);
  // clean draft passes; a city the USER mentioned is allowed
  validateDraftGrounding({ subject: 'Grievance: pothole', body: `Dear sir, ${line}. The road has a deep pothole. Kindly act.` }, input);
  validateDraftGrounding({ subject: 'Patiala road', body: `${line}` }, { ...input, note: 'patiala main road pe gaddha' });
  // no ward/ref: line has neither, and no ref requirement
  assert.equal(buildLocationLine({ lat: 1, lon: 2 }), 'Location: lat 1.000000, lon 2.000000');
});

describe('laptop AI kill-switch (default off: no real user data to the laptop)', () => {
  test('default mode refuses every AI route even when LAPTOP_AI_URL/token are configured', async () => {
    const w = await newWorld({ laptopAiUrl: 'http://127.0.0.1:9', laptopAiToken: 't' }); // aiAccessMode default 'off'
    try {
      const u = await userToken('kill-user');
      const c = client(w, u);
      const posts: [string, unknown][] = [
        ['/v1/ai/report-check', { hazard: 'pothole', lat: 1, lon: 2 }],
        ['/v1/ai/chat', { message: 'hi' }],
        ['/v1/ai/email-draft', { hazard: 'pothole', lat: 1, lon: 2 }],
        ['/v1/ai/image-check', { image_base64: 'A'.repeat(200) }],
        ['/v1/ai/contractor-brief', { ward: 'W1' }],
      ];
      for (const [url, body] of posts) {
        const r = await c.post(url, body);
        assert.equal(r.status, 503, url);
        assert.deepEqual(r.json, { ai_available: false, reason: 'ai_disabled' }, url);
      }
      const st = await c.get('/v1/ai/status');
      assert.equal(st.status, 200);
      assert.deepEqual(st.json, { ai_available: false, reason: 'ai_disabled' }); // no config details leak
    } finally { await w.close(); }
  });

  test('unknown AI_ACCESS_MODE values fall back to off', async () => {
    const { fromEnv } = await import('../src/config.ts');
    const env = { AUTH_ISSUER: 'i', AUTH_AUDIENCE: 'a', AUTH_JWKS_URL: 'https://x/jwks', DATABASE_URL: 'postgres://x', POLICY_USE_DEV_DEFAULTS: 'synthetic-test-only', AI_ACCESS_MODE: 'all' };
    assert.equal(fromEnv(env as any).aiAccessMode, 'off');
  });

  test('production boot refuses AI_ACCESS_MODE=test (fail-closed, no laptop proxy in prod)', async () => {
    const { fromEnv } = await import('../src/config.ts');
    const env = { AUTH_ISSUER: 'i', AUTH_AUDIENCE: 'a', AUTH_JWKS_URL: 'https://x/jwks', DATABASE_URL: 'postgres://x', NODE_ENV: 'production', AI_ACCESS_MODE: 'test' };
    assert.throws(() => fromEnv(env as any), /AI_ACCESS_MODE=test cannot be used with NODE_ENV=production/);
  });
});

test('scoped mode: deny-by-default - unlisted principal gets 403 ai_not_allowed, listed principal reaches the config check', async () => {
  const w = await newWorld({ aiAccessMode: 'scoped', aiAllowedSubjects: ['owner-real-1'] }); // laptop unconfigured
  try {
    const outsider = client(w, await userToken('someone-else'));
    // Every AI route refuses the unlisted principal BEFORE any user content is processed:
    assert.equal((await outsider.post('/v1/ai/report-check', { hazard: 'pothole', lat: 30.7, lon: 76.7 })).status, 403);
    const chat = await outsider.post('/v1/ai/chat', { message: 'how does reporting work?' });
    assert.equal(chat.status, 403); assert.equal(chat.json.reason, 'ai_not_allowed');
    assert.equal((await outsider.post('/v1/ai/email-draft', { hazard: 'pothole', lat: 30.7, lon: 76.7 })).status, 403);
    assert.equal((await outsider.post('/v1/ai/contractor-brief', { contractor_name: 'Acme' })).status, 403);
    // The listed principal passes the scope gate (then hits the honest not_configured 503):
    const listed = client(w, await userToken('owner-real-1'));
    const r = await listed.post('/v1/ai/report-check', { hazard: 'pothole', lat: 30.7, lon: 76.7 });
    assert.equal(r.status, 503); assert.equal(r.json.reason, 'not_configured');
    // Availability status stays open to everyone (it leaks no config details when off):
    const st = await outsider.get('/v1/ai/status'); assert.equal(st.status, 200);
  } finally { await w.close(); }
});

test('scoped mode with an empty allowlist cannot boot (fail closed, never silently allows)', async () => {
  const origMode = process.env.AI_ACCESS_MODE; const origSubs = process.env.AI_ALLOWED_SUBJECTS;
  process.env.AI_ACCESS_MODE = 'scoped'; delete process.env.AI_ALLOWED_SUBJECTS;
  try {
    const { fromEnv } = await import('../src/config.ts');
    assert.throws(() => fromEnv(), /AI_ALLOWED_SUBJECTS/);
  } finally {
    if (origMode === undefined) delete process.env.AI_ACCESS_MODE; else process.env.AI_ACCESS_MODE = origMode;
    if (origSubs !== undefined) process.env.AI_ALLOWED_SUBJECTS = origSubs;
  }
});

test('consented mode: per-feature consent required, grant unlocks ONLY that feature, revoke re-denies, stale notice rejected, no cross-user bleed', async () => {
  const w = await newWorld({ aiAccessMode: 'consented' }); // laptop unconfigured
  try {
    const u = client(w, await userToken('consent-u'));
    const other = client(w, await userToken('consent-other'));
    // Notice is public and versioned:
    const n = await u.get('/v1/ai/consent-notice');
    assert.equal(n.status, 200); assert.equal(n.json.version, 'v1'); assert.ok(n.json.text.includes('NOT end-to-end encrypted'));
    assert.deepEqual(n.json.features, ['guide_chat', 'email_draft', 'photo_advisory', 'contractor_finder']);
    // No consent rows: every feature denies with consent_required BEFORE any input is processed:
    for (const [path, body] of [
      ['/v1/ai/chat', { message: 'how do I report?' }],
      ['/v1/ai/email-draft', { hazard: 'pothole', lat: 30.7, lon: 76.7 }],
      ['/v1/ai/report-check', { hazard: 'pothole', lat: 30.7, lon: 76.7 }],
      ['/v1/ai/contractor-brief', { contractor_name: 'Acme' }],
    ] as const) {
      const r = await u.post(path, body);
      assert.equal(r.status, 403, path); assert.equal(r.json.reason, 'consent_required');
    }
    // Stale/wrong notice version cannot grant:
    assert.equal((await u.post('/v1/ai/consents', { feature: 'guide_chat', notice_version: 'v0' })).status, 409);
    // Grant guide_chat with the current notice: unlocks ONLY guide_chat (cross-feature bleed check):
    const g = await u.post('/v1/ai/consents', { feature: 'guide_chat', notice_version: 'v1' });
    assert.equal(g.status, 200);
    const chat = await u.post('/v1/ai/chat', { message: 'how do I report?' });
    assert.equal(chat.status, 503); assert.equal(chat.json.reason, 'not_configured'); // passed consent, hit honest offline
    assert.equal((await u.post('/v1/ai/email-draft', { hazard: 'pothole', lat: 30.7, lon: 76.7 })).status, 403); // email still denied
    // Another user gains nothing from u's grant:
    assert.equal((await other.post('/v1/ai/chat', { message: 'hi' })).status, 403);
    // Consent listing shows the grant:
    const list = await u.get('/v1/ai/consents');
    assert.equal(list.json.consents.length, 1); assert.equal(list.json.consents[0].feature, 'guide_chat'); assert.equal(list.json.consents[0].revoked_at, null);
    // Revoke re-denies immediately, and the audit trail recorded grant + revoke:
    assert.equal((await u.post('/v1/ai/consents/revoke', { feature: 'guide_chat' })).status, 200);
    assert.equal((await u.post('/v1/ai/chat', { message: 'hi' })).status, 403);
    const evs = (await w.adminDb.query('SELECT action FROM ai_consent_events ORDER BY id')).rows.map((r) => r.action);
    assert.deepEqual(evs, ['granted', 'revoked']);
  } finally { await w.close(); }
});

test('revoke mid-flight: dispatched request completes honestly; every NEW dispatch denied after revoke, gateway never sees it', async () => {
  const realFetch = globalThis.fetch;
  const received: any[] = [];
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  globalThis.fetch = (async (url: any, init: any) => {
    received.push({ url: String(url), body: JSON.parse(init.body) });
    await hold; // gateway holds the in-flight response until the test releases it
    return new Response(JSON.stringify({ message: { content: '{"reply":"stub answer"}' } }), { status: 200 });
  }) as any;
  try {
    const w = await newWorld({ aiAccessMode: 'consented', laptopAiUrl: 'https://gw.example', laptopAiToken: 't', laptopAiModel: 'qwen3.5:2b' });
    try {
      const u = client(w, await userToken('race-u'));
      assert.equal((await u.post('/v1/ai/consents', { feature: 'guide_chat', notice_version: 'v1' })).status, 200);
      const inflight = u.post('/v1/ai/chat', { message: 'how do I report?' });
      for (let i = 0; i < 200 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 5)); // wait for dispatch
      assert.equal(received.length, 1, 'dispatch did not reach the gateway');
      // Payload hygiene at the wire: only the listed input travels - no IDs, no records.
      const pl = received[0].body;
      assert.deepEqual(Object.keys(pl).sort(), ['format', 'messages', 'model', 'stream', 'think']);
      assert.equal(pl.messages.length, 2); // system + user, nothing else
      assert.deepEqual(JSON.parse(pl.messages[1].content), { message: 'how do I report?', context: null });
      // Revoke WHILE the forward is in flight:
      assert.equal((await u.post('/v1/ai/consents/revoke', { feature: 'guide_chat' })).status, 200);
      release(); // the already-dispatched request cannot be recalled: it completes honestly
      const done = await inflight;
      assert.equal(done.status, 200);
      assert.equal(done.json.reply, 'stub answer');
      // Every NEW dispatch after revoke is denied and never reaches the gateway:
      const next = await u.post('/v1/ai/chat', { message: 'again' });
      assert.equal(next.status, 403);
      assert.equal(next.json.reason, 'consent_required');
      assert.equal(received.length, 1, 'gateway saw a request made after revoke');
    } finally { await w.close(); }
  } finally { globalThis.fetch = realFetch; }
});
