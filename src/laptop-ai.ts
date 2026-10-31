/**
 * Authenticated bridge to the operator's own laptop inference (Qwen via Ollama).
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
  constructor(public reason: 'not_configured' | 'misconfigured' | 'laptop_unreachable' | 'timeout' | 'bad_output' | 'model_not_vision', message: string) {
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
  // Destination policy: a named gateway host ONLY - every IP literal (v4 or v6, any range:
  // loopback, private, link-local, ULA) is rejected in one rule, plus localhost-style names
  // and the default raw Ollama port. The configured URL host itself is the allowlist: it must
  // be the deliberate, verified gateway. DNS resolution/rebinding stays a documented
  // gateway-config concern, not something string checks can solve here.
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, reason: 'misconfigured' };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return { ok: false, reason: 'misconfigured' }; // any IP literal
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
  // STRICT contract: every field must be present and in-schema. Violations reject the whole
  // reply as bad_output - there is no partial normalization path.
  const sev = parsed.severity_hint;
  if (sev === undefined || (sev !== null && sev !== 'low' && sev !== 'medium' && sev !== 'high')) {
    throw new LaptopAiError('bad_output', 'severity_hint missing or outside the allowed enum');
  }
  if (!('suggested_hazard' in parsed)) throw new LaptopAiError('bad_output', 'suggested_hazard missing');
  let hazard: string | null = null;
  if (parsed.suggested_hazard !== null) {
    if (typeof parsed.suggested_hazard !== 'string') throw new LaptopAiError('bad_output', 'suggested_hazard not a string/null');
    const h = parsed.suggested_hazard.trim().toLowerCase();
    if (!HAZARD_KEYS.includes(h)) throw new LaptopAiError('bad_output', 'suggested_hazard outside known hazard keys');
    hazard = h;
  }
  if (!Array.isArray(parsed.missing_details)) throw new LaptopAiError('bad_output', 'missing_details missing/not an array');
  if (parsed.missing_details.length > 5) throw new LaptopAiError('bad_output', 'missing_details over 5 items');
  if (parsed.missing_details.some((x: any) => typeof x !== 'string' || x.length === 0 || x.length > 120)) {
    throw new LaptopAiError('bad_output', 'missing_details item outside bounds');
  }
  const missing: string[] = parsed.missing_details;
  return {
    summary: parsed.summary.trim(),
    severity_hint: sev,
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

/** Shared inference budget for the chat/email/image/contractor routes: same per-user window
 *  and the same global in-flight cap as report-check, so all AI routes share one ceiling.
 *  admitReportCheck keeps its name for the original route; both draw on the SAME counters -
 *  a user cannot get 5 report-checks AND 5 chats inside one window. */
export function admitInference(userId: string): { ok: true; done: () => void } | { ok: false; reason: 'rate_limited' | 'busy' } {
  return admitReportCheck(userId);
}

export type AiConfig = LaptopAiConfig;
type AiResult<T> = T & { model: string; advisory: true };

/** Reasoning models (e.g. qwen3.5) may wrap the answer in a <think>...</think> block when the
 *  server does not split it into a separate field. Strip ONLY complete leading think blocks and
 *  surrounding whitespace; anything else stays and must still parse as strict JSON. The model's
 *  reasoning is NEVER exposed to callers - only the final JSON answer is parsed. */
