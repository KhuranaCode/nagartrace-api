import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, seed, client, sign, reportBody } from './helpers.ts';
import { nhTokens, officialRecordsForPoint } from '../src/govrecords.ts';

test('nhTokens: strict NH token extraction, no fuzzy matches', () => {
  assert.deepEqual(nhTokens('NH-44'), ['44']);
  assert.deepEqual(nhTokens('NH44'), ['44']);
  assert.deepEqual(nhTokens('NH 44'), ['44']);
  assert.deepEqual(nhTokens('44'), ['44']);
  assert.deepEqual(nhTokens('NH-44;NH-48'), ['44', '48']);
  assert.deepEqual(nhTokens('NH-161A'), ['161A']);
  assert.deepEqual(nhTokens(null), []);
  assert.deepEqual(nhTokens('Grand Trunk Road'), []);
  assert.deepEqual(nhTokens('NH'), []);
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
    assert.equal(r.nhai_awards.length, 2);
    const contractors = r.nhai_awards.map((a: any) => a.contractor_name).sort();
    assert.deepEqual(contractors, ['Real Builder One', 'Real Builder Two']);
    assert.match(r.coverage_note, /exact official section text/);
  } finally { await w.close(); }
});

test('official records: honest absences - no road, non-NH road, NH with no FY award', async () => {
  const w = await newWorld();
  try {
    await seed(w);
    // no road anywhere near
    let r = await officialRecordsForPoint(w.adminDb, 25.0, 85.0);
    assert.equal(r.road, null);
    assert.equal(r.nhai_awards.length, 0);
    assert.match(r.coverage_note, /partial/);
    // city street with name but no NH ref
    await insertRoad2(w, { name: 'Bus Stand Road', ref: null });
    r = await officialRecordsForPoint(w.adminDb, 30.7005, 76.7005);
    assert.equal(r.road?.name, 'Bus Stand Road');
    assert.equal(r.nhai_awards.length, 0);
    assert.match(r.coverage_note, /maintainer stays unknown/);
    // NH road with no award rows at all
    await insertRoad2(w, { name: 'NH 99 Strip', ref: 'NH-99', lat: 30.9, lon: 76.9 });
    r = await officialRecordsForPoint(w.adminDb, 30.9005, 76.9005);
    assert.equal(r.road?.ref, 'NH-99');
    assert.equal(r.nhai_awards.length, 0);
    assert.match(r.coverage_note, /FY2024-25 only/);
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
    assert.equal(pub.json.official_records.nhai_awards[0].contractor_name, 'Real Builder One');
    const det = await a.get(`/v1/issues/${id}`);
    assert.equal(det.status, 200);
    assert.equal(det.json.official_records.nhai_awards.length, 1);
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
  } finally { await w.close(); }
});
