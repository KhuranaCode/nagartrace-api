/**
 * Authenticated bridge to Manan's own laptop inference (Qwen via Ollama).
 * Accepted architecture (Oct 30): online app -> this backend -> the laptop,
 * which must be awake/online. When it is not, we say so honestly - we never
 * fabricate a suggestion. No public unauthenticated inference: every route
 * here requires a signed-in user.
 *
 * SECURITY MODEL (enforced below, not just documented):
 * - The laptop endpoint speaks Ollama's /api/chat. Stock Ollama ignores
 *   Authorization headers, so LAPTOP_AI_URL must point at an authenticating
 *   gateway in front of Ollama (e.g. cloudflared with Cloudflare Access, or
 *   a reverse proxy that checks LAPTOP_AI_TOKEN before proxying).
 * - We therefore REFUSE unsafe config: https-only URLs and a required token.
 * - We never follow redirects (a redirect could carry the token elsewhere).
 * - The timeout covers the WHOLE exchange, headers and body - a slow-loris
 *   body cannot hang a worker.
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
  constructor(public reason: 'not_configured' | 'misconfigured' | 'laptop_unreachable' | 'timeout' | 'bad_output', message: string) {
    super(message);
  }
}

/** Config must be explicitly safe: https URL + bearer token for the gateway. Anything else is off. */
export function validateLaptopAiConfig(cfg: LaptopAiConfig): { ok: true; base: string } | { ok: false; reason: 'not_configured' | 'misconfigured' } {
  if (!cfg.url) return { ok: false, reason: 'not_configured' };
  let u: URL;
  try { u = new URL(cfg.url); } catch { return { ok: false, reason: 'misconfigured' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'misconfigured' }; // no plain HTTP, no raw Ollama port
  // Normalized destination policy: credentials-in-URL, query/fragment, loopback and the default
  // Ollama port are all rejected - the endpoint must be a deliberate https gateway host.
  if (u.username || u.password) return { ok: false, reason: 'misconfigured' };
  if (u.search || u.hash) return { ok: false, reason: 'misconfigured' };
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) return { ok: false, reason: 'misconfigured' };
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return { ok: false, reason: 'misconfigured' }; // literal private IPs
  if (u.port === '11434') return { ok: false, reason: 'misconfigured' }; // default raw Ollama port
  if (!cfg.token) return { ok: false, reason: 'misconfigured' }; // gateway secret required
  if (!cfg.model) return { ok: false, reason: 'misconfigured' };
  if (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs < 1000 || cfg.timeoutMs > 60000) return { ok: false, reason: 'misconfigured' };
  // Normalized base: origin + cleaned path, no trailing slash; endpoints join below via new URL.
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  return { ok: true, base };
}

function headers(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

/** fetch + FULL body read under one abort clock; redirects are errors, never followed. */
async function fetchTextWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, redirect: 'error' });
    // Bounded streaming read: abort the moment the cap is exceeded - never allocate an unbounded body.
    const CAP = 1024 * 1024;
    const reader = res.body?.getReader();
    if (!reader) return { status: res.status, body: '' };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read(); // still under the clock: dribble cannot outlive the timeout
      if (done) break;
      total += value.byteLength;
      if (total > CAP) { ac.abort(); throw new LaptopAiError('bad_output', 'laptop response exceeded 1MB cap'); }
      chunks.push(value);
    }
    const body = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    return { status: res.status, body };
  } catch (e: any) {
    if (e instanceof LaptopAiError) throw e; // our own typed errors (e.g. size cap) pass through unchanged
    if (e?.name === 'AbortError') throw new LaptopAiError('timeout', 'laptop inference timed out');
    throw new LaptopAiError('laptop_unreachable', `laptop endpoint unreachable: ${e?.message ?? e}`);
  } finally {
    clearTimeout(t);
  }
}

/** Reachability probe: safe config + Ollama answers /api/tags AND the configured model is actually pulled. */
export async function laptopAiStatus(cfg: LaptopAiConfig): Promise<{ configured: boolean; available: boolean; model?: string; reason?: string }> {
  const v = validateLaptopAiConfig(cfg);
  if (!v.ok) return { configured: v.reason === 'misconfigured', available: false, reason: v.reason };
  const budget = admitStatus();
  if (!budget.ok) return { configured: true, available: false, reason: 'busy' };
  try {
    const r = await fetchTextWithTimeout(`${v.base}/api/tags`, { headers: headers(cfg.token!) }, Math.min(cfg.timeoutMs, 5000));
    if (r.status === 401 || r.status === 403) return { configured: true, available: false, reason: 'gateway_auth_refused' };
    if (r.status !== 200) return { configured: true, available: false, reason: `laptop_http_${r.status}` };
    let tags: any;
    try { tags = JSON.parse(r.body); } catch { return { configured: true, available: false, reason: 'bad_output' }; }
    const models: string[] = Array.isArray(tags?.models) ? tags.models.map((m: any) => String(m?.name ?? '')) : [];
    if (!models.some((n) => n === cfg.model || n === `${cfg.model}:latest`)) {
      return { configured: true, available: false, reason: 'model_missing', model: cfg.model };
    }
    return { configured: true, available: true, model: cfg.model };
  } catch (e: any) {
    return { configured: true, available: false, reason: e instanceof LaptopAiError ? e.reason : 'laptop_unreachable' };
  } finally {
    budget.done();
  }
}


/**
 * In-process budgets (per backend instance; Render runs one). Not a security boundary -
 * a restart resets them - but they stop a single user or a burst from queueing unbounded
 * laptop inference. 5 checks per user per 10 minutes; at most 2 upstream calls in flight.
 */
