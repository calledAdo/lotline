# Lotline on Zetaris: the Unified Semantic Layer

This document answers the Zetaris evaluation criteria for Lotline. Every query result it cites is real output from the local Zetaris, recorded in [zetaris-usl-results.md](zetaris-usl-results.md) and reproducible with `node scripts/usl-report.mjs` (22 of 22 queries succeed).

## 1a. Use case and the data sources it needs

**Use case.** When the FDA recalls a drug, a hospital pharmacy buyer must decide within hours what to pull, what to check, what to use now and what to order. The answer depends on six sources that were never designed to work together, and that identify the same vial in different ways.

| # | Source | Kind | Zetaris object | Why Lotline needs it |
|---|---|---|---|---|
| 1 | Hospital pharmacy system | PostgreSQL (JDBC datasource) | `hospital.item_master`, `inventory_lots`, `locations`, `dispensing_daily`, `purchase_orders` | What stock exists, where, how fast it is used, what is on order |
| 2 | FDA recalls | JSON in object storage (filestore) | `fda_snapshot.recalls` | Which products and lots are recalled |
| 3 | FDA shortages | JSON in object storage (filestore) | `fda_snapshot.shortages` | Whether an alternative is itself short |
| 4 | FDA NDC directory | JSON in object storage (filestore) | `fda_snapshot.ndc_packages` | The authoritative package codes and presentations |
| 5 | Wholesaler catalog | CSV in object storage (filestore) | `wholesaler.catalog` | What can actually be ordered, and when |
| 6 | Live openFDA | REST API (Lightning REST tables + SchemaStore views) | `fda_live_views.recalls`, `fda_live_views.shortages` | Whether the snapshot is still current |
| 7 | Recall revisions | JSON in object storage (filestore) | `fda_updates.recall_updates` | When a recall changes, e.g. expands to another lot |

Seven sources across three access methods (JDBC, object storage, REST), well above the minimum of three.

## 1b. Onboarding, verification and exploratory queries

All sources are registered by one command, `npm run setup:zetaris`, from [scripts/register_zetaris_sources.sql](../scripts/register_zetaris_sources.sql), with credentials filled from `.env` at run time and never written in SQL. Each source was then verified with two or three exploratory questions (17 in total), all answered through Zetaris. Examples from the recorded results:

- **Hospital:** stock by location type; lots expiring before year end; average daily use per item.
- **FDA recalls:** recall reports per molecule and class; ongoing recalls, newest first.
- **FDA shortages:** listings per status; which molecules are short now, and why.
- **NDC directory:** packages per labeler; what an FDA package code looks like (hyphenated, three layouts).
- **Wholesaler:** availability mix; items on backorder or allocation, with ETA.
- **Live openFDA:** ongoing recalls per class right now; live shortage availability.
- **Revisions feed:** which revisions exist and which are labelled drills; revisions per recall.

The exploration found the core problem: the hospital stores 11-digit codes (`63323028623`), the FDA uses hyphenated codes in three layouts (`63323-286-23`), and the wholesaler drops leading zeros.

## 1c. The USL, its DDL, proof it is active, and a data quality rule

**The USL** is the set of registered sources plus two semantic objects built on them:

- `fda_live_views.recalls` and `fda_live_views.shortages`: SchemaStore views that flatten the live openFDA JSON into tables (DDL in [register_zetaris_sources.sql](../scripts/register_zetaris_sources.sql)).
- `lotline_views.ndc_crosswalk`: a SchemaStore view that maps every hospital item to its code in each other source. Its body is generated from measured mappings: the Source Cartographer agent tests each candidate code transformation against the data and keeps only the ones that match. Then it is published:

```sql
CREATE SCHEMASTORE CONTAINER lotline_views;
CREATE OR REPLACE SCHEMASTORE VIEW ndc_crosswalk WITH CONTAINER lotline_views AS
  SELECT i.item_id, 'fda_snapshot.ndc_packages' AS source_table, cast(s.package_ndc as string) AS source_code
  FROM hospital.item_master i JOIN fda_snapshot.ndc_packages s
    ON i.ndc11 = <measured normalisation of s.package_ndc>
  UNION ALL ...  -- one branch per source and measured transformation
```

Access is governed in the same layer: [scripts/setup_zetaris_principals.sql](../scripts/setup_zetaris_principals.sql) creates five users and roles (cartographer, planner, exposure, supply, watcher). Each gets `GRANT SELECT` on only the tables it needs. An out-of-scope query is refused by Zetaris and shown in Lotline's trace.

**The USL is active** (recorded results):

