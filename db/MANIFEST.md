# Migration namespace manifest

db/*.sql is executed in sorted filename order by the migrator; db-pending/ is NEVER
auto-applied (explicit, coordinated apply only). Numbers are reserved across ALL lanes,
including drafts that are not merged yet. Before adding a migration, check this file,
db/, db-pending/, and confirm with the infra peer.

| Number | Lane | Status |
| --- | --- | --- |
| 001-008 | core schema .. staged uploads | merged, live |
| 009 | road registry staging (OSM geometry) | applied on main (075665b), live |
| 010 | NHAI award records + seed in db-pending/010_seed | applied on main (075665b), live |
| 011 | followup reminder pipeline | RESERVED - in db-pending/, held for review-gated apply |
| 012 | complaint IDs (complaint_no sequence) | applied on main (f188141), live |
| 013 | multiple hazards per report/issue | branch release/013-multi-hazard (clean tree off live 075665b), pending independent review + coordinated apply |
| 015 | report source links (optional news/social URL evidence) | RESERVED - lane feat/report-source-links, review-gated |
| 016 | per-user per-feature AI processing consent (versioned, revocable; five features - guide, email draft, typed report check, photo-byte check, contractor brief - photo bytes consented separately from typed details) | branch feat/ai-laptop-candidate-clean, pending independent review + coordinated apply |

Collision history: complaint IDs were first drafted as 009 (collided with road), then 010
(collided with NHAI draft). Do not renumber into a reserved slot; pick the next free number
and record it here first.
