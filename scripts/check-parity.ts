// Runs the same logical queries through Zetaris (live) and DuckDB (sample mode) and
// checks the answers match, so SAMPLE_MODE results can be trusted to mirror live ones.
import { LocalBackend } from "../src/data/local.ts";
import { ZetarisBackend } from "../src/data/zetaris.ts";
import { ndcExpr, type Dialect } from "../src/data/dialect.ts";
import { silentTrace } from "../src/trace.ts";

const queries: { name: string; sql: (d: Dialect) => string }[] = [
  { name: "row counts", sql: () => `SELECT (SELECT count(*) FROM hospital.item_master) items, (SELECT count(*) FROM hospital.inventory_lots) lots, (SELECT count(*) FROM fda_snapshot.recalls) recalls, (SELECT count(*) FROM fda_snapshot.shortages) shortages, (SELECT count(*) FROM fda_snapshot.ndc_packages) packages, (SELECT count(*) FROM wholesaler.catalog) catalog_rows` },
  { name: "naive NDC join (expect 0)", sql: () => `SELECT count(*) n FROM hospital.item_master i JOIN fda_snapshot.ndc_packages p ON i.ndc11 = p.package_ndc` },
  { name: "segment-normalised join", sql: d => `SELECT i.item_id, p.package_ndc FROM hospital.item_master i JOIN fda_snapshot.ndc_packages p ON i.ndc11 = ${ndcExpr(d, "p.package_ndc", "segments_to_11")} ORDER BY i.item_id` },
  { name: "catalog join with zero padding", sql: d => `SELECT i.item_id, c.wholesaler_item FROM hospital.item_master i JOIN wholesaler.catalog c ON i.ndc11 = ${ndcExpr(d, "c.ndc", "lpad_11")} ORDER BY i.item_id` },
  { name: "recall text lookup", sql: () => `SELECT recall_number, classification, code_info FROM fda_snapshot.recalls WHERE recall_number IN ('D-0727-2026', 'D-0850-2026') ORDER BY recall_number` },
  { name: "lots with dates", sql: () => `SELECT lot_row_id, lot_number, cast(expiry_date as varchar(10)) expiry, qty_units FROM hospital.inventory_lots WHERE item_id = 'RX-ROPI-05-20' ORDER BY lot_row_id` },
];

const z = new ZetarisBackend(), l = new LocalBackend(), trace = silentTrace();
let failed = 0;
for (const q of queries) {
  const [a, b] = await Promise.all([z.query(q.sql("spark"), { agent: "parity", purpose: q.name, trace }), l.query(q.sql("duckdb"), { agent: "parity", purpose: q.name, trace })]);
  const norm = (rows: Record<string, string | null>[]) => JSON.stringify(rows.map(r => Object.values(r).map(v => (v === null ? null : v.replace(/\.0$/, "")))));
  const same = norm(a) === norm(b);
  if (!same) failed++;
  console.log(`${same ? "PASS" : "FAIL"} ${q.name}: zetaris ${a.length} rows, duckdb ${b.length} rows`);
  if (!same) console.log("  zetaris:", JSON.stringify(a).slice(0, 300), "\n  duckdb: ", JSON.stringify(b).slice(0, 300));
}
await l.close();
console.log(failed ? `${failed} parity check(s) failed` : "all parity checks passed");
process.exit(failed ? 1 : 0);
