// AI is ADVISORY ONLY. Nothing here verifies a report, assigns an authority, or sends anything.
// Default provider is disabled: no model is chosen, no image leaves the server.
export interface VisionSuggestion { damage_likely: boolean; confidence: number; severity_hint: 'low' | 'medium' | 'high' | null; model: string; advisory: true }
export interface VisionProvider { name: string; analyze(image: Uint8Array): Promise<unknown> }

export const disabledVision: VisionProvider = { name: 'disabled', analyze: async () => { throw new Error('vision_disabled'); } };

// Validate untrusted model output. Anything malformed becomes null (no suggestion).
export function parseVision(raw: unknown, model: string): VisionSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const c = r.confidence;
  if (typeof r.damage_likely !== 'boolean' || typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) return null;
  const s = r.severity_hint;
  const sev = s === 'low' || s === 'medium' || s === 'high' ? s : null;
  return { damage_likely: r.damage_likely, confidence: c, severity_hint: sev, model, advisory: true };
}

export async function suggestFromImage(p: VisionProvider, img: Uint8Array): Promise<VisionSuggestion | null> {
  try { return parseVision(await p.analyze(img), p.name); } catch { return null; }
}

export interface DraftInput { issueId: string; hazard: string; lat: number; lng: number; reportedAt: string; note?: string; road?: string;
  recipient: { org_name: string; contact_verified: boolean } | null }
// Deterministic template. No LLM picks the recipient: it must come from a verified registry record.
export function draftComplaint(i: DraftInput): { text: string; recipient_org: string | null; sendable: false; blockers: string[] } {
  const blockers = ['sending_not_implemented'];
  if (!i.recipient) blockers.push('no_recipient_in_registry');
  else if (!i.recipient.contact_verified) blockers.push('recipient_contact_not_verified');
  const text = `Report ${i.issueId}: ${i.hazard} at ${i.lat.toFixed(5)}, ${i.lng.toFixed(5)}${i.road ? ` (${i.road})` : ''}, reported ${i.reportedAt}.${i.note ? ` Citizen note: ${i.note}` : ''} Status: unverified citizen report.`;
  return { text, recipient_org: i.recipient?.org_name ?? null, sendable: false, blockers };
}

// Fail-closed guard for any EXTERNAL provider. No provider is wired; this only defines the rules.
// Calls are refused unless the operator opted in for synthetic/non-personal images, and a local
// daily cap (set BELOW the provider's free quota) is not exhausted. Any provider error or 429 => no suggestion.
export function guardExternal(p: VisionProvider, o: { allowSyntheticOnly: boolean; dailyCap: number; now?: () => number }): VisionProvider {
  let day = ''; let n = 0;
  return { name: p.name, analyze: async (img) => {
    if (!o.allowSyntheticOnly) throw new Error('external_ai_not_enabled');
    const d = new Date((o.now ?? Date.now)()).toISOString().slice(0, 10);
    if (d !== day) { day = d; n = 0; }
    if (n >= o.dailyCap) throw new Error('free_quota_guard_reached');
    n++;
    return p.analyze(img);
  } };
}
