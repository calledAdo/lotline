# Data provenance

The snapshot was fetched from the U.S. FDA's [openFDA API](https://open.fda.gov/) at **2026-10-24T19:22:28.706Z**. It is public domain / CC0 under [openFDA's licence](https://open.fda.gov/license/). FDA warns that these data are unvalidated and must not be relied on for medical-care decisions. The manifest records query URLs, source totals and transformation scope.

| File | Rows | Meaning |
|---|---:|---|
| `snapshot/fda_recalls.jsonl` | 615 | Flattened, deduplicated enforcement records |
| `snapshot/fda_shortages.jsonl` | 227 | Flattened drug shortage records |
| `snapshot/fda_ndc_packages.jsonl` | 2,350 | NDC directory package presentations |
| `sources/hospital_item_master.jsonl` | 10 | Fictional Riverside General products |
| `sources/hospital_inventory_lots.jsonl` | 23 | Fictional stock by lot, location and expiry |
| `sources/hospital_locations.jsonl` | 7 | Fictional stock locations |
| `sources/hospital_dispensing_daily.jsonl` | 1,713 | Synthetic aggregate usage; no patients |
| `sources/hospital_purchase_orders.jsonl` | 3 | Fictional inbound purchase orders |
| `sources/wholesaler_catalog.csv` | 21 | Fictional MedLine Distribution offers/status |
| `eval/lot_answer_key.json` | 21 labels | Evaluator-only anchor lot verdicts |

The molecules are ropivacaine, dextrose, ketorolac, sodium bicarbonate, furosemide and clindamycin. Fetching uses molecule searches and API pagination; this is a subset, not the complete FDA database. Different directory presentations can refer to the same ingredient. Counts of shortage rows are not counts of distinct drugs.

Hospital lots intentionally include recalled and unaffected presentations, a reused lot number, an expiry discrepancy and expired stock. Real manufacturer/product identifiers support joining, but inventory, utilization, purchasing, catalog availability and organization names are authored fixtures, not facts about any operating hospital or wholesaler. Their source is `scripts/hospital-spec.ts`; the fixtures are project-authored under the project's Apache-2.0 declaration.

`drills/recall_updates.jsonl` is reset to `recall_updates.baseline.jsonl`. Its baseline sentinel is not an FDA revision. `scripts/drill.ts expand` adds an explicitly labelled **DRILL** revision, not a newly discovered recall. Reset after every drill. Sample mode changes only the local file; live mode also updates S3.

`cassettes/*.jsonl` contains real Nightshift model requests and responses from the six anchor runs and the Naropin watch drill on October 25. Matching uses the whole canonical request hash. These are model output, not additional authoritative data or an answer key. Sidecar metadata records source run IDs and promotion details. They contain no SQL recordings or authentication headers; promotion verifies hashes, deduplicates and rejects suspected secrets. Changed requests fall back deterministically and are labelled in the trace.

The answer key and four trap expectations in `eval/ablation-scenarios.ts` are read only by evaluation code. They are not registered in Zetaris or included in agent prompts.

## Regeneration

Preserve the checked-in snapshot for exact cassette replay. To deliberately refresh live data after configuring `.env` and the local sources:

```sh
npm run data:fetch
npm run data:seed
npm run data:upload
npm run setup:zetaris
```

`data:fetch` calls public openFDA and rewrites snapshot/manifest files; `data:seed` generates fictional files and loads PostgreSQL; `data:upload` uploads JSON arrays (converted from JSONL for Zetaris) and CSV to S3. `setup:zetaris` registers JDBC, file and REST sources. Refreshes can change counts, keys, expected outcomes and cassette hashes; reevaluate rather than assuming historical results still apply.

The earlier “19 generic drugs recalled and short” research count came from the broader project design's 1,000-recall analysis (`../final-ranking.md`, section 4 relative to the repository root). Its raw broader query output is not bundled here, so it is attributed context rather than a reproduced result of this six-molecule snapshot.
