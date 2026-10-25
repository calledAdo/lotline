// Local backend for SAMPLE_MODE: DuckDB in-process over the committed files, exposing the
// same schema.table names Zetaris serves. Values are returned as strings, like Zetaris.
// The "live" openFDA views resolve to the snapshot, and say so in the trace.
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { ROOT } from "../env.ts";
import { SOURCES, type Column, type DataBackend, type Row } from "./backend.ts";
import type { Trace } from "../trace.ts";

const file = (p: string) => `'${path.join(ROOT, p).replaceAll("'", "''")}'`;

export class LocalBackend implements DataBackend {
  readonly name = "duckdb" as const;
  readonly dialect = "duckdb" as const;
  private conn?: DuckDBConnection;

  private async c(): Promise<DuckDBConnection> {
    if (this.conn) return this.conn;
    const db = await DuckDBInstance.create(":memory:");
    const c = await db.connect();
    const views: [string, string][] = [
      ["hospital.locations", `read_json_auto(${file("data/sources/hospital_locations.jsonl")})`],
      ["hospital.item_master", `read_json(${file("data/sources/hospital_item_master.jsonl")}, columns={item_id:'VARCHAR', ndc11:'VARCHAR', description:'VARCHAR', generic_name:'VARCHAR', strength:'VARCHAR', dosage_form:'VARCHAR', route:'VARCHAR', manufacturer:'VARCHAR', unit_of_issue:'VARCHAR', units_per_pack:'INTEGER', formulary_status:'VARCHAR'})`],
      ["hospital.inventory_lots", `read_json(${file("data/sources/hospital_inventory_lots.jsonl")}, columns={lot_row_id:'INTEGER', item_id:'VARCHAR', location_code:'VARCHAR', lot_number:'VARCHAR', expiry_date:'DATE', qty_units:'INTEGER', received_on:'DATE', po_number:'VARCHAR'})`],
      ["hospital.dispensing_daily", `read_json(${file("data/sources/hospital_dispensing_daily.jsonl")}, columns={item_id:'VARCHAR', location_code:'VARCHAR', day:'DATE', units:'INTEGER'})`],
      ["hospital.purchase_orders", `read_json_auto(${file("data/sources/hospital_purchase_orders.jsonl")})`],
      ["fda_snapshot.recalls", `read_json_auto(${file("data/snapshot/fda_recalls.jsonl")}, format='newline_delimited')`],
      ["fda_snapshot.shortages", `read_json_auto(${file("data/snapshot/fda_shortages.jsonl")}, format='newline_delimited')`],
      ["fda_snapshot.ndc_packages", `read_json_auto(${file("data/snapshot/fda_ndc_packages.jsonl")}, format='newline_delimited')`],
      ["wholesaler.catalog", `read_csv(${file("data/sources/wholesaler_catalog.csv")}, header=true, all_varchar=true)`],
      ["fda_updates.recall_updates", `read_json(${file("data/drills/recall_updates.jsonl")}, format='newline_delimited', columns={recall_number:'VARCHAR', update_seq:'INTEGER', update_date:'VARCHAR', update_kind:'VARCHAR', product_description:'VARCHAR', code_info:'VARCHAR', classification:'VARCHAR', status:'VARCHAR', drill:'BOOLEAN', note:'VARCHAR'})`],
    ];
    for (const s of ["hospital", "fda_snapshot", "wholesaler", "fda_live_views", "fda_updates"]) await c.run(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    for (const [name, src] of views) await c.run(`CREATE VIEW ${name} AS SELECT * FROM ${src}`);
    await c.run(`CREATE VIEW fda_live_views.shortages AS SELECT package_ndc, generic_name, company_name, availability, status, shortage_reason, related_info, presentation, update_date, update_type FROM fda_snapshot.shortages`);
    await c.run(`CREATE VIEW fda_live_views.recalls AS SELECT recall_number, status, classification, recalling_firm, reason_for_recall, product_description, code_info, report_date, recall_initiation_date FROM fda_snapshot.recalls WHERE status = 'Ongoing'`);
    this.conn = c;
    return c;
  }

  async sources() {
    return SOURCES;
  }

  async describe(table: string): Promise<Column[]> {
    const r = await (await this.c()).runAndReadAll(`DESCRIBE ${table}`);
    return r.getRowObjects().map(o => ({ name: String(o.column_name), type: String(o.column_type).toLowerCase() }));
  }

  async query(sql: string, ctx: { agent: string; purpose: string; trace: Trace }): Promise<Row[]> {
    const t0 = Date.now();
    const r = await (await this.c()).runAndReadAll(sql);
    const rows = r.getRowObjects().map(o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)])));
    const live = /fda_live_views\./.test(sql) ? " (live view served from snapshot)" : "";
    ctx.trace.emit("sql", ctx.agent, `${ctx.purpose}: ${rows.length} rows from local DuckDB${live} in ${Date.now() - t0}ms`, { backend: "duckdb", sql, rows: rows.length, sample: rows.slice(0, 3) });
    return rows;
  }

  async close() {
    this.conn?.closeSync();
  }
}
