import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import crypto from 'node:crypto';
import { newWorld, seed, client, sign, reportBody, OWNER } from './helpers.ts';

test('complaint ids: every new issue gets a unique, monotonic, human-readable NT- id in DTOs', async () => {
  const w = await newWorld();
  try {
    await seed(w);
    const a = client(w, await sign('cid-a'));
    const b = client(w, await sign('cid-b'));
    const r1 = await a.post('/v1/reports', reportBody({ lat: 30.7000, lon: 76.7030 }));
    const r2 = await b.post('/v1/reports', reportBody({ lat: 30.7005, lon: 76.7040 }));
    assert.equal(r1.status, 201); assert.equal(r2.status, 201);
    const i1 = r1.json.issue, i2 = r2.json.issue;
    assert.equal(i1.complaint_id, 'NT-000001');
    assert.equal(i1.complaint_no, 1);
    assert.equal(i2.complaint_id, 'NT-000002');
    assert.ok(i2.complaint_no > i1.complaint_no, 'monotonic in creation order');
    // detail DTO (full) and list DTO both carry it
    const det = await a.get(`/v1/issues/${i1.id}`);
    assert.equal(det.status, 200);
    assert.equal(det.json.complaint_id, 'NT-000001');
    const list = await b.get('/v1/issues');
    const found = list.json.issues.find((x: any) => x.id === i2.id);
    assert.equal(found.complaint_id, 'NT-000002');
    // stable across a status transition (verify -> assigned)
    await w.adminDb.query(`UPDATE issues SET status='assigned', updated_at=now() WHERE id=$1`, [i1.id]);
    const det2 = await a.get(`/v1/issues/${i1.id}`);
    assert.equal(det2.json.complaint_id, 'NT-000001', 'id does not change on update');
    // DB-level: unique + not null enforced
    const dupErr = await w.adminDb.query(`INSERT INTO issues (reporter_id, geom, hazard, hazards, severity, complaint_no)
      SELECT reporter_id, geom, hazard, hazards, severity, 1 FROM issues WHERE id=$1`, [i1.id]).then(() => null).catch((e) => e);
    assert.ok(dupErr && /duplicate key/.test(dupErr.message), 'complaint_no unique at DB level');
  } finally { await w.close(); }
});

test('complaint ids: migration backfills pre-existing issues oldest-first and continues the sequence', async () => {
  const name = 'nt_bf_' + crypto.randomBytes(5).toString('hex');
  const owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query(`CREATE DATABASE ${name}`);
  const base = OWNER.replace(/\/[^/]+$/, '/' + name);
  const db = new pg.Client({ connectionString: base }); await db.connect();
  try {
    const dir = path.resolve(import.meta.dirname, '../db');
    const files = fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();
    const pre = files.filter((f) => f < '012_complaint_ids.sql');
    for (const f of pre) await db.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    // three pre-migration issues created out of order in time
    await db.query(`INSERT INTO users (issuer, subject, alias) VALUES ('https://issuer.test/','bf-1','BF One')`);
    const uid = (await db.query(`SELECT id FROM users WHERE subject='bf-1'`)).rows[0].id;
    const mk = (created: string) => db.query(
      `INSERT INTO issues (reporter_id, geom, hazard, severity, created_at) VALUES ($1, ST_SetSRID(ST_MakePoint(76.7,30.7),4326)::geography, 'pothole', 2, $2)`, [uid, created]);
    await mk('2026-10-01T10:00:00Z'); await mk('2026-09-01T10:00:00Z'); await mk('2026-10-15T10:00:00Z');
    // apply the migration under test
    await db.query(fs.readFileSync(path.join(dir, '012_complaint_ids.sql'), 'utf8'));
    const rows = (await db.query(`SELECT complaint_no, created_at FROM issues ORDER BY complaint_no`)).rows;
    assert.deepEqual(rows.map((r: any) => Number(r.complaint_no)), [1, 2, 3]);
    assert.equal(new Date(rows[0].created_at).toISOString(), '2026-09-01T10:00:00.000Z', 'oldest gets NT-000001');
    assert.equal(new Date(rows[2].created_at).toISOString(), '2026-10-15T10:00:00.000Z');
    // next insert continues from max+1 via the default
    await db.query(`INSERT INTO issues (reporter_id, geom, hazard, severity) VALUES ($1, ST_SetSRID(ST_MakePoint(76.7,30.7),4326)::geography, 'pothole', 2)`, [uid]);
    const next = (await db.query(`SELECT max(complaint_no) m, count(*) n FROM issues`)).rows[0];
    assert.equal(Number(next.m), 4); assert.equal(Number(next.n), 4);
    // column is NOT NULL after migration and runtime role can advance the sequence
    const nn = (await db.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name='issues' AND column_name='complaint_no'`)).rows[0];
    assert.equal(nn.is_nullable, 'NO');
    const priv = (await db.query(`SELECT has_sequence_privilege('nagartrace_runtime','complaint_no_seq','USAGE') AS u`)).rows[0];
    assert.equal(priv.u, true);
    // re-running the migration is a no-op for already-numbered rows (idempotent)
    const before = (await db.query(`SELECT id, complaint_no FROM issues ORDER BY complaint_no`)).rows;
    await db.query(fs.readFileSync(path.join(dir, '012_complaint_ids.sql'), 'utf8'));
    const after = (await db.query(`SELECT id, complaint_no FROM issues ORDER BY complaint_no`)).rows;
    assert.deepEqual(after, before);
  } finally {
    await db.end();
    await owner.query(`DROP DATABASE ${name} WITH (FORCE)`); await owner.end();
  }
});
