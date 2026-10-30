/**
 * Authenticated bridge to Manan's own laptop inference (Qwen via Ollama).
 * Accepted architecture (Oct 30): online app -> this backend -> the laptop,
 * which must be awake/online. When it is not, we say so honestly - we never
 * fabricate a suggestion. No public unauthenticated inference: every route
 * here requires a signed-in user.
 *
 * The laptop endpoint speaks Ollama's /api/chat. SECURITY REALITY: stock
 * Ollama ignores Authorization headers - the bearer token here is NOT what
 * protects it. LAPTOP_AI_URL must point at an authenticating gateway in
 * front of Ollama (e.g. cloudflared with Cloudflare Access, or a reverse
 * proxy that checks LAPTOP_AI_TOKEN before proxying). Never point this at
 * a raw, publicly reachable Ollama port.
 * Not configured = the feature is off, reported as such.
 */

export type LaptopAiConfig = {
  url?: string;
  token?: string;
  model: string;
  timeoutMs: number;
};

export type Advisory = {
  summary: string;
  severity_hint: 'low' | 'medium' | 'high' | null;
  suggested_hazard: string | null;
  missing_details: string[];
  model: string;
  advisory: true;
};

export class LaptopAiError extends Error {
  constructor(public reason: 'not_configured' | 'laptop_unreachable' | 'timeout' | 'bad_output', message: string) {
    super(message);
  }
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new LaptopAiError('timeout', 'laptop inference timed out');
    throw new LaptopAiError('laptop_unreachable', `laptop endpoint unreachable: ${e?.message ?? e}`);
  } finally {
    clearTimeout(t);
  }
}

/** Cheap reachability probe: configured + Ollama answers /api/tags. */
export async function laptopAiStatus(cfg: LaptopAiConfig): Promise<{ configured: boolean; available: boolean; model?: string; reason?: string }> {
  if (!cfg.url) return { configured: false, available: false, reason: 'not_configured' };
  try {
    const res = await fetchWithTimeout(`${cfg.url.replace(/\/$/, '')}/api/tags`, { headers: headers(cfg.token) }, Math.min(cfg.timeoutMs, 5000));
    if (!res.ok) return { configured: true, available: false, reason: `laptop_http_${res.status}` };
    return { configured: true, available: true, model: cfg.model };
  } catch (e: any) {
    return { configured: true, available: false, reason: e instanceof LaptopAiError ? e.reason : 'laptop_unreachable' };
  }
}

const SYSTEM = `You are the NagarTrace report assistant. A citizen has filed a civic road-hazard report. Reply with ONLY a JSON object, no prose, exactly this shape:
{"summary": string, "severity_hint": "low"|"medium"|"high"|null, "suggested_hazard": string|null, "missing_details": string[]}
Rules: never claim the report is verified. Never invent facts not in the input. If the note is too thin to judge, say so in missing_details. Keep summary under 40 words.`;

export async function reportCheck(cfg: LaptopAiConfig, input: { hazard: string; note?: string; lat: number; lon: number; ward?: string }): Promise<Advisory> {
  if (!cfg.url) throw new LaptopAiError('not_configured', 'laptop AI endpoint is not configured');
  const body = {
    model: cfg.model,
    stream: false,
    format: 'json',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ hazard: input.hazard, note: input.note ?? '', lat: input.lat, lon: input.lon, ward: input.ward ?? null }) },
    ],
  };
  const res = await fetchWithTimeout(`${cfg.url.replace(/\/$/, '')}/api/chat`, { method: 'POST', headers: headers(cfg.token), body: JSON.stringify(body) }, cfg.timeoutMs);
  if (!res.ok) throw new LaptopAiError('laptop_unreachable', `laptop returned HTTP ${res.status}`);
  const data: any = await res.json().catch(() => null);
  const content = data?.message?.content;
  if (typeof content !== 'string') throw new LaptopAiError('bad_output', 'no message content from model');
  let parsed: any;
  try { parsed = JSON.parse(content); } catch { throw new LaptopAiError('bad_output', 'model reply was not JSON'); }
  if (typeof parsed?.summary !== 'string' || parsed.summary.length === 0) throw new LaptopAiError('bad_output', 'model reply missing summary');
  const sev = parsed.severity_hint;
  return {
    summary: parsed.summary.slice(0, 500),
    severity_hint: sev === 'low' || sev === 'medium' || sev === 'high' ? sev : null,
    suggested_hazard: typeof parsed.suggested_hazard === 'string' ? parsed.suggested_hazard : null,
    missing_details: Array.isArray(parsed.missing_details) ? parsed.missing_details.filter((x: any) => typeof x === 'string').slice(0, 5) : [],
    model: cfg.model,
    advisory: true,
  };
}
