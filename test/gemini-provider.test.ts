import test from 'node:test'
import assert from 'node:assert/strict'
import { reportCheck, chat, imageCheck, laptopAiStatus } from '../src/ai-provider.ts'

const ADVISORY = JSON.stringify({ summary: 's', severity_hint: 'medium', suggested_hazard: 'pothole', missing_details: [] })

function mockFetch(t: test.TestContext, replyText: string) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: any) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: replyText }] } }] }), { status: 200 })
  })
  return calls
}

const CFG = { model: 'qwen3.5:4b', timeoutMs: 5000, geminiKey: 'test-key', geminiModel: 'gemini-2.5-flash' }

test('gemini provider: report-check hits generateContent with server-side key header', async (t) => {
  const calls = mockFetch(t, ADVISORY)
  const a = await reportCheck(CFG, { hazard: 'pothole', lat: 30.7, lon: 76.7 })
  assert.equal(a.advisory, true)
  assert.equal(a.model, 'gemini-2.5-flash')
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent/)
  assert.equal(calls[0].headers['x-goog-api-key'], 'test-key')
})

test('gemini provider: image-check sends the photo as inline_data and parses mismatch wording', async (t) => {
  const calls = mockFetch(t, JSON.stringify({ summary: 'Not a photo of a pothole - the photo shows a wall.', severity_hint: null, suggested_hazard: null, missing_details: ['road surface not visible'] }))
  const a = await imageCheck(CFG, { image_base64: 'QUJD', hazard: 'pothole' })
  assert.match(a.summary, /Not a photo of a pothole/)
  const parts = calls[0].body.contents[0].parts
  assert.equal(parts[1].inline_data.data, 'QUJD')
})

test('gemini provider: status reports the gemini model when key set', async (t) => {
  mockFetch(t, 'ok')
  const s = await laptopAiStatus(CFG)
  assert.deepEqual(s, { configured: true, available: true, model: 'gemini-2.5-flash' })
})

test('gemini provider: chat parses reply json', async (t) => {
  mockFetch(t, JSON.stringify({ reply: 'Open My reports to track it.' }))
  const r = await chat(CFG, { message: 'how do I track?' })
  assert.equal(r.reply, 'Open My reports to track it.')
  assert.equal(r.model, 'gemini-2.5-flash')
})
