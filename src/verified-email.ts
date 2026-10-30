/**
 * Trusted verified-email binding for self-addressed mail (follow-up reminders).
 *
 * Why: a signed JWT proves WHO the user is; it does NOT prove their address is confirmed.
 * Supabase access tokens carry no verification claim (supabase.com/docs/guides/auth/jwt-fields),
 * and user_metadata is user-editable. The trusted source is the issuer's own server record:
 *   GET {authIssuer}/admin/users/{user_id}  (service-role, server-to-server ONLY)
 * returns the auth user including `email` and `email_confirmed_at`
 * (supabase.com/docs/reference/self-hosting-auth/get-a-user, read 2026-10-30).
 *
 * Binding rules:
 *  - The lookup key is the verified token's subject (auth user id) under the CONFIGURED issuer -
 *    the address is bound to (issuer, subject), never to a request-body field.
 *  - Verified means: user found AND a string email AND non-null email_confirmed_at.
 *  - These are two INDEPENDENT trusted paths, not a comparison: when a top-level issuer-verified
 *    claim exists it is used directly and this lookup is skipped; when it does not (stock
 *    Supabase), this server record is the ONLY proof. An unverified JWT email claim neither
 *    helps nor blocks this path.
 *  - The service-role key is read from the environment, sent only to the configured issuer
 *    origin over HTTPS, and is never logged, never sent to the browser, never stored in the DB.
 *  - Unconfigured or failed lookups yield an honest UNAVAILABLE - callers return a truthful
 *    blocked/400 state instead of falling back to unverified data.
 */
import type { Config } from './config.ts';

export type VerifiedEmail =
  | { status: 'verified'; email: string }
  | { status: 'unavailable'; reason: 'not_configured' | 'not_found' | 'unconfirmed' | 'no_email' | 'lookup_failed' };

export interface AuthUserLookup {
  (authUserId: string): Promise<VerifiedEmail>;
}

/** No lookup configured: every resolution is honestly unavailable. */
export const noAuthUserLookup: AuthUserLookup = async () => ({ status: 'unavailable', reason: 'not_configured' });

export function supabaseAuthUserLookup(cfg: Config): AuthUserLookup {
  const key = cfg.authServiceRoleKey;
  if (!key) return noAuthUserLookup;
  // FAIL CLOSED on the issuer URL: the service-role key must only ever leave for the exact
  // configured issuer origin over HTTPS. A plain-HTTP (even loopback) or unparseable issuer is
  // a config error - the binding is unavailable, never "best effort".
  let issuer: URL;
  try { issuer = new URL(cfg.authIssuer); } catch { return noAuthUserLookup; }
  if (issuer.protocol !== 'https:') return noAuthUserLookup;
  const base = cfg.authIssuer.replace(/\/+$/, ''); // e.g. https://<project>.supabase.co/auth/v1
  return async (authUserId: string): Promise<VerifiedEmail> => {
    let r: Response;
    try {
      // redirect:'error': fetch would otherwise follow a 3xx cross-origin AND FORWARD the
      // apikey/authorization headers - a redirect must never leak the service key.
      r = await fetch(`${base}/admin/users/${encodeURIComponent(authUserId)}`, {
        headers: { apikey: key, authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return { status: 'unavailable', reason: 'lookup_failed' };
    }
    if (r.status === 404) return { status: 'unavailable', reason: 'not_found' };
    if (!r.ok) return { status: 'unavailable', reason: 'lookup_failed' };
    let u: any;
    try { u = await r.json(); } catch { return { status: 'unavailable', reason: 'lookup_failed' }; }
    if (u?.id !== authUserId) return { status: 'unavailable', reason: 'not_found' }; // binding is to the token subject
    if (typeof u?.email !== 'string' || !u.email.length || u.email.length > 320) return { status: 'unavailable', reason: 'no_email' };
    // email_confirmed_at must be an actual timestamp - a truthy non-date (boolean, junk
    // string, future-dated value) is not confirmation evidence.
    const confirmedAt = typeof u?.email_confirmed_at === 'string' ? Date.parse(u.email_confirmed_at) : NaN;
    if (!Number.isFinite(confirmedAt) || confirmedAt > Date.now() + 60_000) return { status: 'unavailable', reason: 'unconfirmed' };
    return { status: 'verified', email: String(u.email) };
  };
}
