# Lotline: sponsor technology explanation

Lotline is a recall-to-supply desk for a hospital pharmacy buyer. Given an FDA recall, agents reconcile product identifiers, check stocked lots, compute remaining supply, screen alternatives and produce an evidence-linked checklist. The hospital and wholesaler are fictional fixtures; FDA data is a dated public snapshot. The system proposes work and requires pharmacist review.

## Zetaris: one query surface over fragmented evidence

Six logical domains are connected: hospital inventory/usage/purchasing, FDA recalls, FDA shortages, FDA NDC packages, wholesaler availability, and recall revisions. They use three transport types:

| Transport | Registration and purpose |
|---|---|
| PostgreSQL JDBC | `hospital.locations`, `item_master`, `inventory_lots`, `dispensing_daily`, `purchase_orders` |
| S3 JSON | `fda_snapshot.recalls`, `shortages`, `ndc_packages`; `fda_updates.recall_updates` |
| S3 CSV | `wholesaler.catalog` |
| REST | `fda_live.shortages_raw`, `recalls_raw`, flattened through `fda_live_views` |

“Six sources” describes domains, not six physical connectors. The SQL registers five source families plus view containers; the agent-facing catalog has 12 logical tables. Live application queries use Zetaris REST SQL under five non-admin principals. A single policy defines the cartographer, planner, exposure, supply and watcher table allowlists and generates their SELECT grants. DuckDB enforces the same policy over bundled files. The critic and reporter receive agent results and have no data principal.

The Source Cartographer examines columns, samples identifier formats, tests proposed joins using overlap counts, and keeps the measured mappings in the World Model. Administrator setup publishes `lotline_views.ndc_crosswalk`. This is a SchemaStore view, not a physically materialized result cache. In the fixture, the naive hospital-to-FDA-directory join matches 0/10 items, normalized matching reaches 10/10, normalized shortage matching reaches 7/10, and wholesaler padding raises matches from 5/10 to 8/10. Every SQL statement is visible in the HTML evidence view. Query failures are traced too.

The watcher refreshes all recorded source evidence: recall revisions, inventory, item master, package hierarchy, snapshot/live shortages, catalog rows, directory candidates, dispensing aggregates, purchase orders and overlap probes. Each source has a shared projection. Claims record dependency hashes; missing rows receive durable tombstones. Query-set evidence tracks empty results and membership changes. The trace identifies changed table/key/fields and affected claims, and the packet shows the re-derived action differences.

The three labelled drills expand a recall, mark a recommended wholesaler product Backorder, or mark a snapshot shortage Unavailable. Sample drills alter local fixture files; live drills replace the same S3 objects Zetaris reads. Reset restores the three baselines. The external FDA REST service is read-only.

Setup uses Lightning `ADD USER WITH`, `CREATE ROLE`, `ASSIGN USER` and table-specific `GRANT SELECT`. Runtime authentication uses Basic login at `/auth/login` and an in-memory ID token; optional per-user API keys are supported. No administrator fallback exists. The local build restricts `DESCRIBE` separately, so column discovery uses SELECT headers with `LIMIT 0`. Setup owns the crosswalk view; runtime principals receive no creation/write grants. Policy refusals appear in both trace and HTML, including runs that cannot produce a case packet.

## Meterless World Model: conclusions with dependencies

