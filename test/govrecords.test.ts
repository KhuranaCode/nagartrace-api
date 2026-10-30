import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, client, sign, reportBody } from './helpers.ts';
import { nhTokens, officialRecordsForPoint } from '../src/govrecords.ts';

test('nhTokens: strict whole-reference NH validation, no fuzzy/digit-only matches', () => {
  assert.deepEqual(nhTokens('NH-44'), ['44']);
  assert.deepEqual(nhTokens('NH44'), ['44']);
  assert.deepEqual(nhTokens('NH 44'), ['44']);
  assert.deepEqual(nhTokens('NH-44;NH-48'), ['44', '48']);
  assert.deepEqual(nhTokens('NH-161A'), ['161A']);
  assert.deepEqual(nhTokens(null), []);
  assert.deepEqual(nhTokens('Grand Trunk Road'), []);
  assert.deepEqual(nhTokens('NH'), []);
  // a bare number is ambiguous (could be SH/MDR/local): never inferred as NH from digits alone
  assert.deepEqual(nhTokens('44'), []);
  // state/other highway schemes must never match NH award rows
  assert.deepEqual(nhTokens('SH 44'), []);
  assert.deepEqual(nhTokens('SH-44'), []);
  assert.deepEqual(nhTokens('SR44'), []);
  assert.deepEqual(nhTokens('MDR 44'), []);
  assert.deepEqual(nhTokens('State Highway 44'), []);
});

const insertRoad2 = (w: any, o: { name?: string | null; ref?: string | null; lat?: number; lon?: number }) =>
  w.adminDb.query(
    `INSERT INTO road_registry_staging (source, source_id, source_label, attribution, name, ref, road_class, geom)
     VALUES ('osm', $5, 'osm test extract', '(c) OpenStreetMap contributors, ODbL', $1, $2, 'primary',
             ST_MakeLine(ST_MakePoint($4,$3), ST_MakePoint($4+0.002,$3+0.002))::geography)`,
    [o.name ?? null, o.ref ?? null, o.lat ?? 30.7, o.lon ?? 76.7, 'way/' + Math.random().toString(36).slice(2)]);

const insertAward = (w: any, o: { sr: number; nh: string[]; contractor?: string | null; state?: string }) =>
  w.adminDb.query(
    `INSERT INTO nhai_award_records (source_url, source_label, page, sr, project_name, nh_from_name, contractor_name, state, loa_date, awarded_cost_cr)
     VALUES ('https://nhai.gov.in/test.pdf', 'test FY2024-25', 1, ($1)::int, 'test project ' || ($1)::text, $2::text[], $3, $4, '2024-12-27', 10.5)`,
    [o.sr, o.nh, o.contractor ?? 'Test Contractor Ltd', o.state ?? 'Punjab']);

