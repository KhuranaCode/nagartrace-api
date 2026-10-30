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
 *  - On this path the server record is the ONLY truth: an unverified JWT email claim neither
 *    helps nor blocks it. (A top-level issuer-VERIFIED claim is a separate trusted path, auth.ts.)
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
  // configured issuer origin over HTTPS. A plain-HTTP (or unparseable) issuer is a config
  // error - the binding is unavailable, never "best effort". (Local test issuers are exempt:
  // they are loopback-only and no real key is configured there.)
  let issuer: URL;
  try { issuer = new URL(cfg.authIssuer); } catch { return noAuthUserLookup; }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(issuer.hostname);
  if (issuer.protocol !== 'https:' && !loopback) return noAuthUserLookup;
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
    if (!u?.email_confirmed_at) return { status: 'unavailable', reason: 'unconfirmed' };
    return { status: 'verified', email: String(u.email) };
  };
}