The adopted engine is the Meterless World Model reference at upstream commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`, Apache-2.0. `engines/world-model/LICENSE`, `NOTICE` and `UPSTREAM_COMMIT` preserve provenance. The unmodified conformance runner passes **8/8** checks.

Lotline uses append-only JSONL persistence, replay-faithful conflict-resolution events, and `claims.ts`: evidence rows have stable IDs/content hashes; agent claims cite evidence and other claims. Updating evidence makes only dependent conclusions stale, including transitive dependents. Reasserting a claim clears its own staleness while revision propagates downstream. Tests cover invalid dependencies, retractions, idempotence, persistence replay and a torn final event.

The engine is used by the Cartographer's mapping claims, Exposure's product/lot claims, Supply's dependent stock conclusions, the revision loop, the watcher and the report's claim links. It is not an unused imported library. See the engine-to-feature table in the root README and `test/world-model.test.ts`.

## Nightshift: provider contract and receipts

Nightshift is the application's only live model provider. `src/llm.ts` sends OpenAI-compatible JSON requests to `/chat/completions`, authenticating through local environment configuration and app/scope headers. Credentials are never included in traces or cassettes. The API response's `meterless` fields supply receipt IDs, winning provider/model, token usage, latency, privacy path and cost.

Every actual HTTP attempt is traced, even on failure or invalid JSON. The renderer distinguishes live, replayed and cached replies. Missing receipt fields display as unreported. Recorded zero cost is an observed response field, not a pricing promise. Per-run memoization avoids paying twice for identical requests. Invalid structured replies get one repair request; transient transport failures get one retry; failure then reaches a labelled deterministic fallback.

For mechanical tasks, `chat_template_kwargs.enable_thinking=false` disables Nemotron reasoning. Senior review leaves reasoning enabled and permits a larger response budget. No direct NVIDIA model endpoint is called by the application.

## NVIDIA Nemotron: worker lane and senior review

| Model requested by exact name | Responsibilities |
|---|---|
| `nvidia/nemotron-3.5-lightning-30b-a3b` | Crosswalk hypotheses, planner triage, lot extraction, independent coverage reading, alternative choice, selection of verbatim verified summary sentences |
| `nvidia/nemotron-3-ultra-550b-a55b` | Senior critique, coverage/substitute adjudication, claim objections and human escalations |

Code independently enforces product scope, exact lot matching, arithmetic, alternative eligibility and action policy. The critic can trigger up to three rounds. Its lot objection is overruled only when both actual coverage readings agree the product is not covered. Exhausting the revision budget with pending changes blocks approval and escalates to a pharmacist. The buyer's “approval” is automated review status, not clinical permission.

## Measured critic ablation

The live experiment on **2026-10-25** completed ten paired cases in **14.33 minutes**: six real anchors and four real different-product/compounded traps. Both arms run the same agents against identical frozen DuckDB data. Lightning responses are generated live once and shared within each pair to control worker sampling; the treatment adds live Ultra and revision. Reporter prose is excluded from scoring. Labels never enter prompts.

| Metric | Lightning + code | Plus Ultra |
|---|---:|---:|
| Correct inventory-case lot verdicts | 230/230 | 230/230 |
| Correct original anchor-key verdicts | 21/21 | 21/21 |
| Wrongly quarantined units | 0 | 0 |
| Missed recalled units | 0 | 0 |
| Coverage disputes raised | 1 | 1 |
| Coverage disputes resolved | 0 | 1 |
| Adjudications | 0 | 2 |
| Objections / overruled objections | 0 / 0 | 8 / 0 |
| Final escalations | 3 | 17 |
| Logical response uses | 38 | 54 |
| Physical HTTP attempts | 38 | 13 |
| Model time, including failed attempts | 183,405 ms | 658,441 ms |
| Total arm wall time | 189,680 ms | 668,235 ms |

**Ultra did not improve lot-verdict accuracy in this run.** The fast worker read the recalled dextrose 70% bag as not covered; the NDC rule read it as covered, and Ultra resolved the dispute as covered, citing the NDC the recall names. Ultra also declined to order the 500 mL dextrose alternative for a recalled 2,000 mL presentation because the only volume-matched product is not orderable, and raised container and workflow cautions. These recommendations were not clinically adjudicated by this evaluation, so they are observations, not demonstrated clinical benefit. Two Ultra requests timed out and recovered on retry. For the QuVa combination recall the fast lot reader returned no valid reply after repair and the labelled deterministic reader was used. The treatment's HTTP count is incremental because worker replies are shared within each pair; it is not a standalone cost comparison.

All failures (none for lot verdicts), disputes, resolutions, objections, escalation text and receipts are in `eval/results/ablation-2026-10-25.json` and `.md`. Many of the 230 pairs are true negatives, which is why the 21 original labelled rows are also reported. This selected ten-case study cannot establish general safety or efficacy. No prompt was tuned against the labels.

## Reproduce the judge path

```sh
npm install
npm run demo
npm run typecheck
npm test
npm run engine:conformance
```

The demo needs no credentials. Promoted recordings are model replies, not saved packets or SQL results: DuckDB and the real agents produce the packet on every run. The six-anchor and watch recordings are in `data/cassettes/`. Investigative requests replay by exact hash; unmatched briefing inputs use the explicitly labelled summary template. The self-contained HTML shows the buyer checklist first and all evidence, SQL and provider receipts below it, including watch diffs and a sweep index.

This implementation does not include H-MEM, Iceberg writeback, a purchasing connector, or autonomous clinical authorization. The watcher polls dependencies of worked cases; it is not a continuous subscription or an atomic cross-source snapshot. openFDA is public domain/CC0 and unvalidated; synthetic fixtures contain no patient information. Every figure can be reproduced with the commands in the README; the critic ablation results are in `eval/results/`.
