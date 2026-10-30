/**
 * Photo-mandatory reports: staged upload -> atomic bind inside the report transaction.
 * Fixture discipline (peer review): EVERY case uses its own fresh citizen account and
 * stages the photo at the exact coordinates its report uses - no shared-user
 * accumulation (daily cap 10, pending-stage cap 5, already_reported 409), no
 * point-km-apart fixtures. Worlds (schema + seed) are shared; identities are not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, client, userToken, jpeg, reportBody, P_NOROAD } from './helpers.ts';

let seq = 0;
const fresh = async (w: any) => client(w, await userToken(`citizen-photo-${++seq}`));
const stageAt = (u: any, p: { lat: number; lon: number }, img: Buffer) => u.upload(`/v1/uploads/stage?lat=${p.lat}&lon=${p.lon}`, img);
/** Stage a photo exactly where the report will be filed. */
const stageFor = async (u: any, p: { lat: number; lon: number }) => {
  const s = await stageAt(u, p, await jpeg());
  assert.equal(s.status, 201, `stage failed: ${JSON.stringify(s.json)}`);
  return s.json.upload_id as string;
};

test('photo-mandatory reports: stage + atomic bind, guards and failure modes', async (t) => {
  const wOn = await newWorld({ photoRequired: true });
  const wOff = await newWorld({ photoRequired: false });
  try {
    for (const w of [wOn, wOff]) await seed(w);

    await t.test('photo_required: report without photo_upload_id is 422 when the flag is on', async () => {
      const u = await fresh(wOn);
      const r = await u.post('/v1/reports', reportBody(P_NOROAD));
      assert.equal(r.status, 422);
      assert.equal(r.json.error, 'photo_required');
    });

    await t.test('compat: same report succeeds when the flag is off (rollout window)', async () => {
      const u = await fresh(wOff);
      const r = await u.post('/v1/reports', reportBody(P_NOROAD));
      assert.equal(r.status, 201);
    });

    await t.test('stage returns a private upload id and the report binds it atomically', async () => {
      const u = await fresh(wOn);
      const spot = { lat: P_NOROAD.lat + 0.01, lon: P_NOROAD.lon };
      const uploadId = await stageFor(u, spot);
      const r = await u.post('/v1/reports', reportBody(spot, { photo_upload_id: uploadId }));
      assert.equal(r.status, 201);
      assert.ok(r.json.photo?.evidence_id);
      const det = await u.get(`/v1/issues/${r.json.issue.id}`);
      assert.equal(det.json.evidence.length, 1);
      assert.equal(det.json.evidence[0].kind, 'report');
      const su = (await wOn.adminDb.query('SELECT consumed_at, issue_id FROM staged_uploads WHERE id=$1', [uploadId])).rows[0];
      assert.ok(su.consumed_at);
      assert.equal(su.issue_id, r.json.issue.id);
      // the stored blob is the re-encoded JPEG (EXIF stripped), served through evidence auth
      const blob = await u.get(`/v1/issues/${r.json.issue.id}/evidence/${r.json.photo.evidence_id}`);
      assert.equal(blob.status, 200);
      assert.equal(blob.headers['content-type'], 'image/jpeg');
    });

    await t.test('cross-user binding is rejected with the same error as an unknown id', async () => {
      const owner = await fresh(wOn);
      const thief = await fresh(wOn);
      const spot = { lat: P_NOROAD.lat + 0.02, lon: P_NOROAD.lon };
      const uploadId = await stageFor(owner, spot);
      const r = await thief.post('/v1/reports', reportBody(spot, { photo_upload_id: uploadId }));
      assert.equal(r.status, 422);
      assert.equal(r.json.error, 'invalid_upload');
      const r2 = await thief.post('/v1/reports', reportBody(spot, { photo_upload_id: crypto.randomUUID() }));
      assert.equal(r2.status, 422);
      assert.equal(r2.json.error, 'invalid_upload');
      assert.equal(r.json.message, r2.json.message); // no existence oracle
      const su = (await wOn.adminDb.query('SELECT consumed_at FROM staged_uploads WHERE id=$1', [uploadId])).rows[0];
      assert.equal(su.consumed_at, null);
    });

    await t.test('a staged upload cannot be consumed twice', async () => {
      const u = await fresh(wOn);
      const spotA = { lat: P_NOROAD.lat + 0.03, lon: P_NOROAD.lon };
      const spotB = { lat: P_NOROAD.lat + 0.031, lon: P_NOROAD.lon };
      const uploadId = await stageFor(u, spotA);
      const r1 = await u.post('/v1/reports', reportBody(spotA, { photo_upload_id: uploadId }));
      assert.equal(r1.status, 201);
      const r2 = await u.post('/v1/reports', reportBody(spotB, { photo_upload_id: uploadId }));
      assert.equal(r2.status, 422);
      assert.equal(r2.json.error, 'invalid_upload');
    });

    await t.test('expired staged upload is rejected', async () => {
      const u = await fresh(wOn);
      const spot = { lat: P_NOROAD.lat + 0.04, lon: P_NOROAD.lon };
      const uploadId = await stageFor(u, spot);
      await wOn.adminDb.query(`UPDATE staged_uploads SET expires_at = now() - interval '1 minute' WHERE id=$1`, [uploadId]);
      const r = await u.post('/v1/reports', reportBody(spot, { photo_upload_id: uploadId }));
      assert.equal(r.status, 422);
      assert.equal(r.json.error, 'invalid_upload');
    });

    await t.test('far photo rolls back the report (no orphan issue) and the upload stays consumable', async () => {
      const u = await fresh(wOn);
      const far = { lat: P_NOROAD.lat + 0.5, lon: P_NOROAD.lon + 0.5 }; // ~78 km away
      const uploadId = await stageFor(u, far);
      const spot = { lat: P_NOROAD.lat + 0.05, lon: P_NOROAD.lon };
      const r = await u.post('/v1/reports', reportBody(spot, { photo_upload_id: uploadId }));
      assert.equal(r.status, 422);
      assert.equal(r.json.error, 'location_mismatch');
      const n = (await wOn.adminDb.query(
        `SELECT count(*)::int AS n FROM issues WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 50)`,
        [spot.lat, spot.lon])).rows[0].n;
      assert.equal(n, 0);
      // retry at the photo's true location succeeds with the same upload
      const r2 = await u.post('/v1/reports', reportBody(far, { photo_upload_id: uploadId }));
      assert.equal(r2.status, 201);
      assert.ok(r2.json.photo?.evidence_id);
    });

    await t.test('two concurrent reports carrying the same upload id: exactly one binds', async () => {
      const a = await fresh(wOn);
      const b = await fresh(wOn);
      const spot = { lat: P_NOROAD.lat + 0.06, lon: P_NOROAD.lon };
      const uploadId = await stageFor(a, spot);
      const [r1, r2] = await Promise.all([
        a.post('/v1/reports', reportBody(spot, { photo_upload_id: uploadId, hazard: 'debris' })),
        b.post('/v1/reports', reportBody(spot, { photo_upload_id: uploadId, hazard: 'debris' })),
      ]);
      const ok = [r1, r2].filter((r) => r.status === 201 || r.status === 200);
      const bad = [r1, r2].filter((r) => r.status === 422);
      assert.equal(ok.length, 1);
      assert.equal(bad.length, 1);
      assert.equal(bad[0].json.error, 'invalid_upload');
      assert.ok(ok[0].json.photo?.evidence_id);
      const n = (await wOn.adminDb.query('SELECT count(*)::int AS n FROM staged_uploads WHERE id=$1 AND consumed_at IS NOT NULL', [uploadId])).rows[0].n;
      assert.equal(n, 1);
      const det = await a.get(`/v1/issues/${ok[0].json.issue.id}`);
      assert.equal(det.json.evidence.length, 1);
    });

    await t.test('two concurrent requests with the same idempotency key: one creates, one replays', async () => {
      const u = await fresh(wOn);
      const spot = { lat: P_NOROAD.lat + 0.07, lon: P_NOROAD.lon };
      const uploadId = await stageFor(u, spot);
      const hdr = { 'idempotency-key': `photo-race-${crypto.randomUUID()}` };
      const body = reportBody(spot, { photo_upload_id: uploadId });
      const [r1, r2] = await Promise.all([
        u.post('/v1/reports', body, hdr),
        u.post('/v1/reports', body, hdr),
      ]);
      const created = [r1, r2].filter((r) => r.status === 201);
      const replayed = [r1, r2].filter((r) => r.status === 200 && r.json.replayed);
      assert.equal(created.length, 1);
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0].json.photo?.evidence_id, created[0].json.photo?.evidence_id);
      const det = await u.get(`/v1/issues/${created[0].json.issue.id}`);
      assert.equal(det.json.evidence.length, 1);
    });

    await t.test('idempotent replay after a lost response returns the original binding, not 422', async () => {
      const u = await fresh(wOn);
      const spot = { lat: P_NOROAD.lat + 0.08, lon: P_NOROAD.lon };
      const uploadId = await stageFor(u, spot);
      const hdr = { 'idempotency-key': `photo-replay-${crypto.randomUUID()}` };
      const body = reportBody(spot, { photo_upload_id: uploadId });
      const r1 = await u.post('/v1/reports', body, hdr);
      assert.equal(r1.status, 201);
      const r2 = await u.post('/v1/reports', body, hdr);
      assert.equal(r2.status, 200);
      assert.equal(r2.json.replayed, true);
      assert.equal(r2.json.photo?.evidence_id, r1.json.photo?.evidence_id);
      const det = await u.get(`/v1/issues/${r1.json.issue.id}`);
      assert.equal(det.json.evidence.length, 1);
    });

    await t.test('merged report binds the photo to the EXISTING issue', async () => {
      const a = await fresh(wOn);
      const b = await fresh(wOn);
      const spotA = { lat: P_NOROAD.lat + 0.09, lon: P_NOROAD.lon };
      const up1 = await stageFor(a, spotA);
      const r1 = await a.post('/v1/reports', reportBody(spotA, { photo_upload_id: up1, hazard: 'flooding' }));
      assert.equal(r1.status, 201);
      const spotB = { lat: spotA.lat + 0.0001, lon: spotA.lon }; // ~11 m away -> merges
      const up2 = await stageFor(b, spotB);
      const r2 = await b.post('/v1/reports', reportBody(spotB, { photo_upload_id: up2, hazard: 'flooding' }));
      assert.equal(r2.status, 200);
      assert.equal(r2.json.merged_into_existing, true);
      assert.equal(r2.json.issue.id, r1.json.issue.id);
      const det = await a.get(`/v1/issues/${r1.json.issue.id}`);
      assert.equal(det.json.evidence.length, 2);
    });

    await t.test('location is checked against the REPORT, so a merge-boundary reporter is not falsely rejected', async () => {
      const a = await fresh(wOn);
      const b = await fresh(wOn);
      const base = { lat: P_NOROAD.lat + 0.2, lon: P_NOROAD.lon };
      const up1 = await stageFor(a, base);
      const r1 = await a.post('/v1/reports', reportBody(base, { photo_upload_id: up1, hazard: 'pothole' }));
      assert.equal(r1.status, 201);
      const bSpot = { lat: base.lat + 0.00022, lon: base.lon };       // ~24 m north -> inside 30 m merge radius
      const photoSpot = { lat: base.lat + 0.00044, lon: base.lon };   // ~49 m north of issue, ~25 m from B
      const up2 = await stageFor(b, photoSpot);
      const r2 = await b.post('/v1/reports', reportBody(bSpot, { photo_upload_id: up2, hazard: 'pothole' }));
      assert.equal(r2.status, 200);
      assert.equal(r2.json.merged_into_existing, true);
      assert.ok(r2.json.photo?.evidence_id);
    });

    await t.test('sweep removes expired unconsumed rows but never consumed evidence blobs', async () => {
      const u = await fresh(wOn);
      const spot = { lat: P_NOROAD.lat + 0.11, lon: P_NOROAD.lon };
      const up1 = await stageFor(u, spot);
      const r1 = await u.post('/v1/reports', reportBody(spot, { photo_upload_id: up1 }));
      assert.equal(r1.status, 201);
      const up2 = await stageFor(u, { lat: spot.lat, lon: spot.lon + 0.001 });
      await wOn.adminDb.query(`UPDATE staged_uploads SET expires_at = now() - interval '1 minute' WHERE id IN ($1,$2)`, [up1, up2]);
      await stageFor(u, { lat: spot.lat, lon: spot.lon + 0.002 }); // triggers the lazy sweep
      const gone = (await wOn.adminDb.query('SELECT count(*)::int AS n FROM staged_uploads WHERE id=$1', [up2])).rows[0].n;
      const kept = (await wOn.adminDb.query('SELECT count(*)::int AS n FROM staged_uploads WHERE id=$1', [up1])).rows[0].n;
      assert.equal(gone, 0);
      assert.equal(kept, 1);
      const blob = await u.get(`/v1/issues/${r1.json.issue.id}/evidence/${r1.json.photo.evidence_id}`);
      assert.equal(blob.status, 200);
    });

    await t.test('staging limits: 6th unbound photo is 429, hourly cap is 429', async () => {
      const u = await fresh(wOn);
      for (let i = 0; i < 5; i++) {
        await stageFor(u, { lat: P_NOROAD.lat + 0.3, lon: P_NOROAD.lon + i * 0.001 });
      }
      const sixth = await stageAt(u, { lat: P_NOROAD.lat + 0.3, lon: P_NOROAD.lon + 0.01 }, await jpeg());
      assert.equal(sixth.status, 429);
      assert.equal(sixth.json.error, 'too_many_staged');
      const sub = `citizen-flood-${crypto.randomUUID()}`;
      const other = client(wOn, await userToken(sub));
      await other.get('/v1/me'); // materialises the account
      const uid = (await wOn.adminDb.query('SELECT id FROM users WHERE subject=$1', [sub])).rows[0].id;
      for (let i = 0; i < 30; i++) {
        await wOn.adminDb.query(
          `INSERT INTO staged_uploads (uploader_id, storage_key, sha256, content_type, byte_size, width, height, claimed_geom, consumed_at)
           VALUES ($1, $2, 'x', 'image/jpeg', 1, 1, 1, ST_SetSRID(ST_MakePoint(76,30),4326)::geography, now())`,
          [uid, `seed-${seq}-${i}`]);
      }
      const r = await stageAt(other, P_NOROAD, await jpeg());
      assert.equal(r.status, 429);
      assert.equal(r.json.error, 'rate_limited');
    });

    await t.test('concurrent stages from one account cannot exceed the pending cap', async () => {
      const u = await fresh(wOn);
      const img = await jpeg();
      const rs = await Promise.all(
        Array.from({ length: 8 }, (_, i) => stageAt(u, { lat: P_NOROAD.lat + 0.35, lon: P_NOROAD.lon + i * 0.001 }, img)));
      const ok = rs.filter((r) => r.status === 201).length;
      const capped = rs.filter((r) => r.status === 429).length;
      assert.equal(ok, 5);
      assert.equal(capped, 3);
    });

    await t.test('failing store: sweep keeps the row and retries, API stays up', async () => {
      const { localStore } = await import('../src/storage.ts');
      const dir = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/ntblob-flaky-');
      const flaky = { ...localStore(dir), del: async () => { throw new Error('store down'); } };
      const wF = await newWorld({ photoRequired: true }, undefined, flaky);
      try {
        await seed(wF);
        const u = client(wF, await userToken('citizen-flaky-store'));
        const s1 = await stageAt(u, P_NOROAD, await jpeg());
        assert.equal(s1.status, 201);
        await wF.adminDb.query(`UPDATE staged_uploads SET expires_at = now() - interval '1 minute' WHERE id=$1`, [s1.json.upload_id]);
        // the next stage triggers the sweep; the blob delete fails, so the row must SURVIVE for a later retry
        const s2 = await stageAt(u, { lat: P_NOROAD.lat, lon: P_NOROAD.lon + 0.001 }, await jpeg());
        assert.equal(s2.status, 201);
        const kept = (await wF.adminDb.query('SELECT count(*)::int AS n FROM staged_uploads WHERE id=$1', [s1.json.upload_id])).rows[0].n;
        assert.equal(kept, 1);
      } finally {
        await wF.close();
      }
    });

    await t.test('sweep never deletes the blob of a row an in-flight consumer holds (SKIP LOCKED)', async () => {
      const u = await fresh(wOn);
      const spot = { lat: P_NOROAD.lat + 0.13, lon: P_NOROAD.lon };
      const uploadId = await stageFor(u, spot);
      await wOn.adminDb.query(`UPDATE staged_uploads SET expires_at = now() - interval '1 minute' WHERE id=$1`, [uploadId]);
      // simulate a report tx that has locked the staged row (it began before expiry)
      const conn = await wOn.adminDb.connect();
      await conn.query('BEGIN');
      await conn.query('SELECT id FROM staged_uploads WHERE id=$1 FOR UPDATE', [uploadId]);
      // a concurrent stage triggers the sweep: the locked row must be skipped, blob kept
      const sweeper = await fresh(wOn);
      await stageFor(sweeper, { lat: P_NOROAD.lat + 0.14, lon: P_NOROAD.lon });
      const kept = (await wOn.adminDb.query('SELECT count(*)::int AS n FROM staged_uploads WHERE id=$1', [uploadId])).rows[0].n;
      assert.equal(kept, 1);
      await conn.query('ROLLBACK');
      conn.release();
      // un-expire and bind: the blob must still exist (was not deleted under the lock)
      await wOn.adminDb.query(`UPDATE staged_uploads SET expires_at = now() + interval '1 hour' WHERE id=$1`, [uploadId]);
      const r = await u.post('/v1/reports', reportBody(spot, { photo_upload_id: uploadId }));
      assert.equal(r.status, 201);
      const blob = await u.get(`/v1/issues/${r.json.issue.id}/evidence/${r.json.photo.evidence_id}`);
      assert.equal(blob.status, 200);
      assert.equal(blob.headers['content-type'], 'image/jpeg');
    });

    await t.test('staff accounts stage and bind like any reporter (role compatibility preserved)', async () => {
      // docs role workflow does not prohibit staff filing citizen reports; stage must not either
      const officer = client(wOn, await userToken('officer-1'));
      const spot = { lat: P_NOROAD.lat + 0.15, lon: P_NOROAD.lon };
      const uploadId = await stageFor(officer, spot);
      const r = await officer.post('/v1/reports', reportBody(spot, { photo_upload_id: uploadId }));
      assert.equal(r.status, 201);
      assert.ok(r.json.photo?.evidence_id);
    });

    await t.test('bad image to stage is rejected like evidence uploads', async () => {
      const u = await fresh(wOn);
      const bad = await stageAt(u, P_NOROAD, Buffer.from('not an image'));
      assert.equal(bad.status, 415);
    });
  } finally {
    await wOn.close();
    await wOff.close();
  }
});
