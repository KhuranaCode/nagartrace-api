import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type pg from 'pg';
import type { Config } from './config.ts';

export type Principal = { userId: string; issuer: string; subject: string; suspended: boolean; ageHours: number; /** Sign-in email claim from the verified token, when the issuer includes one (Supabase does). Used ONLY to bind self-addressed mail; never trusted from a request body. */ email?: string };
export type KeyResolver = JWTVerifyGetKey | CryptoKey | Uint8Array;

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error') { super(message); }
}

/** Verifies the bearer token (issuer, audience, expiry, signature) and binds identity to (iss, sub). Roles are never read from the token. */
export async function authenticate(header: string | undefined, cfg: Config, keys: KeyResolver, db: pg.Pool): Promise<Principal> {
  if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'Missing bearer token', 'unauthenticated');
  const token = header.slice(7).trim();
  let sub: string, iss: string, email: string | undefined;
  try {
    const { payload } = await jwtVerify(token, keys as JWTVerifyGetKey, {
      issuer: cfg.authIssuer, audience: cfg.authAudience, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iss', 'aud'],
    });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new Error('bad sub');
    sub = payload.sub; iss = String(payload.iss);
    // Bind ONLY an issuer-verified address: a signed email claim alone is not proof the address
    // is confirmed, and user_metadata is USER-EDITABLE in Supabase - never a verification source.
    // Only a top-level email_verified===true (a claim the issuer owns, not the user) qualifies.
    // Stock Supabase access tokens carry no such claim (supabase.com/docs/guides/auth/jwt-fields),
    // so the address is honestly UNAVAILABLE until a server-confirmed binding (owner surface).
    if (typeof payload.email === 'string' && payload.email.length <= 320
        && payload.email_verified === true) email = payload.email;
  } catch {
    throw new HttpError(401, 'Invalid token', 'unauthenticated');
  }
  const alias = 'user-' + Math.random().toString(36).slice(2, 8);
  await db.query(`INSERT INTO users (issuer, subject, alias) VALUES ($1,$2,$3) ON CONFLICT (issuer, subject) DO NOTHING`, [iss, sub, alias]);
  const r = await db.query(`SELECT id, suspended, EXTRACT(EPOCH FROM (now() - created_at))/3600 AS age_h FROM users WHERE issuer=$1 AND subject=$2`, [iss, sub]);
  const u = r.rows[0];
  if (u.suspended) throw new HttpError(403, 'Account suspended', 'suspended');
  return { userId: u.id, issuer: iss, subject: sub, suspended: false, ageHours: Number(u.age_h), email };
}

export type Membership = { org_id: string; role: 'admin' | 'officer' | 'contractor' | 'utility'; kind: string; synthetic: boolean };

export async function memberships(db: pg.Pool | pg.PoolClient, userId: string): Promise<Membership[]> {
  const r = await db.query(`SELECT m.org_id, m.role, o.kind, o.is_synthetic AS synthetic FROM memberships m JOIN orgs o ON o.id=m.org_id WHERE m.user_id=$1 AND m.revoked_at IS NULL`, [userId]);
  return r.rows;
}
