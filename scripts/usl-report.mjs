// Runs the exploratory, semantic-layer and data-quality queries against Zetaris and writes
// their real results to docs/zetaris-usl-results.md. Usage: node scripts/usl-report.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8")
  .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

const Q = [
  ["Hospital inventory (PostgreSQL via JDBC)", [
    ["How much stock is on hand, by location type?", "SELECT l.kind, COUNT(*) AS lots, SUM(i.qty_units) AS units FROM hospital.inventory_lots i JOIN hospital.locations l ON i.location_code = l.location_code GROUP BY l.kind ORDER BY units DESC"],
    ["Which items have lots expiring before 2026-12-31?", "SELECT m.description, i.location_code, i.lot_number, i.expiry_date, i.qty_units FROM hospital.inventory_lots i JOIN hospital.item_master m ON i.item_id = m.item_id WHERE i.expiry_date < '2026-12-31' ORDER BY i.expiry_date LIMIT 5"],
    ["What is average daily use per item over the recorded window?", "SELECT d.item_id, m.description, ROUND(SUM(d.units) / COUNT(DISTINCT d.day), 1) AS avg_daily_units FROM hospital.dispensing_daily d JOIN hospital.item_master m ON d.item_id = m.item_id GROUP BY d.item_id, m.description ORDER BY avg_daily_units DESC LIMIT 5"],
  ]],
  ["FDA recalls snapshot (JSON in object storage)", [
    ["How many recall reports per molecule and class?", "SELECT molecule_query, classification, COUNT(*) AS recalls FROM fda_snapshot.recalls GROUP BY molecule_query, classification ORDER BY recalls DESC LIMIT 8"],
    ["Which recalls are still ongoing, newest first?", "SELECT recall_number, recalling_firm, classification, report_date FROM fda_snapshot.recalls WHERE status = 'Ongoing' ORDER BY report_date DESC LIMIT 5"],
  ]],
  ["FDA shortages snapshot (JSON in object storage)", [
    ["How many shortage listings per status?", "SELECT status, COUNT(*) AS listings FROM fda_snapshot.shortages GROUP BY status ORDER BY listings DESC"],
    ["Which in-scope molecules are currently short, and why?", "SELECT generic_name, company_name, availability, shortage_reason FROM fda_snapshot.shortages WHERE status = 'Current' LIMIT 5"],
  ]],
  ["FDA NDC directory (JSON in object storage)", [
    ["How many packages per labeler for the molecules in scope?", "SELECT labeler_name, COUNT(*) AS packages FROM fda_snapshot.ndc_packages GROUP BY labeler_name ORDER BY packages DESC LIMIT 5"],
    ["What do FDA package codes look like (the format the hospital must match)?", "SELECT package_ndc, generic_name, package_description FROM fda_snapshot.ndc_packages WHERE generic_name LIKE '%ROPIVACAINE%' LIMIT 3"],
  ]],
  ["Wholesaler catalog (CSV in object storage)", [
    ["What is the availability mix in the catalog?", "SELECT status, COUNT(*) AS items FROM wholesaler.catalog GROUP BY status ORDER BY items DESC"],
    ["Which items are on backorder or allocation, with ETA?", "SELECT ndc, description, status, eta FROM wholesaler.catalog WHERE status <> 'Available' LIMIT 5"],
  ]],
  ["Live openFDA (REST tables, flattened by SchemaStore views)", [
    ["How many ongoing recalls does the live API return per class right now?", "SELECT classification, COUNT(*) AS recalls FROM fda_live_views.recalls GROUP BY classification ORDER BY recalls DESC"],
    ["What is the live shortage status by availability?", "SELECT availability, COUNT(*) AS listings FROM fda_live_views.shortages GROUP BY availability ORDER BY listings DESC"],
  ]],
  ["Recall revisions feed (JSON in object storage)", [
    ["Which revisions are recorded, and which are labelled drills?", "SELECT recall_number, update_seq, update_kind, drill, update_date FROM fda_updates.recall_updates ORDER BY recall_number, update_seq"],
    ["How many revisions per recall?", "SELECT recall_number, COUNT(*) AS revisions FROM fda_updates.recall_updates GROUP BY recall_number"],
  ]],
];
const USL = [
  ["The semantic layer is active: the product-code crosswalk view maps hospital items to every source", "SELECT source_table, COUNT(DISTINCT item_id) AS hospital_items_mapped, COUNT(*) AS mappings FROM lotline_views.ndc_crosswalk GROUP BY source_table ORDER BY source_table"],
  ["One question across three sources through the view: on-hand stock of items on the FDA shortage list, with FDA availability", "SELECT m.description, SUM(i.qty_units) AS units_on_hand, s.availability FROM lotline_views.ndc_crosswalk x JOIN hospital.item_master m ON x.item_id = m.item_id JOIN hospital.inventory_lots i ON i.item_id = m.item_id JOIN fda_snapshot.shortages s ON x.source_table = 'fda_snapshot.shortages' AND cast(s.package_ndc as string) = x.source_code GROUP BY m.description, s.availability ORDER BY units_on_hand DESC LIMIT 5"],
  ["Why the layer is needed: a naive join of hospital codes to FDA codes, without the view", "SELECT COUNT(DISTINCT m.item_id) AS items_matched_naively FROM hospital.item_master m JOIN fda_snapshot.ndc_packages p ON m.ndc11 = p.package_ndc"],
  ["The same question through the view", "SELECT COUNT(DISTINCT item_id) AS items_matched_via_usl FROM lotline_views.ndc_crosswalk WHERE source_table = 'fda_snapshot.ndc_packages'"],
];
const DQ = [
  ["DQ-1 Referential integrity: every inventory lot belongs to a known item and location (expected 0 violations)", "SELECT COUNT(*) AS violations FROM hospital.inventory_lots i LEFT JOIN hospital.item_master m ON i.item_id = m.item_id LEFT JOIN hospital.locations l ON i.location_code = l.location_code WHERE m.item_id IS NULL OR l.location_code IS NULL"],
  ["DQ-2 Validity: hospital NDCs are exactly 11 digits and quantities are positive (expected 0 violations)", "SELECT SUM(CASE WHEN length(m.ndc11) <> 11 OR m.ndc11 RLIKE '[^0-9]' THEN 1 ELSE 0 END) AS bad_ndc, (SELECT COUNT(*) FROM hospital.inventory_lots WHERE qty_units <= 0) AS non_positive_qty FROM hospital.item_master m"],
  ["DQ-3 Coverage: every formulary item resolves to at least one FDA directory package through the USL", "SELECT COUNT(*) AS formulary_items_without_fda_mapping FROM hospital.item_master m WHERE m.formulary_status = 'formulary' AND m.item_id NOT IN (SELECT item_id FROM lotline_views.ndc_crosswalk WHERE source_table = 'fda_snapshot.ndc_packages')"],
];

