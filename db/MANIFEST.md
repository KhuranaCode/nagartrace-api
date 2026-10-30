# Migration namespace manifest

db/*.sql is executed in sorted filename order by the migrator; db-pending/ is NEVER
auto-applied (explicit, coordinated apply only). Numbers are reserved across ALL lanes,
including drafts that are not merged yet. Before adding a migration, check this file,
db/, db-pending/, and confirm with the infra peer.

| Number | Lane | Status |
| --- | --- | --- |
| 001-008 | core schema .. staged uploads | merged, live |
| 009 | road registry staging (OSM geometry) | branch feat/gov-records, pending review |
| 010 | NHAI award records + seed in db-pending/010_seed | branch feat/gov-records, pending review |
| 011 | followup reminder pipeline | RESERVED - in db-pending/, held for review-gated apply |
| 012 | complaint IDs (complaint_no sequence) | branch feat/complaint-ids, unmerged |

Collision history: complaint IDs were first drafted as 009 (collided with road), then 010
(collided with NHAI draft). Do not renumber into a reserved slot; pick the next free number
and record it here first.
