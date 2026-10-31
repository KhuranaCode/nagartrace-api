import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEprocOrgRows } from '../src/contractor-retrieval.js';

// Verbatim rows fetched live 2026-10-31 ~03:53 IST from
// https://eproc.punjab.gov.in/nicgep/app?component=$DirectLink&page=FrontEndTendersByOrganisation&service=direct&sp=S4fOW%2By4lfko37f6uDHrBBw%3D%3D
// (public page, no captcha). Kept verbatim so the parser is pinned to the real source shape.
const LIVE_SAMPLE = `
| 11 | 29-Oct-2026 05:25 PM | 17-Nov-2026 01:00 PM | 17-Nov-2026 03:00 PM | [Balance work of special repair of various link roads under special repair program 2022-23,2023-24 and 2024-25 including 5 year routine maintenance in MC Patran (Group 4) District Patiala] [Bid no. 17/2 dated 23.10.2026][2026_CEPW_178261_1] | CE-PWD(B and R)||Construction Circle No.1-Patiala||Construction Division-Patiala |
| 31 | 24-Oct-2026 12:25 PM | 02-Nov-2026 01:00 PM | 02-Nov-2026 03:00 PM | [Preparation of Detailed Project Report for Rehabilitation/Upgradation of 2-Lane to 4 Laning of Patiala Samana Patran Road SH 10 section from Patiala to Patran in District Patiala.] [Re bid no.16 dated 23.10.2026][2026_CEPW_178042_1] | CE-PWD(B and R)||Construction Circle No.1-Patiala||Construction Division-Patiala |
`;

test('parseEprocOrgRows extracts title, ref and tender id verbatim from the live source shape', () => {
  const rows = parseEprocOrgRows(LIVE_SAMPLE);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tender_id, '2026_CEPW_178261_1');
  assert.equal(rows[0].ref_no, 'Bid no. 17/2 dated 23.10.2026');
  assert.ok(rows[0].title.includes('MC Patran (Group 4) District Patiala'));
  assert.equal(rows[1].tender_id, '2026_CEPW_178042_1');
  assert.ok(rows[1].title.includes('Patiala Samana Patran Road SH 10'));
});

test('parseEprocOrgRows returns nothing for captcha/empty pages', () => {
  assert.equal(parseEprocOrgRows('Provide Captcha and click on Search button').length, 0);
});
