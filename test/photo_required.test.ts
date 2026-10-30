/** Photo-mandatory reports: staged upload -> atomic bind inside the report transaction. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, client, userToken, jpeg, reportBody, P_NOROAD } from './helpers.ts';

test('photo-mandatory reports: stage + atomic bind, guards and failure modes', async (t) => {
  const wOn = await newWorld({ photoRequired: true });
  const wOff = await newWorld({ photoRequired: false });
  try {
    for (const w of [wOn, wOff]) await seed(w);
    const uOn = client(wOn, await userToken('citizen-photo'));
    const uOff = client(wOff, await userToken('citizen-photo2'));
    const img = await jpeg();
    const stage = (w: any, u: any, lat = P_NOROAD.lat, lon = P_NOROAD.lon) => u.upload(`/v1/uploads/stage?lat=${lat}&lon=${lon}`, img);

    await t.test('photo_required: report without photo_upload_id is 422 when the flag is on', async () => {
      const r = await uOn.post('/v1/reports', reportBody(P_NOROAD));
      assert.equal(r.status, 422);
      assert.equal(r.json.error, 'photo_required');
    });

    await t.test('compat: same report succeeds when the flag is off (rollout window)', async () => {
      const r = await uOff.post('/v1/reports', reportBody(P_NOROAD));
      assert.equal(r.status, 201);
    });

    await t.test('stage returns a private upload id and report binds it atomically', async () => {
      const s1 = await stage(wOn, uOn);
      assert.equal(s1.status, 201);
      const uploadId = s1.json.upload_id;
      const r = await uOn.post('/v1/reports', reportBody(P_NOROAD, { photo_upload_id: uploadId }));
      assert.equal(r.status, 201);
      assert.ok(r.json.photo?.evidence_id);
      const issueId = r.json.issue.id;
      const det = await uOn.get(`/v1/issues/${issueId}`);
      assert.equal(det.json.evidence.length, 1);
      assert.equal(det.json.evidence[0].kind, 'report');
      const su = (await wOn.adminDb.query('SELECT consumed_at, issue_id FROM staged_uploads WHERE id=$1', [uploadId])).rows[0];
      assert.ok(su.consumed_at);
      assert.equal(su.issue_id, issueId);
      // the stored blob is the re-encoded JPEG (EXIF stripped) - served through evidence auth
      const blob = await uOn.get(`/v1/issues/${issueId}/evidence/${r.json.photo.evidence_id}`);
      assert.equal(blob.status, 200);
      assert.equal(blob.headers['content-type'], 'image/jpeg');
    });

    await t.test('cross-user binding is rejected', async () => {
      const s1 = await stage(wOn, uOn);
      const other = client(wOn, await userToken('citizen-thief'));
      const r = await other.post('/v1/reports', reportBody(P_NOROAD, { photo_upload_id: s1.json.upload_id }));
      assert.equal(r.status, 422);
      assert.equal(r.json.error, 'invalid_upload');
      // the victim's upload stays unconsumed
      const su = (await wOn.adminDb.query('SELECT consumed_at FROM staged_uploads WHERE id=$1', [s1.json.upload_id])).rows[0];
      assert.equal(su.consumed_at, null);
    });

    await t.test('a staged upload cannot be consumed twice', async () => {
      const s1 = await stage(wOn, uOn);
      const r1 = await uOn.post('/v1/reports', reportBody(P_NOROAD, { photo_upload_id: s1.json.upload_id, note: 'first' }));
      assert.equal(r1.status, 201);
      const r2 = await uOn.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.01, lon: P_NOROAD.lon + 0.01 }, { photo_upload_id: s1.json.upload_id }));
      assert.equal(r2.status, 422);
      assert.equal(r2.json.error, 'invalid_upload');
    });

    await t.test('expired staged upload is rejected', async () => {
      const s1 = await stage(wOn, uOn);
      await wOn.adminDb.query(`UPDATE staged_uploads SET expires_at = now() - interval '1 minute' WHERE id=$1`, [s1.json.upload_id]);
      const r = await uOn.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.02, lon: P_NOROAD.lon + 0.02 }, { photo_upload_id: s1.json.upload_id }));
      assert.equal(r.status, 422);
      assert.equal(r.json.error, 'invalid_upload');
    });

    await t.test('far photo rolls back the report (no orphan issue) and stays consumable', async () => {
      const far = { lat: P_NOROAD.lat + 0.5, lon: P_NOROAD.lon + 0.5 }; // ~78 km away
      const s1 = await stage(wOn, uOn, far.lat, far.lon);
      const r = await uOn.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.03, lon: P_NOROAD.lon + 0.03 }, { photo_upload_id: s1.json.upload_id }));
      assert.equal(r.status, 422);
      assert.equal(r.json.error, 'location_mismatch');
      // no issue row left behind at that spot
      const n = (await wOn.adminDb.query(
        `SELECT count(*)::int AS n FROM issues WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 50)`,
        [P_NOROAD.lat + 0.03, P_NOROAD.lon + 0.03])).rows[0].n;
      assert.equal(n, 0);
      // staged upload NOT consumed by the failed attempt
      const su = (await wOn.adminDb.query('SELECT consumed_at FROM staged_uploads WHERE id=$1', [s1.json.upload_id])).rows[0];
      assert.equal(su.consumed_at, null);
    });

    await t.test('two concurrent reports carrying the same upload id: exactly one binds', async () => {
      // A staged the photo; A and B report the same spot at the same time. Whoever the
      // scheduler runs first, the conditional claim admits exactly one of them; the
      // other's whole report (including any merge) rolls back.
      const spot = { lat: P_NOROAD.lat + 0.06, lon: P_NOROAD.lon + 0.06 };
      const s1 = await stage(wOn, uOn, spot.lat, spot.lon);
      const other = client(wOn, await userToken('citizen-racer'));
      const [r1, r2] = await Promise.all([
        uOn.post('/v1/reports', reportBody(spot, { photo_upload_id: s1.json.upload_id, hazard: 'debris' })),
        other.post('/v1/reports', reportBody(spot, { photo_upload_id: s1.json.upload_id, hazard: 'debris' })),
      ]);
      const ok = [r1, r2].filter((r) => r.status === 201 || r.status === 200);
      const bad = [r1, r2].filter((r) => r.status === 422);
      assert.equal(ok.length, 1);
      assert.equal(bad.length, 1);
      assert.equal(bad[0].json.error, 'invalid_upload');
      assert.ok(ok[0].json.photo?.evidence_id);
      const n = (await wOn.adminDb.query('SELECT count(*)::int AS n FROM staged_uploads WHERE id=$1 AND consumed_at IS NOT NULL', [s1.json.upload_id])).rows[0].n;
      assert.equal(n, 1);
      const det = await uOn.get(`/v1/issues/${ok[0].json.issue.id}`);
      assert.equal(det.json.evidence.length, 1);
    });

    await t.test('two concurrent requests with the same idempotency key: one creates, one replays', async () => {
      const spot = { lat: P_NOROAD.lat + 0.14, lon: P_NOROAD.lon + 0.14 };
      const s1 = await stage(wOn, uOn, spot.lat, spot.lon);
      const hdr = { 'idempotency-key': 'photo-race-key-1' };
      const body = reportBody(spot, { photo_upload_id: s1.json.upload_id });
      const [r1, r2] = await Promise.all([
        uOn.post('/v1/reports', body, hdr),
        uOn.post('/v1/reports', body, hdr),
      ]);
      const created = [r1, r2].filter((r) => r.status === 201);
      const replayed = [r1, r2].filter((r) => r.status === 200 && r.json.replayed);
      assert.equal(created.length, 1);
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0].json.photo?.evidence_id, created[0].json.photo?.evidence_id);
      const det = await uOn.get(`/v1/issues/${created[0].json.issue.id}`);
      assert.equal(det.json.evidence.length, 1);
    });

    await t.test('location is checked against the REPORT, so a merge-boundary reporter is not falsely rejected', async () => {
      // Issue at X; reporter B stands ~25 m away (inside the 30 m merge radius) and the
      // photo is claimed ~25 m beyond B - about 50 m from the issue, beyond the 50 m
      // issue-geom rule but within 50 m of B's report. Report-geom semantics must bind.
      const base = { lat: P_NOROAD.lat + 0.2, lon: P_NOROAD.lon + 0.2 };
      const s1 = await stage(wOn, uOn, base.lat, base.lon);
      const r1 = await uOn.post('/v1/reports', reportBody(base, { photo_upload_id: s1.json.upload_id, hazard: 'pothole' }));
      assert.equal(r1.status, 201);
      const other = client(wOn, await userToken('citizen-boundary'));
      const bSpot = { lat: base.lat + 0.00022, lon: base.lon }; // ~24 m north
      const photoSpot = { lat: base.lat + 0.00044, lon: base.lon }; // ~49 m north of issue
      const s2 = await stage(wOn, other, photoSpot.lat, photoSpot.lon);
      const r2 = await other.post('/v1/reports', reportBody(bSpot, { photo_upload_id: s2.json.upload_id, hazard: 'pothole' }));
      assert.equal(r2.status, 200);
      assert.equal(r2.json.merged_into_existing, true);
      assert.ok(r2.json.photo?.evidence_id);
    });

    await t.test('merged report binds the photo to the EXISTING issue', async () => {
      const s1 = await stage(wOn, uOn, P_NOROAD.lat + 0.08, P_NOROAD.lon + 0.08);
      const r1 = await uOn.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.08, lon: P_NOROAD.lon + 0.08 }, { photo_upload_id: s1.json.upload_id, hazard: 'flooding' }));
      assert.equal(r1.status, 201);
      // second user, ~15 m away, same hazard -> merges into the first issue
      const other = client(wOn, await userToken('citizen-merger'));
      const s2 = await stage(wOn, other, P_NOROAD.lat + 0.0801, P_NOROAD.lon + 0.0801);
      const r2 = await other.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.0801, lon: P_NOROAD.lon + 0.0801 }, { photo_upload_id: s2.json.upload_id, hazard: 'flooding' }));
      assert.equal(r2.status, 200);
      assert.equal(r2.json.merged_into_existing, true);
      assert.equal(r2.json.issue.id, r1.json.issue.id);
      const det = await uOn.get(`/v1/issues/${r1.json.issue.id}`);
      assert.equal(det.json.evidence.length, 2);
    });

    await t.test('retry after a rolled-back attempt succeeds with the same upload', async () => {
      const far = { lat: P_NOROAD.lat + 0.6, lon: P_NOROAD.lon + 0.6 };
      const s1 = await stage(wOn, uOn, far.lat, far.lon);
      const r1 = await uOn.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.09, lon: P_NOROAD.lon + 0.09 }, { photo_upload_id: s1.json.upload_id }));
      assert.equal(r1.status, 422);
      // same upload, report now filed at the photo's real spot -> succeeds
      const r2 = await uOn.post('/v1/reports', reportBody(far, { photo_upload_id: s1.json.upload_id }));
      assert.equal(r2.status, 201);
      assert.ok(r2.json.photo?.evidence_id);
    });

    await t.test('sweep removes expired unconsumed rows but never consumed evidence blobs', async () => {
      const s1 = await stage(wOn, uOn, P_NOROAD.lat + 0.11, P_NOROAD.lon + 0.11);
      const r1 = await uOn.post('/v1/reports', reportBody({ lat: P_NOROAD.lat + 0.11, lon: P_NOROAD.lon + 0.11 }, { photo_upload_id: s1.json.upload_id }));
      assert.equal(r1.status, 201);
      const s2 = await stage(wOn, uOn, P_NOROAD.lat + 0.12, P_NOROAD.lon + 0.12);
      // expire BOTH rows; the consumed one must survive the sweep
      await wOn.adminDb.query(`UPDATE staged_uploads SET expires_at = now() - interval '1 minute' WHERE id IN ($1,$2)`, [s1.json.upload_id, s2.json.upload_id]);
      await stage(wOn, uOn, P_NOROAD.lat + 0.13, P_NOROAD.lon + 0.13); // triggers the lazy sweep
      const gone = (await wOn.adminDb.query('SELECT count(*)::int AS n FROM staged_uploads WHERE id=$1', [s2.json.upload_id])).rows[0].n;
      const kept = (await wOn.adminDb.query('SELECT count(*)::int AS n FROM staged_uploads WHERE id=$1', [s1.json.upload_id])).rows[0].n;
      assert.equal(gone, 0);
      assert.equal(kept, 1);
      const blob = await uOn.get(`/v1/issues/${r1.json.issue.id}/evidence/${r1.json.photo.evidence_id}`);
      assert.equal(blob.status, 200);
    });

    await t.test('idempotent replay binds a staged photo once and does not duplicate evidence', async () => {
      const s1 = await stage(wOn, uOn);
      const hdr = { 'idempotency-key': 'photo-replay-1' };
      const body = reportBody({ lat: P_NOROAD.lat + 0.04, lon: P_NOROAD.lon + 0.04 }, { photo_upload_id: s1.json.upload_id });
      const r1 = await uOn.post('/v1/reports', body, hdr);
      assert.equal(r1.status, 201);
      const r2 = await uOn.post('/v1/reports', body, hdr);
      assert.equal(r2.status, 200);
      assert.equal(r2.json.replayed, true);
      assert.equal(r2.json.photo?.evidence_id, r1.json.photo?.evidence_id);
      const det = await uOn.get(`/v1/issues/${r1.json.issue.id}`);
      assert.equal(det.json.evidence.length, 1);
    });

    await t.test('staging limits: 6th unbound photo is 429, hourly cap is 429', async () => {
      for (let i = 0; i < 5; i++) {
        const r = await stage(wOn, uOn, P_NOROAD.lat + 0.3, P_NOROAD.lon + 0.3 + i * 0.001);
        assert.equal(r.status, 201, `stage ${i}`);
      }
      const sixth = await stage(wOn, uOn, P_NOROAD.lat + 0.3, P_NOROAD.lon + 0.4);
      assert.equal(sixth.status, 429);
      assert.equal(sixth.json.error, 'too_many_staged');
      // hourly cap: another account seeded with 30 staged rows in the last hour
      const other = client(wOn, await userToken('citizen-flood'));
      await other.get('/v1/me'); // materialises the account
      const uid = (await wOn.adminDb.query(`SELECT id FROM users WHERE subject='citizen-flood'`)).rows[0].id;
      for (let i = 0; i < 30; i++) {
        await wOn.adminDb.query(
          `INSERT INTO staged_uploads (uploader_id, storage_key, sha256, content_type, byte_size, width, height, claimed_geom, consumed_at)
           VALUES ($1, $2, 'x', 'image/jpeg', 1, 1, 1, ST_SetSRID(ST_MakePoint(76,30),4326)::geography, now())`,
          [uid, 'seed-' + i]);
      }
      const r = await stage(wOn, other, P_NOROAD.lat + 0.31, P_NOROAD.lon + 0.31);
      assert.equal(r.status, 429);
      assert.equal(r.json.error, 'rate_limited');
    });

    await t.test('concurrent stages from one account cannot exceed the pending cap', async () => {
      const u3 = client(wOn, await userToken('citizen-parallel-stage'));
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => stage(wOn, u3, P_NOROAD.lat + 0.35, P_NOROAD.lon + 0.35 + i * 0.001)));
      const ok = results.filter((r) => r.status === 201).length;
      const capped = results.filter((r) => r.status === 429).length;
      assert.equal(ok, 5);
      assert.equal(capped, 3);
    });

    await t.test('failing store: sweep keeps the row and retries, API stays up', async () => {
      const inner = (await import('../src/storage.ts')).localStore(wOn.cfg.storageDir!);
      const flaky = { ...inner, del: async () => { throw new Error('store down'); } };
      const wF = await newWorld({ photoRequired: true }, undefined, flaky);
      try {
        await seed(wF);
        const uF = client(wF, await userToken('citizen-flaky'));
        const s1 = await uF.upload(`/v1/uploads/stage?lat=${P_NOROAD.lat}&lon=${P_NOROAD.lon}`, await jpeg());
        assert.equal(s1.status, 201);
        await wF.adminDb.query(`UPDATE staged_uploads SET expires_at = now() - interval '1 minute' WHERE id=$1`, [s1.json.upload_id]);
        // next stage triggers the sweep; the delete fails, so the row must SURVIVE for retry
        const s2 = await uF.upload(`/v1/uploads/stage?lat=${P_NOROAD.lat}&lon=${P_NOROAD.lon}`, await jpeg());
        assert.equal(s2.status, 201);
        const kept = (await wF.adminDb.query('SELECT count(*)::int AS n FROM staged_uploads WHERE id=$1', [s1.json.upload_id])).rows[0].n;
        assert.equal(kept, 1);
      } finally {
        await wF.close();
      }
    });

    await t.test('bad image to stage is rejected like evidence uploads', async () => {
      const bad = await uOn.upload(`/v1/uploads/stage?lat=${P_NOROAD.lat}&lon=${P_NOROAD.lon}`, Buffer.from('not an image'));
      assert.equal(bad.status, 415);
    });
  } finally {
    await wOn.close();
    await wOff.close();
  }
});
