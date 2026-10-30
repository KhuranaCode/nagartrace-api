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

    await t.test('idempotent replay binds a staged photo once and does not duplicate evidence', async () => {
      const s1 = await stage(wOn, uOn);
      const hdr = { 'idempotency-key': 'photo-replay-1' };
      const body = reportBody({ lat: P_NOROAD.lat + 0.04, lon: P_NOROAD.lon + 0.04 }, { photo_upload_id: s1.json.upload_id });
      const r1 = await uOn.post('/v1/reports', body, hdr);
      assert.equal(r1.status, 201);
      const r2 = await uOn.post('/v1/reports', body, hdr);
      assert.equal(r2.status, 200);
      assert.equal(r2.json.replayed, true);
      const det = await uOn.get(`/v1/issues/${r1.json.issue.id}`);
      assert.equal(det.json.evidence.length, 1);
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