| Query | Result |
|---|---|
| Naive join of hospital codes to FDA directory codes, without the USL | **0** items matched |
| The same question through `lotline_views.ndc_crosswalk` | **10** of 10 items matched |
| Crosswalk coverage per source | NDC directory 10, wholesaler 8, shortages 7, recalls 4 hospital items |
| One question across hospital stock, the crosswalk and FDA shortages | On-hand units of every item on the shortage list, with FDA availability |

**Data quality rules, executed** (all returned 0 violations):

- **DQ-1 Referential integrity:** every inventory lot belongs to a known item and location.
- **DQ-2 Validity:** hospital codes are exactly 11 digits, and lot quantities are positive.
- **DQ-3 Coverage:** every formulary item resolves to at least one FDA directory package through the USL.

## 2a. Time the USL saved versus a hand-coded approach

Lotline contains a real hand-coded data layer for comparison: its offline mode, [src/data/local.ts](../src/data/local.ts) (75 lines of DuckDB wiring) plus a hand-written access allowlist, [src/data/policy.ts](../src/data/policy.ts) (48 lines). It only reads frozen local files. To match what the USL does, a hand-coded version would also need:

| Capability | With Zetaris | Hand-coded |
|---|---|---|
| Hospital PostgreSQL | One `CREATE DATASOURCE` + `REGISTER` statement | DB client, connection pooling, schema mapping |
| Files in object storage (JSON, CSV) | One `CREATE LIGHTNING FILESTORE TABLE` per source | S3 client, per-format parsers, schema inference |
| Live openFDA REST | `CREATE LIGHTNING REST TABLE` + a flattening view | HTTP client, paging, JSON flattening, caching |
| Cross-source joins | Plain SQL across all sources | Load everything into one engine, or join in application code |
| Code reconciliation reused by every agent | One published view | A shared library every agent must import and keep in sync |
| Per-agent access control | `ADD USER`, `CREATE ROLE`, `GRANT SELECT` | A custom authorisation layer, enforced in our own code |

**Our estimate:** registering all sources, views and principals took about half a day, including two Zetaris-specific issues (S3 path style and JSON layout). A hand-coded equivalent with live sources and enforced per-agent access would take two to three days, before tests. That is roughly a 4–6× saving on the data layer. The bigger gain is that the agents query one SQL surface, so adding a source changes the registration, not the agents.

## 2b. Where the USL helps, and where it does not

**It helps** when the value comes from joining sources that disagree. Here the agents ask business questions ("which of our lots are recalled, and what can replace them?") instead of integration questions. Governance (who may read what) sits in the same place as the data, and is visible in the trace.

**It does not help (yet)** with the hardest part of this use case: deciding that two codes mean the same product. That reconciliation is logic Lotline had to build itself and then publish into the USL. Debugging also needs care: in our sibling project, a filestore table registered before its files existed kept an empty schema until it was dropped and re-registered.

**A project that would benefit:** a multi-site health system reconciling formularies across hospitals that run different pharmacy systems. Each site's system becomes one datasource, the crosswalk becomes a shared view, and each site's staff get role-scoped access. We forecast weeks saved per site onboarded, compared with building point-to-point integrations.

## 2c. A requirement for Zetaris (written as a PM)

**Requirement: measured key mappings as a first-class USL object.**

*Problem.* Every cross-source project starts with "these two columns mean the same thing, after a transformation". Today that knowledge lives in application code or in a hand-written view, with no record of how well it matches or when it stops matching.

*Requirement.* A `CREATE KEY MAPPING` object that declares candidate transformations between two columns. Zetaris measures each candidate's match rate, keeps the best, exposes the result as a joinable view, and re-measures on refresh. It raises a data-quality alert when the match rate drops below a stated threshold.

*Mock DDL (what Lotline would write instead of generating its view):*

```sql
CREATE KEY MAPPING ndc_map
  FROM hospital.item_master.ndc11
  TO   fda_snapshot.ndc_packages.package_ndc, wholesaler.catalog.ndc, fda_snapshot.shortages.package_ndc
  CANDIDATES (strip_hyphens, pad_segments(5,4,2), lpad(11,'0'))
  KEEP BEST MATCH RATE
  ALERT WHEN MATCH RATE < 0.95;

SELECT * FROM ndc_map;                  -- item_id, source_table, source_code, transform, match_rate
SHOW KEY MAPPING STATS ndc_map;         -- naive 0/10 -> pad_segments 10/10
```

*Why it matters.* Lotline's Source Cartographer agent does exactly this by hand, and it is the step that turns 0 of 10 matches into 10 of 10. Making it a Zetaris object would let every project get it in one statement, governed and re-checked automatically.
