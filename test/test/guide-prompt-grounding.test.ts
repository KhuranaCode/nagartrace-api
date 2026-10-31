import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_SYSTEM, buildChatPayload, parseChatReply } from '../src/laptop-ai.ts';

test('guide prompt: never states or implies account state (either direction)', () => {
  // Regression pin for the observed failure: a signed-in user asked "hi" and the guide
  // answered that they were "not logged in". The guide has no account access, so the
  // prompt must ban account-state claims outright - not just wrong ones.
  assert.match(CHAT_SYSTEM, /Never state or imply anything about the user's account/);
  assert.match(CHAT_SYSTEM, /whether they are signed in/);
});

test('guide prompt: greetings get a bounded welcome, not an improvised answer', () => {
  assert.match(CHAT_SYSTEM, /greeting/);
  assert.match(CHAT_SYSTEM, /one short welcome line and up to three example questions/);
});

test('guide wire contract retained: strict JSON schema, thinking off, streaming off', () => {
  const cfg = { url: 'https://gateway.invalid', token: 't', model: 'm', timeoutMs: 1000 } as any;
  const p = buildChatPayload(cfg, CHAT_SYSTEM, { message: 'hi', context: null }, undefined);
  assert.equal(p.stream, false);
  assert.equal(p.format, 'json');
  assert.equal(p.think, false);
  const msgs = p.messages as { role: string; content: string }[];
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, CHAT_SYSTEM); // prompt reaches the model verbatim
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[1].content, '{"message":"hi","context":null}'); // compact JS JSON.stringify shape
});

test('guide parser strictness retained: no partial passes', () => {
  assert.throws(() => parseChatReply('not json', 'm'), /not JSON/);
  assert.throws(() => parseChatReply('{"reply":""}', 'm'), /missing\/empty\/oversized/);
  assert.throws(() => parseChatReply(`{"reply":"${'x'.repeat(1501)}"}`, 'm'), /oversized/);
  assert.equal(parseChatReply('{"reply":"Namaste! Ask me how reporting works."}', 'm').reply, 'Namaste! Ask me how reporting works.');
});
