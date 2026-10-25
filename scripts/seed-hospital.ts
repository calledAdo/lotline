// Loads the synthetic hospital into Postgres (the hospital's own system of record) and
// writes the wholesaler catalog CSV. Copies of every table go to data/sources/ so
// SAMPLE_MODE can run without Postgres, and the answer key goes to data/eval/, which
// is never registered in Zetaris or shown to agents.
import { writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { ROOT, env, need, sampleMode } from "../src/env.ts";
import { buildHospital } from "./hospital-spec.ts";

const h = buildHospital();
const jsonl = (rows: object[]) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
const csvCell = (v: unknown) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
const csv = (rows: Record<string, unknown>[]) => [Object.keys(rows[0]!).join(","), ...rows.map(r => Object.values(r).map(csvCell).join(","))].join("\n") + "\n";

const src = path.join(ROOT, "data", "sources");
for (const [name, rows] of Object.entries({ locations: h.locations, item_master: h.items, inventory_lots: h.lots, dispensing_daily: h.dispensing, purchase_orders: h.purchaseOrders })) {
  writeFileSync(path.join(src, `hospital_${name}.jsonl`), jsonl(rows));
}
writeFileSync(path.join(src, "wholesaler_catalog.csv"), csv(h.catalog));
writeFileSync(path.join(ROOT, "data", "eval", "lot_answer_key.json"), JSON.stringify(h.answerKey, null, 2) + "\n");
console.log(`wrote data/sources/ (${h.items.length} items, ${h.lots.length} lots, ${h.dispensing.length} dispensing rows, ${h.catalog.length} catalog rows) and data/eval/lot_answer_key.json`);

if (sampleMode) {
  console.log("SAMPLE_MODE: skipping Postgres");
  process.exit(0);
}

const client = new pg.Client({
  host: env.HOSPITAL_DB_HOST ?? "127.0.0.1",
  port: Number(env.HOSPITAL_DB_PORT ?? 55432),
  database: "hospital",
  user: need("HOSPITAL_DB_USER"),
  password: need("HOSPITAL_DB_PASSWORD"),
});
await client.connect();
await client.query("BEGIN");
await client.query(`
  DROP TABLE IF EXISTS dispensing_daily, purchase_orders, inventory_lots, item_master, locations, smoke CASCADE;
  CREATE TABLE locations (location_code text PRIMARY KEY, name text NOT NULL, kind text NOT NULL);
  CREATE TABLE item_master (
    item_id text PRIMARY KEY, ndc11 char(11) NOT NULL UNIQUE, description text NOT NULL, generic_name text NOT NULL,
    strength text NOT NULL, dosage_form text NOT NULL, route text NOT NULL, manufacturer text NOT NULL,
    unit_of_issue text NOT NULL, units_per_pack int NOT NULL, formulary_status text NOT NULL);
  CREATE TABLE inventory_lots (
    lot_row_id int PRIMARY KEY, item_id text NOT NULL REFERENCES item_master, location_code text NOT NULL REFERENCES locations,
    lot_number text NOT NULL, expiry_date date NOT NULL, qty_units int NOT NULL CHECK (qty_units >= 0),
    received_on date NOT NULL, po_number text);
  CREATE TABLE dispensing_daily (
    item_id text NOT NULL REFERENCES item_master, location_code text NOT NULL REFERENCES locations,
    day date NOT NULL, units int NOT NULL, PRIMARY KEY (item_id, location_code, day));
  CREATE TABLE purchase_orders (
    po_number text PRIMARY KEY, item_id text NOT NULL REFERENCES item_master, packs int NOT NULL,
    ordered_on date NOT NULL, expected_on date NOT NULL, status text NOT NULL, supplier text NOT NULL);
`);
async function insert(table: string, rows: Record<string, unknown>[]) {
  const cols = Object.keys(rows[0]!);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const values = chunk.map((_, r) => `(${cols.map((_, c) => `$${r * cols.length + c + 1}`).join(",")})`).join(",");
    await client.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values}`, chunk.flatMap(row => cols.map(c => row[c])));
  }
}
await insert("locations", h.locations);
await insert("item_master", h.items);
await insert("inventory_lots", h.lots);
await insert("dispensing_daily", h.dispensing);
await insert("purchase_orders", h.purchaseOrders);
await client.query("COMMIT");
const counts = await client.query(`SELECT (SELECT count(*) FROM item_master) items, (SELECT count(*) FROM inventory_lots) lots, (SELECT count(*) FROM dispensing_daily) dispensing`);
console.log("Postgres hospital database seeded:", counts.rows[0]);
await client.end();