async function run(sql) {
  const t0 = Date.now();
  const res = await fetch(`${env.ZETARIS_REST_URL}/sql-editor/sqls/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ZETARIS_API_KEY}`, "X-Org-ID": env.ZETARIS_ORG_ID, "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
    body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 50 }), signal: AbortSignal.timeout(300_000),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, ms: Date.now() - t0, headers: body.headers ?? [], data: body.data ?? [], error: body.msg ? String(body.msg).split("\n")[0].slice(0, 200) : null };
}
const table = r => r.ok ? [`| ${r.headers.join(" | ")} |`, `|${r.headers.map(() => "---").join("|")}|`, ...r.data.slice(0, 8).map(row => `| ${row.map(v => String(v ?? "").replace(/\|/g, "/").slice(0, 60)).join(" | ")} |`)].join("\n") : `Error: ${r.error}`;
const out = [`# Zetaris USL: live query results`, ``, `Generated by \`node scripts/usl-report.mjs\` against the local Zetaris on ${new Date().toISOString().slice(0, 16)}Z. Every result below is real output.`, ``];
let n = 0, ok = 0;
for (const [source, qs] of Q) {
  out.push(`## ${source}`, ``);
  for (const [q, sql] of qs) { const r = await run(sql); n++; ok += r.ok; out.push(`**${q}** (${r.ms} ms)`, ``, "```sql", sql, "```", ``, table(r), ``); }
}
out.push(`## The USL is active`, ``);
for (const [q, sql] of USL) { const r = await run(sql); n++; ok += r.ok; out.push(`**${q}** (${r.ms} ms)`, ``, "```sql", sql, "```", ``, table(r), ``); }
out.push(`## Data quality rules (executed)`, ``);
for (const [q, sql] of DQ) { const r = await run(sql); n++; ok += r.ok; out.push(`**${q}** (${r.ms} ms)`, ``, "```sql", sql, "```", ``, table(r), ``); }
writeFileSync(new URL("../docs/zetaris-usl-results.md", import.meta.url), out.join("\n") + "\n");
console.log(`${ok}/${n} queries succeeded; wrote docs/zetaris-usl-results.md`);