test('official records: nearest NH road joins its exact-token NHAI awards only', async () => {
  const w = await newWorld();
  try {
    await seed(w);
    await insertRoad2(w, { name: 'NH 44 Strip', ref: 'NH-44' });
    await insertAward(w, { sr: 901, nh: ['44'], contractor: 'Real Builder One' });
    await insertAward(w, { sr: 902, nh: ['44'], contractor: 'Real Builder Two', state: 'Haryana' });
    await insertAward(w, { sr: 903, nh: ['48'], contractor: 'Other Highway Co' }); // different NH - must NOT join
    await insertAward(w, { sr: 904, nh: ['144'], contractor: 'Superset NH Co' }); // token superset - must NOT join
    const r = await officialRecordsForPoint(w.adminDb, 30.7005, 76.7005);
    assert.equal(r.road?.name, 'NH 44 Strip');
    assert.equal(r.road?.maintainer, 'unknown');
    assert.equal((r.road as any).operator, undefined, 'raw OSM operator tag never served');
    assert.equal(r.candidate_awards.length, 2);
    const contractors = r.candidate_awards.map((a: any) => a.contractor_name).sort();
    assert.deepEqual(contractors, ['Real Builder One', 'Real Builder Two']);
    assert.match(r.coverage_note, /exact official section text/);
    assert.match(r.candidate_warning, /NOT this report's verified contractor/);
    assert.match(r.candidate_warning, /no chainage-level resolution/);
  } finally { await w.close(); }
});

test('official records: honest absences - no road, non-NH road, NH with no FY award', async () => {
  const w = await newWorld();
  try {
    await seed(w);
    // no road anywhere near
    let r = await officialRecordsForPoint(w.adminDb, 25.0, 85.0);
    assert.equal(r.road, null);
    assert.equal(r.candidate_awards.length, 0);
    assert.match(r.coverage_note, /partial/);
    // city street with name but no NH ref
    await insertRoad2(w, { name: 'Bus Stand Road', ref: null });
    r = await officialRecordsForPoint(w.adminDb, 30.7005, 76.7005);
    assert.equal(r.road?.name, 'Bus Stand Road');
    assert.equal(r.candidate_awards.length, 0);
    assert.match(r.coverage_note, /maintainer stays unknown/);
    // NH road with no award rows at all
    await insertRoad2(w, { name: 'NH 99 Strip', ref: 'NH-99', lat: 30.9, lon: 76.9 });
    r = await officialRecordsForPoint(w.adminDb, 30.9005, 76.9005);
    assert.equal(r.road?.ref, 'NH-99');
    assert.equal(r.candidate_awards.length, 0);
    assert.match(r.coverage_note, /FY2024-25 only/);
  } finally { await w.close(); }
});

test('nearest staged road with SH/SR/bare-digit ref yields NO NH candidates', async () => {
  const w = await newWorld();
  try {
    await seed(w);
    for (const ref of ['SH 44', 'SR-44', '44', 'MDR 44', 'State Highway 44']) {
      await insertRoad2(w, { name: 'SH Strip ' + ref, ref, lat: 30.71, lon: 76.71 });
      await insertAward(w, { sr: 950 + ref.length, nh: ['44'], contractor: 'Real Builder Nine' });
      const r = await officialRecordsForPoint(w.adminDb, 30.7105, 76.7105);
      assert.equal(r.road?.ref, ref);
      assert.equal(r.candidate_awards.length, 0, `ref ${ref} must never join NH-44 awards`);
      assert.match(r.coverage_note, /no national-highway reference|No FY2024-25 NHAI award record is linked/);
      await w.adminDb.query('DELETE FROM road_registry_staging'); await w.adminDb.query('DELETE FROM nhai_award_records');
    }
    // explicit NH prefix on the road ref still joins intentionally
    await insertRoad2(w, { name: 'Real NH Strip', ref: 'NH 44', lat: 30.71, lon: 76.71 });
    await insertAward(w, { sr: 949, nh: ['44'], contractor: 'Real Builder Nine' });
    const ok = await officialRecordsForPoint(w.adminDb, 30.7105, 76.7105);
    assert.equal(ok.candidate_awards.length, 1);
  } finally { await w.close(); }
});

test('HTTP: public issue detail carries official_records; browse endpoint serves verbatim rows', async () => {
  const w = await newWorld();
  try {
    await seed(w);
    await insertRoad2(w, { name: 'NH 44 Strip', ref: 'NH-44' });
    await insertAward(w, { sr: 901, nh: ['44'], contractor: 'Real Builder One' });
    const a = client(w, await sign('gov-a'));
    const rep = await a.post('/v1/reports', reportBody({ lat: 30.7005, lon: 76.7005 }));
    assert.equal(rep.status, 201);
    const id = rep.json.issue.id;
    const pub = await client(w, await sign('gov-b')).get(`/v1/public/issues/${id}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.json.official_records.road.name, 'NH 44 Strip');
    assert.equal(pub.json.official_records.candidate_awards[0].contractor_name, 'Real Builder One');
    const det = await a.get(`/v1/issues/${id}`);
    assert.equal(det.status, 200);
    assert.equal(det.json.official_records.candidate_awards.length, 1);
    // browse
    const all = await a.get('/v1/public/gov-records/nhai-awards');
    assert.equal(all.status, 200);
    assert.equal(all.json.awards.length, 1);
    assert.match(all.json.dataset.coverage, /FY2024-25/);
    assert.match(all.json.dataset.anomaly_note, /sr 20/);
    const byState = await a.get('/v1/public/gov-records/nhai-awards?state=punjab');
    assert.equal(byState.json.awards.length, 1);
    const byNh = await a.get('/v1/public/gov-records/nhai-awards?nh=NH-48');
    assert.equal(byNh.json.awards.length, 0);
    // regressions (review findings): malformed nh -> 400, never broad results; candidate semantics explicit
    const bad = await a.get('/v1/public/gov-records/nhai-awards?nh=abc');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'validation');
    const bad2 = await a.get('/v1/public/gov-records/nhai-awards?nh=NH-');
    assert.equal(bad2.status, 400);
    for (const v of ['definitelyinvalid', 'NH--44', 'SR44', 'SH44', 'SR 44']) {
      const r2 = await a.get(`/v1/public/gov-records/nhai-awards?nh=${encodeURIComponent(v)}`);
      assert.equal(r2.status, 400, `nh=${v} must not broaden to all awards`);
    }
    assert.equal(pub.json.official_records.responsible_contractor, 'unknown');
    assert.equal(pub.json.official_records.candidate_awards[0].match_status, 'candidate');
    assert.match(pub.json.official_records.coverage_note, /responsible contractor for this report is UNKNOWN/);
  } finally { await w.close(); }
});

test('PUBLIC PRECISION: public official_records derive from the public rounded point only', async () => {
  const w = await newWorld();
  try {
    await seed(w);
    await insertRoad2(w, { name: 'NH 44 Strip', ref: 'NH-44' });
    await insertAward(w, { sr: 902, nh: ['44'], contractor: 'Real Builder One' });
    const a = client(w, await sign('gov-a'));
    // raw point slightly offset from the road; its 1e4-rounded public point differs in distance
    const rep = await a.post('/v1/reports', reportBody({ lat: 30.70019, lon: 76.70004 })); // off the diagonal: rounding changes the derived distance
    assert.equal(rep.status, 201);
    const id = rep.json.issue.id;
    const pub = await client(w, await sign('gov-b')).get(`/v1/public/issues/${id}`);
    assert.equal(pub.status, 200);
    const loc = pub.json.location;
    assert.equal(loc.lat, Math.round(30.70019 * 1e4) / 1e4);
    const atPublicPoint = JSON.parse(JSON.stringify(await officialRecordsForPoint(w.adminDb, loc.lat, loc.lon))); // JSON-normalized like the wire
    assert.deepEqual(pub.json.official_records, atPublicPoint);
    const atPrivatePoint = await officialRecordsForPoint(w.adminDb, 30.70019, 76.70004);
    if (atPrivatePoint.road && atPublicPoint.road) assert.notEqual(atPrivatePoint.road.distance_m, atPublicPoint.road.distance_m, 'regression needs a point where rounding changes the derived distance');
    // hidden-404 for non-reporter non-staff is retained
    const tri = await client(w, await sign('gov-c')).get(`/v1/issues/${id}`);
    assert.equal(tri.status, 404);
  } finally { await w.close(); }
});
