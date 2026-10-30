import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVision, suggestFromImage, disabledVision, draftComplaint } from '../src/ai.js';

test('vision output is validated and always advisory', async () => {
  assert.equal(parseVision({ damage_likely: true, confidence: 1.5 }, 'm'), null);
  assert.equal(parseVision('pothole', 'm'), null);
  const s = parseVision({ damage_likely: true, confidence: 0.9, severity_hint: 'weird' }, 'm')!;
  assert.equal(s.advisory, true); assert.equal(s.severity_hint, null);
  assert.equal(await suggestFromImage(disabledVision, new Uint8Array(1)), null);
});
test('complaint draft is never sendable and never invents a recipient', () => {
  const base = { issueId: 'i1', hazard: 'pothole', lat: 1, lng: 2, reportedAt: 't' };
  const a = draftComplaint({ ...base, recipient: null });
  assert.equal(a.sendable, false); assert.equal(a.recipient_org, null); assert.ok(a.blockers.includes('no_recipient_in_registry'));
  const b = draftComplaint({ ...base, recipient: { org_name: 'X', contact_verified: false } });
  assert.ok(b.blockers.includes('recipient_contact_not_verified')); assert.match(b.text, /unverified citizen report/);
});
import { guardExternal } from '../src/ai.js';
test('external AI guard: off by default, capped, fails closed', async () => {
  let calls = 0;
  const raw = { name: 'x', analyze: async () => { calls++; return { damage_likely: true, confidence: 0.5 }; } };
  assert.equal(await suggestFromImage(guardExternal(raw, { allowSyntheticOnly: false, dailyCap: 5 }), new Uint8Array(1)), null);
  assert.equal(calls, 0);
  const g = guardExternal(raw, { allowSyntheticOnly: true, dailyCap: 2, now: () => 0 });
  const r = [await suggestFromImage(g, new Uint8Array(1)), await suggestFromImage(g, new Uint8Array(1)), await suggestFromImage(g, new Uint8Array(1))];
  assert.equal(calls, 2); assert.equal(r[2], null);
});
