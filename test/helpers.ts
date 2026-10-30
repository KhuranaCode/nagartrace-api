import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import sharp from 'sharp';
import { buildApp } from '../src/app.ts';
import { defaults, type Config } from '../src/config.ts';
import { migrate } from '../src/migrate.ts';
import { localStore } from '../src/storage.ts';

export const OWNER = process.env.TEST_OWNER_URL ?? 'postgresql://sandbox@127.0.0.1:55432/postgres';
export const ISSUER = 'https://issuer.test/';
export const AUDIENCE = 'nagartrace-api';
const kp = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');

export async function sign(sub: string, o: { iss?: string; aud?: string; exp?: string; key?: CryptoKey; extra?: Record<string, unknown> } = {}) {
  return new SignJWT({ ...(o.extra ?? {}) }).setProtectedHeader({ alg: 'RS256' }).setSubject(sub).setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? AUDIENCE).setIssuedAt().setExpirationTime(o.exp ?? '10m').sign(o.key ?? kp.privateKey);
}
export const wrongKeyToken = (sub: string) => sign(sub, { key: other.privateKey });

export async function newWorld(over: Partial<Config> = {}, clock?: { t: number }) {
  const name = 'nt_' + crypto.randomBytes(5).toString('hex');
  const owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query(`CREATE DATABASE ${name}`); await owner.end();
  const base = OWNER.replace(/\/[^/]+$/, '/' + name);
  await migrate(base);
  const runtime = new pg.Pool({ connectionString: base.replace('sandbox@', 'nagartrace_runtime@'), max: 20 });
  const adminDb = new pg.Pool({ connectionString: base, max: 2 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntblob-'));
  const cfg: Config = { ...defaults(), authIssuer: ISSUER, authAudience: AUDIENCE, databaseUrl: base, storageDir: dir, confirmMinAccountAgeHours: 0, rateLimitMax: 100000, verificationMode: 'auto_checks', ...over };
  const app = await buildApp({ cfg, db: runtime, keys: kp.publicKey, store: localStore(dir), now: clock ? () => new Date(clock.t) : undefined });
  return {
    app, runtime, adminDb, cfg,
    async close() { await app.close(); await runtime.end(); await adminDb.end(); const o = new pg.Client({ connectionString: OWNER }); await o.connect(); await o.query(`DROP DATABASE ${name} WITH (FORCE)`); await o.end(); },
  };
}
export type World = Awaited<ReturnType<typeof newWorld>>;

export function client(w: World, token: string) {
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await w.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers }, payload: body as any });
    let json: any = null; try { json = r.json(); } catch { /* binary */ }
    return { status: r.statusCode, json, raw: r.rawPayload, headers: r.headers };
  };
  return { get: (u: string) => call('GET', u), post: (u: string, b?: unknown, h?: Record<string, string>) => call('POST', u, b ?? {}, h), patch: (u: string, b: unknown) => call('PATCH', u, b), upload: (u: string, img: Buffer, type = 'image/jpeg') => call('POST', u, img, { 'content-type': type }) };
}
export async function userToken(sub: string) { return sign(sub); }
export async function jpeg(withExif = false) {
  let s = sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 90, g: 90, b: 90 } } });
  if (withExif) s = s.withExif({ IFD0: { Copyright: 'SECRET-TEST-TAG' } });
  return s.jpeg().toBuffer();
}

/** Roads (lon,lat). Mohali-area synthetic coordinates. */
export const R_WARRANTY = { code: 'R-WARR', name: 'Synthetic Road A', ward: 'W1', coordinates: [[76.7000, 30.7000], [76.7100, 30.7000]] };
export const R_UTILITY = { code: 'R-UTIL', name: 'Synthetic Road B', ward: 'W1', coordinates: [[76.7000, 30.7200], [76.7100, 30.7200]] };
export const R_EXPIRED = { code: 'R-EXP', name: 'Synthetic Road C', ward: 'W2', coordinates: [[76.7000, 30.7400], [76.7100, 30.7400]] };
export const P_WARRANTY = { lat: 30.7000, lon: 76.7050 };
export const P_UTILITY = { lat: 30.7200, lon: 76.7050 };
export const P_EXPIRED = { lat: 30.7400, lon: 76.7050 };
export const P_NOROAD = { lat: 30.8000, lon: 76.8000 };

export function reportBody(p: { lat: number; lon: number }, extra: Record<string, unknown> = {}, at = new Date()) {
  return { lat: p.lat, lon: p.lon, hazard: 'pothole', captured_at: at.toISOString(), accuracy_m: 10, ...extra };
}

/** Seeds: one municipality + its admin (owner connection), registry via API. Returns tokens and ids. */
export async function seed(w: World) {
  const muni = (await w.adminDb.query(`INSERT INTO orgs (kind,name) VALUES ('municipality','Test Municipality') RETURNING id`)).rows[0].id;
  const tok = async (s: string) => userToken(s);
  const mk = async (sub: string) => { const t = await tok(sub); const c = client(w, t); const me = (await c.get('/v1/me')).json; return { t, c, id: me.id as string }; };
  const admin = await mk('admin-1');
  await w.adminDb.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'admin')`, [admin.id, muni]);
  const imp = await admin.c.post('/v1/admin/registry/import', {
    municipality_org_id: muni, source_label: 'Synthetic test registry', is_synthetic: false,
    roads: [R_WARRANTY, R_UTILITY, R_EXPIRED],
    contracts: [
      { road_code: 'R-WARR', contractor_name: 'Sharma Infra', completion_date: '2024-01-01', warranty_end: '2099-01-01' },
      { road_code: 'R-UTIL', contractor_name: 'Sharma Infra', completion_date: '2024-01-01', warranty_end: '2099-01-01' },
      { road_code: 'R-EXP', contractor_name: 'Old Roads Ltd', completion_date: '2015-01-01', warranty_end: '2020-01-01' },
    ],
    utility_cuts: [{ road_code: 'R-UTIL', utility_name: 'Test Telecom', cut_date: new Date().toISOString().slice(0, 10) }],
  });
  if (imp.status !== 201) throw new Error('seed import failed ' + JSON.stringify(imp.json));
  const org = async (kind: string, name: string) => (await w.adminDb.query('SELECT id FROM orgs WHERE kind=$1 AND name=$2', [kind, name])).rows[0].id as string;
  const contractorOrg = await org('contractor', 'Sharma Infra');
  const utilityOrg = await org('utility', 'Test Telecom');
  const officer = await mk('officer-1');
  await admin.c.post('/v1/admin/memberships', { user_id: officer.id, org_id: muni, role: 'officer' });
  const contractor = await mk('contractor-1');
  await admin.c.post('/v1/admin/memberships', { user_id: contractor.id, org_id: contractorOrg, role: 'contractor' });
  return { muni, admin, officer, contractor, contractorOrg, utilityOrg, mk };
}