const perUser = new Map<string, number[]>();
let inFlight = 0;
const USER_WINDOW_MS = 10 * 60 * 1000;
const USER_MAX = 5;
const INFLIGHT_MAX = 2;

function prunePerUser(now: number): void {
  if (perUser.size <= 1000) return;
  for (const [k, arr] of perUser) {
    const live = arr.filter((t) => now - t < USER_WINDOW_MS);
    if (live.length === 0) perUser.delete(k); else perUser.set(k, live);
  }
}

export function admitReportCheck(userId: string): { ok: true; done: () => void } | { ok: false; reason: 'rate_limited' | 'busy' } {
  const now = Date.now();
  prunePerUser(now);
  const arr = (perUser.get(userId) ?? []).filter((t) => now - t < USER_WINDOW_MS);
  if (arr.length >= USER_MAX) { perUser.set(userId, arr); return { ok: false, reason: 'rate_limited' }; }
  if (inFlight >= INFLIGHT_MAX) return { ok: false, reason: 'busy' };
  arr.push(now);
  perUser.set(userId, arr);
  inFlight += 1;
  let closed = false;
  return { ok: true, done: () => { if (!closed) { closed = true; inFlight -= 1; } } };
}

/** Status probes share the same global in-flight budget (no per-user tally): a burst of
 *  status checks cannot fan out unbounded /api/tags calls to the laptop either. */
export function admitStatus(): { ok: true; done: () => void } | { ok: false; reason: 'busy' } {
  if (inFlight >= INFLIGHT_MAX) return { ok: false, reason: 'busy' };
  inFlight += 1;
  let closed = false;
  return { ok: true, done: () => { if (!closed) { closed = true; inFlight -= 1; } } };
}

const SYSTEM = `You are the NagarTrace report assistant. A citizen is DRAFTING a civic road-hazard report and has not submitted it yet. You advise the drafter only - you do not address authorities and nothing you say is sent anywhere else. Reply with ONLY a JSON object, no prose, exactly this shape:
{"summary": string, "severity_hint": "low"|"medium"|"high"|null, "suggested_hazard": string|null, "missing_details": string[]}
Rules: never claim the report is verified. Never invent facts not in the input. If the note is too thin to judge, say so in missing_details. Keep summary under 40 words.`;

const HAZARD_KEYS = ['pothole', 'crack', 'waterlogging', 'broken_edge', 'missing_cover', 'other'];

/** Strict shape check on model output; anything odd is bad_output, never a partial pass. */
export function parseAdvisory(raw: string, model: string): Advisory {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new LaptopAiError('bad_output', 'model reply was not JSON'); }
  if (typeof parsed?.summary !== 'string' || parsed.summary.trim().length === 0 || parsed.summary.length > 500) {
    throw new LaptopAiError('bad_output', 'model reply missing/bad summary');
  }
  const sev = parsed.severity_hint;
  if (sev !== undefined && sev !== null && sev !== 'low' && sev !== 'medium' && sev !== 'high') {
    throw new LaptopAiError('bad_output', 'severity_hint outside the allowed enum');
  }
  // suggested_hazard passes through ONLY as a known hazard key; invented labels are dropped.
  let hazard: string | null = null;
  if (typeof parsed.suggested_hazard === 'string') {
    const h = parsed.suggested_hazard.trim().toLowerCase();
    if (HAZARD_KEYS.includes(h)) hazard = h;
  }
  if (parsed.missing_details !== undefined && !Array.isArray(parsed.missing_details)) {
    throw new LaptopAiError('bad_output', 'missing_details was not an array');
  }
  const rawMissing: any[] = parsed.missing_details ?? [];
  if (rawMissing.some((x) => typeof x !== 'string' || x.length === 0 || x.length > 120)) {
    throw new LaptopAiError('bad_output', 'missing_details item outside bounds');
  }
  const missing = rawMissing.slice(0, 5);
  return {
    summary: parsed.summary.trim(),
    severity_hint: sev ?? null,
    suggested_hazard: hazard,
    missing_details: missing,
    model,
    advisory: true,
  };
}

export async function reportCheck(cfg: LaptopAiConfig, input: { hazard: string; note?: string; lat: number; lon: number; ward?: string }): Promise<Advisory> {
  const v = validateLaptopAiConfig(cfg);
  if (!v.ok) throw new LaptopAiError(v.reason, v.reason === 'not_configured' ? 'laptop AI endpoint is not configured' : 'laptop AI endpoint config is not safe (https URL + gateway token required)');
  const body = {
    model: cfg.model,
    stream: false,
    format: 'json',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ hazard: input.hazard, note: input.note ?? '', lat: input.lat, lon: input.lon, ward: input.ward ?? null }) },
    ],
  };
  const r = await fetchTextWithTimeout(`${v.base}/api/chat`, { method: 'POST', headers: headers(cfg.token!), body: JSON.stringify(body) }, cfg.timeoutMs);
  if (r.status === 401 || r.status === 403) throw new LaptopAiError('misconfigured', 'gateway refused the configured token');
  if (r.status !== 200) throw new LaptopAiError('laptop_unreachable', `laptop returned HTTP ${r.status}`);
  let data: any;
  try { data = JSON.parse(r.body); } catch { throw new LaptopAiError('bad_output', 'ollama envelope was not JSON'); }
  const content = data?.message?.content;
  if (typeof content !== 'string') throw new LaptopAiError('bad_output', 'no message content from model');
  return parseAdvisory(content, cfg.model);
}
