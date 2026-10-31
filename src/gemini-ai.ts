/**
 * Google Gemini (AI Studio API key) provider - same function surface as
 * laptop-ai.ts so the routes can pick either backend. The key stays
 * server-side only (GEMINI_API_KEY env); it is never shipped to the app or
 * website. Consent gates in app.ts apply unchanged before any call here.
 *
 * PRIVACY NOTE (grounded in ai.google.dev/gemini-api/docs/pricing, Oct 2026):
 * on the FREE tier Google may use submitted content to improve its products;
 * the paid tier does not. The consent notice must say prompts and photos go
 * to Google, and free-tier use must be disclosed as such.
 */

import {
  Advisory,
  ChatReply,
  ContractorBrief,
  EmailDraft,
  LaptopAiError,
  parseAdvisory,
  parseChatReply,
  stripThinking,
} from './laptop-ai.ts';

export type GeminiConfig = {
  apiKey?: string;
  model: string;
  timeoutMs: number;
};

/** Sniff the real image type from the base64 payload header - never trust a hardcoded mime. */
export function sniffImageMime(b64: string): 'image/jpeg' | 'image/png' {
  const head = Buffer.from(b64.slice(0, 16), 'base64')
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  return 'image/jpeg' // JPEG (ffd8) and anything unrecognized: the API treats it as jpeg
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function requireKey(cfg: GeminiConfig): string {
  if (!cfg.apiKey) throw new LaptopAiError('not_configured', 'GEMINI_API_KEY not set');
  return cfg.apiKey;
}

async function callGemini(cfg: GeminiConfig, system: string, user: string, images?: string[]): Promise<string> {
  const key = requireKey(cfg);
  const parts: Record<string, unknown>[] = [{ text: user }];
  for (const b64 of images ?? []) {
    parts.push({ inline_data: { mime_type: sniffImageMime(b64), data: b64 } });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.2 },
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    const body = await res.text();
    // Upstream error bodies stay out of our errors entirely: status only, no Google payload.
    if (!res.ok) throw new LaptopAiError('laptop_unreachable', `gemini http ${res.status}`);
    let json: any;
    try { json = JSON.parse(body); } catch { throw new LaptopAiError('bad_output', 'gemini returned non-JSON envelope'); }
    const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
    if (!text.trim()) throw new LaptopAiError('bad_output', 'gemini returned empty content');
    return stripThinking(text);
  } catch (e) {
    if (e instanceof LaptopAiError) throw e;
    if ((e as Error).name === 'AbortError') throw new LaptopAiError('timeout', 'gemini request timed out');
    throw new LaptopAiError('laptop_unreachable', `gemini request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

const JSON_SYSTEM = 'You are the road-hazard assistant inside the NagarTrace civic app. Answer ONLY with the JSON object the user prompt describes - no markdown fences, no commentary. Never invent official records, complaint numbers or guarantees; if something is not visible or unknown, say so inside the JSON.';

export async function geminiStatus(cfg: GeminiConfig): Promise<{ configured: boolean; available: boolean; model?: string; reason?: string }> {
  // CONFIG-ONLY on purpose: a status poll must never place an outbound model call
  // (cost + data-egress on an unauthenticated-adjacent probe). Availability is only
  // proven by a real consented feature call, which reports its own errors.
  if (!cfg.apiKey) return { configured: false, available: false, reason: 'not_configured' };
  return { configured: true, available: true, model: cfg.model, reason: 'config only - not verified by a live call' };
}

export async function reportCheck(cfg: GeminiConfig, input: { hazard: string; note?: string; lat: number; lon: number; ward?: string }): Promise<Advisory> {
  const user = `A citizen is reporting a road hazard. Respond with JSON {"summary": string, "severity_hint": "low"|"medium"|"high"|null, "suggested_hazard": string|null, "missing_details": string[]}. Base it only on these fields; do not invent inspections or outcomes.\n${JSON.stringify(input)}`;
  return parseAdvisory(await callGemini(cfg, JSON_SYSTEM, user), cfg.model);
}

export async function chat(cfg: GeminiConfig, input: { message: string; context?: Record<string, unknown> | null }): Promise<ChatReply> {
  const system = 'You are the road-hazard guide inside the NagarTrace civic app. Answer briefly and practically about reporting road hazards, tracking report status, contractor records and complaint drafts. Never invent complaint numbers, official actions or deadlines. Respond with JSON {"reply": string}.';
  const user = JSON.stringify({ message: input.message, context: input.context ?? null });
  return parseChatReply(await callGemini(cfg, system, user), cfg.model);
}

export async function imageCheck(cfg: GeminiConfig, input: { image_base64: string; hazard?: string; note?: string }): Promise<Advisory> {
  const user = `Look at this photo of a reported road hazard. The citizen selected hazard type: ${input.hazard ?? 'unknown'}. If the photo does not actually show that hazard, suggested_hazard must be what the photo actually shows (or null) and the summary must say plainly that it does not match, e.g. "Not a photo of a pothole". Respond with JSON {"summary": string, "severity_hint": "low"|"medium"|"high"|null, "suggested_hazard": string|null, "missing_details": string[]}. Never claim certainty you do not have.${input.note ? `\nCitizen note: ${input.note}` : ''}`;
  return parseAdvisory(await callGemini(cfg, JSON_SYSTEM, user, [input.image_base64]), cfg.model);
}

export async function emailDraft(cfg: GeminiConfig, input: { hazard: string; note?: string; lat: number; lon: number; ward?: string; complaint_no?: string }): Promise<EmailDraft> {
  const user = `Draft a short, formal complaint email to the municipal road officer about this hazard. The app never sends it - the citizen reviews and sends it. Respond with JSON {"subject": string, "body": string}. Use only these facts, no invented reference numbers:\n${JSON.stringify(input)}`;
  const raw = await callGemini(cfg, JSON_SYSTEM, user);
  let parsed: any;
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim()); } catch { throw new LaptopAiError('bad_output', 'gemini email draft not JSON'); }
  if (typeof parsed?.subject !== 'string' || typeof parsed?.body !== 'string') throw new LaptopAiError('bad_output', 'gemini email draft missing fields');
  return { subject: parsed.subject, body: parsed.body, draft: true, model: cfg.model, advisory: true };
}

export async function contractorBrief(cfg: GeminiConfig, rows: Record<string, unknown>[]): Promise<ContractorBrief> {
  const user = `Summarize these contractor records retrieved from the awards database for a citizen. Only use the rows given - every fact must come from them; if they are empty, say no matching records were found. Respond with JSON {"summary": string, "key_facts": string[]}.\n${JSON.stringify(rows).slice(0, 20000)}`;
  const raw = await callGemini(cfg, JSON_SYSTEM, user);
  let parsed: any;
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim()); } catch { throw new LaptopAiError('bad_output', 'gemini brief not JSON'); }
  if (typeof parsed?.summary !== 'string' || !Array.isArray(parsed?.key_facts)) throw new LaptopAiError('bad_output', 'gemini brief missing fields');
  return { summary: parsed.summary, record_count: rows.length, key_facts: parsed.key_facts.map(String), model: cfg.model, advisory: true };
}