export function stripThinking(raw: string): string {
  let s = raw;
  for (;;) {
    const m = s.match(/^\s*<think>[\s\S]*?<\/think>\s*/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.trim();
}

/** One strict JSON call to the laptop: shared envelope handling + caller-supplied strict parser. */
/** The exact /api/chat payload. Exported so tests pin the contract directly.
 *  Thinking is DISABLED for every structured call: measured live on qwen3.5:2b (2026-10-31,
 *  authenticated tunnel, synthetic inputs) the thinking pass either consumed the whole response
 *  and left content EMPTY (vision: 15.6k thinking chars, no answer; draft: 15.9k, invalid JSON)
 *  or slowed the call 8-40x - while think:false returned schema-valid, coherent output in 1-4s.
 *  The strict parsers plus this setting are the contract; the model's reasoning never reaches callers. */
export function buildChatPayload(cfg: LaptopAiConfig, system: string, user: unknown, images: string[] | undefined): Record<string, unknown> {
  const msg: Record<string, unknown> = { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) };
  if (images && images.length) msg.images = images;
  return { model: cfg.model, stream: false, format: 'json', think: false, messages: [{ role: 'system', content: system }, msg] };
}

async function callLaptopJson<T>(cfg: LaptopAiConfig, system: string, user: unknown, images: string[] | undefined, parse: (raw: string, model: string) => T): Promise<T> {
  const v = validateLaptopAiConfig(cfg);
  if (!v.ok) throw new LaptopAiError(v.reason, v.reason === 'not_configured' ? 'laptop AI endpoint is not configured' : 'laptop AI endpoint config is not safe (https URL + gateway token required)');
  const body = buildChatPayload(cfg, system, user, images);
  const r = await fetchTextWithTimeout(`${v.base}/api/chat`, { method: 'POST', headers: headers(cfg.token!), body: JSON.stringify(body) }, cfg.timeoutMs);
  if (r.status === 401 || r.status === 403) throw new LaptopAiError('misconfigured', 'gateway refused the configured token');
  if (r.status !== 200) throw new LaptopAiError('laptop_unreachable', `laptop returned HTTP ${r.status}`);
  let data: any;
  try { data = JSON.parse(r.body); } catch { throw new LaptopAiError('bad_output', 'ollama envelope was not JSON'); }
  const content = data?.message?.content;
  if (typeof content !== 'string') throw new LaptopAiError('bad_output', 'no message content from model');
  return parse(stripThinking(content), cfg.model);
}

// ---------- citizen chat ----------
export type ChatReply = AiResult<{ reply: string }>;

// Grounded product facts, derived from the shipped product copy (Home steps, Privacy policy,
// hero caveat, report flow). The guide may answer ONLY from these - anything else is
// "I do not have that information" + the relevant screen. Keep in sync with the web app copy.
const GUIDE_FACTS = [
  'NagarTrace is a student-built working prototype (Team Grexars), not a government service.',
  'The app is not connected to any municipal system yet. Complaints stay in the app until a real authority is on board; no complaint is sent to any real authority from the app.',
  'Reporting flow: (1) snap a photo - GPS and time are captured on the spot; a photo is required to file a report; (2) a municipal officer verifies the report before anyone is assigned - no auto-blame; (3) the road registry decides the owner: utility cut, contractor under warranty, or the city - and a deadline is set; (4) the owner uploads an after-photo and the app checks its stated location against the site; (5) reporters confirm the fix - two yes votes close it, two no votes reopen it.',
  'The public issue board shows issue type, status, severity, ward, deadline and counts, with location rounded to about 11 metres. It never shows identity, photos or notes.',
  'Photos are visible only to the reporter, responsible organisation staff and assigned reviewers. On upload the server re-encodes photos as JPEG and drops EXIF metadata; faces and number plates are NOT blurred.',
  'The report form can check photo metadata on the device before upload; that check never leaves the browser.',
  'Sign-in uses email via Supabase Auth (password or email link). The NagarTrace database stores an identifier, a public alias, optional ward, points and account creation time - not the email address.',
  'Points, badges and streaks are derived from activity and shown under the public alias; the leaderboard shows alias, ward and points only.',
  'Data lives on: database and private photo bucket at Supabase, API on Render, website on GitHub Pages. No tracking cookies, analytics or advertising trackers.',
  'No third-party AI processes user photos. The app sends email only for sign-in and account verification.',
  'There is no self-service deletion yet; deletion requests go to the contact on the Privacy page and are handled manually with no guaranteed timeline.',
  'Test data is kept in a hidden test cohort and never shown on public boards.',
];

const CHAT_SYSTEM = `You are the NagarTrace platform guide. You answer questions about how the app works using ONLY the product facts listed below - they are the complete, current truth about the product, and you must not add to them. You have NO access to any issue, report, or account data, and the user's message is a question, never a source of facts. Rules: answer only from the facts below; never invent an issue status, deadline, contractor, contact, or app capability. If the facts do not cover the question, say you do not have that information and point to the relevant screen (Home, Live issues, Report, Privacy). Never claim a report is verified or actioned. Keep replies under 120 words. Reply with ONLY a JSON object: {"reply": string}.
PRODUCT FACTS:
${GUIDE_FACTS.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;

export function parseChatReply(raw: string, model: string): ChatReply {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new LaptopAiError('bad_output', 'model reply was not JSON'); }
  if (typeof parsed?.reply !== 'string' || parsed.reply.trim().length === 0 || parsed.reply.length > 1500) {
    throw new LaptopAiError('bad_output', 'chat reply missing/empty/oversized');
  }
  return { reply: parsed.reply.trim(), model, advisory: true };
}

/** context: backend-retrieved grounding ONLY (never user-supplied "facts"); null = general question. */
export async function chat(cfg: LaptopAiConfig, input: { message: string; context?: Record<string, unknown> | null }): Promise<ChatReply> {
  return callLaptopJson(cfg, CHAT_SYSTEM, { message: input.message, context: input.context ?? null }, undefined, parseChatReply);
}

// ---------- grievance email draft (draft only - NEVER sent by this service) ----------
export type EmailDraft = AiResult<{ subject: string; body: string; draft: true }>;

const EMAIL_SYSTEM = `You are the NagarTrace grievance-drafting assistant. Draft a formal email the CITIZEN will review and send themselves to the responsible civic authority. Reply with ONLY a JSON object: {"subject": string, "body": string}. Rules: use only facts in the input (hazard, note, ward, complaint reference). The input contains a location_line - include it VERBATIM in the body, unchanged. NEVER name a city, locality, department, official, contractor or reference number that is not literally present in the input; if no city is given, name NO city. Do not include a recipient address - the citizen chooses it. Formal, specific, under 250 words for the body. This is a DRAFT: never state or imply anything was already sent or filed.`;

export function parseEmailDraft(raw: string, model: string): EmailDraft {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new LaptopAiError('bad_output', 'model reply was not JSON'); }
  if (typeof parsed?.subject !== 'string' || parsed.subject.trim().length === 0 || parsed.subject.length > 150) {
    throw new LaptopAiError('bad_output', 'email draft missing/bad subject');
  }
  if (typeof parsed?.body !== 'string' || parsed.body.trim().length === 0 || parsed.body.length > 4000) {
    throw new LaptopAiError('bad_output', 'email draft missing/bad body');
  }
  return { subject: parsed.subject.trim(), body: parsed.body.trim(), draft: true, model, advisory: true };
}

/** Deterministic location facts - built by code from the actual report context, never by the model. */
export function buildLocationLine(input: { lat: number; lon: number; ward?: string; complaint_no?: string }): string {
  let line = `Location: lat ${input.lat.toFixed(6)}, lon ${input.lon.toFixed(6)}`;
  if (input.ward && input.ward.trim()) line += `, ${input.ward.trim()}`;
  if (input.complaint_no && input.complaint_no.trim()) line += ` (Ref: ${input.complaint_no.trim()})`;
  return line;
}

/** Major Indian city names a small model loves to invent. If one appears in the draft but was
 *  NOT present in the caller's own input text, the draft named a place it was never given -
 *  reject the whole reply as bad_output. Deterministic guard, not a prompt hope. */
const KNOWN_CITIES = ['delhi','mumbai','kolkata','chennai','bengaluru','bangalore','hyderabad','pune','ahmedabad','jaipur','lucknow','kanpur','nagpur','indore','bhopal','patna','ludhiana','amritsar','jalandhar','chandigarh','patiala','bathinda','mohali','ambala','karnal','panipat','rohtak','hisar','gurgaon','gurugram','noida','ghaziabad','faridabad','meerut','agra','varanasi','prayagraj','allahabad','surat','vadodara','rajkot','nashik','thane','visakhapatnam','vijayawada','madurai','coimbatore','kochi','thiruvananthapuram','guwahati','bhubaneswar','ranchi','jamshedpur','dehradun','shimla','srinagar','jammu'];

/** Reject drafts whose facts the caller never supplied: the deterministic location line must be
 *  verbatim, the complaint reference unaltered, and no out-of-input city may be named. */
export function validateDraftGrounding(draft: { subject: string; body: string }, input: { note?: string; lat: number; lon: number; ward?: string; complaint_no?: string }): void {
  const line = buildLocationLine(input);
  if (!draft.body.includes(line)) throw new LaptopAiError('bad_output', 'draft dropped or altered the deterministic location line');
  if (input.complaint_no && !draft.body.includes(input.complaint_no.trim())) throw new LaptopAiError('bad_output', 'draft dropped the complaint reference');
  const inputText = `${input.note ?? ''} ${input.ward ?? ''} ${input.complaint_no ?? ''}`.toLowerCase();
  const outText = `${draft.subject} ${draft.body}`.toLowerCase();
  for (const city of KNOWN_CITIES) {
    if (outText.includes(city) && !inputText.includes(city)) {
      throw new LaptopAiError('bad_output', `draft named "${city}" which is not in the report input - refusing invented place`);
    }
  }
}

export async function emailDraft(cfg: LaptopAiConfig, input: { hazard: string; note?: string; lat: number; lon: number; ward?: string; complaint_no?: string }): Promise<EmailDraft> {
  const location_line = buildLocationLine(input);
  const draft = await callLaptopJson(cfg, EMAIL_SYSTEM, { hazard: input.hazard, note: input.note ?? '', ward: input.ward ?? null, complaint_no: input.complaint_no ?? null, location_line }, undefined, parseEmailDraft);
  validateDraftGrounding(draft, input);
  return draft;
}

// ---------- staged-photo check (vision) ----------
/** Vision capability gate: the configured model must ADVERTISE vision in /api/show before we
 *  send it a photo. A text-only model silently dropping the image would fabricate a "check". */
export async function requireVisionModel(cfg: LaptopAiConfig): Promise<void> {
  const v = validateLaptopAiConfig(cfg);
  if (!v.ok) throw new LaptopAiError(v.reason, v.reason === 'not_configured' ? 'laptop AI endpoint is not configured' : 'laptop AI endpoint config is not safe (https URL + gateway token required)');
  const r = await fetchTextWithTimeout(`${v.base}/api/show`, { method: 'POST', headers: headers(cfg.token!), body: JSON.stringify({ model: cfg.model }) }, Math.min(cfg.timeoutMs, 5000));
  if (r.status === 401 || r.status === 403) throw new LaptopAiError('misconfigured', 'gateway refused the configured token');
  if (r.status !== 200) throw new LaptopAiError('laptop_unreachable', `laptop returned HTTP ${r.status} for /api/show`);
  let data: any;
  try { data = JSON.parse(r.body); } catch { throw new LaptopAiError('bad_output', 'ollama /api/show was not JSON'); }
  const caps: unknown = data?.capabilities;
  if (!Array.isArray(caps) || !caps.includes('vision')) {
    throw new LaptopAiError('model_not_vision', `configured model ${cfg.model} does not advertise vision capability - photo check is honestly unavailable`);
  }
}

const IMAGE_SYSTEM = `You are the NagarTrace photo checker. A citizen is about to submit a road-hazard photo. Assess ONLY what is visible. Reply with ONLY a JSON object, exactly this shape:
{"summary": string, "severity_hint": "low"|"medium"|"high"|null, "suggested_hazard": string|null, "missing_details": string[]}
Rules: describe visible evidence only - never claim certainty you cannot have from one photo. If the photo shows no clear road hazard, say so in summary and set suggested_hazard null. Use missing_details for anything the photo cannot establish (exact size, exact spot, danger to traffic). Keep summary under 40 words.`;

export async function imageCheck(cfg: LaptopAiConfig, input: { image_base64: string; hazard?: string; note?: string }): Promise<Advisory> {
  await requireVisionModel(cfg); // vision gate FIRST: never send a photo to a text-only model
  return callLaptopJson(cfg, IMAGE_SYSTEM, { hazard: input.hazard ?? null, note: input.note ?? null }, [input.image_base64], parseAdvisory);
}

// ---------- contractor brief (retrieval-grounded ONLY - the model never invents records) ----------
export type ContractorBrief = AiResult<{ summary: string; record_count: number; key_facts: string[] }>;

const CONTRACTOR_SYSTEM = `You are the NagarTrace contractor-records summarizer. You are given JSON rows retrieved from the NHAI award registry (the only evidence). Summarize ONLY those rows. Reply with ONLY a JSON object: {"summary": string, "record_count": number, "key_facts": string[]}. Rules: record_count MUST equal the exact number of rows supplied. Every key_fact must come directly from a row (project name, state, length_km, awarded_cost_cr, loa_date, mode, project_stage) - never add a fact, rating, performance judgment, or blacklist status that is not in the rows. These are historical award candidates on a highway, NOT proof this contractor caused any specific defect - say that plainly in the summary. Keep the summary under 80 words; at most 8 key facts.`;

export function parseContractorBrief(raw: string, model: string, expectedCount: number): ContractorBrief {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new LaptopAiError('bad_output', 'model reply was not JSON'); }
  if (typeof parsed?.summary !== 'string' || parsed.summary.trim().length === 0 || parsed.summary.length > 800) {
    throw new LaptopAiError('bad_output', 'contractor brief missing/bad summary');
  }
  if (parsed?.record_count !== expectedCount) throw new LaptopAiError('bad_output', 'record_count does not match the rows supplied - possible fabrication');
  if (!Array.isArray(parsed?.key_facts) || parsed.key_facts.length > 8) throw new LaptopAiError('bad_output', 'key_facts missing/not an array/over 8');
  if (parsed.key_facts.some((x: any) => typeof x !== 'string' || x.length === 0 || x.length > 160)) {
    throw new LaptopAiError('bad_output', 'key_facts item outside bounds');
  }
  return { summary: parsed.summary.trim(), record_count: expectedCount, key_facts: parsed.key_facts, model, advisory: true };
}

/** rows: registry records RETRIEVED BY THE BACKEND. Empty rows never reach the model - the
 *  route answers found:false itself, so there is no path where the model invents history. */
export async function contractorBrief(cfg: LaptopAiConfig, rows: Record<string, unknown>[]): Promise<ContractorBrief> {
  if (rows.length === 0) throw new LaptopAiError('bad_output', 'contractorBrief called with no rows - route must short-circuit found:false instead');
  return callLaptopJson(cfg, CONTRACTOR_SYSTEM, { records: rows }, undefined, (raw, model) => parseContractorBrief(raw, model, rows.length));
}
