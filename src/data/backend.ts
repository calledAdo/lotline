// One interface over Lotline's data layer. In live mode every query goes to Zetaris; in
// SAMPLE_MODE the same table names are served by DuckDB over the committed files. Rows
// come back as string-valued records in both, the way Zetaris's REST API returns them.
import type { Dialect } from "./dialect.ts";
import type { Trace } from "../trace.ts";

export type Row = Record<string, string | null>;
export type Column = { name: string; type: string };

export interface DataBackend {
  readonly name: "zetaris" | "duckdb";
  readonly dialect: Dialect;
  forAgent?(agent: string): DataBackend;
  /** The registered sources: table name -> description. */
  sources(): Promise<{ table: string; system: string; description: string }[]>;
  describe(table: string, ctx?: { agent: string; trace: Trace }): Promise<Column[]>;
  query(sql: string, ctx: { agent: string; purpose: string; trace: Trace }): Promise<Row[]>;
  close(): Promise<void>;
}

export const SOURCES: { table: string; system: string; description: string }[] = [
  { table: "hospital.locations", system: "Hospital pharmacy system (PostgreSQL)", description: "Stock locations: pharmacy, satellites, cabinets, crash carts" },
  { table: "hospital.item_master", system: "Hospital pharmacy system (PostgreSQL)", description: "Stocked products with the hospital's product code" },
  { table: "hospital.inventory_lots", system: "Hospital pharmacy system (PostgreSQL)", description: "On-hand quantity by item, location, lot and expiry" },
  { table: "hospital.dispensing_daily", system: "Hospital pharmacy system (PostgreSQL)", description: "Units dispensed per item, location and day" },
  { table: "hospital.purchase_orders", system: "Hospital pharmacy system (PostgreSQL)", description: "Open purchase orders" },
  { table: "fda_snapshot.recalls", system: "openFDA snapshot (object storage, JSON)", description: "FDA drug recall enforcement reports" },
  { table: "fda_snapshot.shortages", system: "openFDA snapshot (object storage, JSON)", description: "FDA drug shortage list" },
  { table: "fda_snapshot.ndc_packages", system: "openFDA snapshot (object storage, JSON)", description: "FDA NDC directory packages" },
  { table: "wholesaler.catalog", system: "Wholesaler catalog export (object storage, CSV)", description: "Orderable products and wholesaler availability" },
  { table: "fda_live_views.shortages", system: "openFDA live API (REST)", description: "Today's FDA shortage list for the molecules in scope" },
  { table: "fda_live_views.recalls", system: "openFDA live API (REST)", description: "Ongoing FDA recalls for the molecules in scope" },
  { table: "fda_updates.recall_updates", system: "Recall revisions feed (object storage, JSON)", description: "Revisions to ongoing recalls, including labelled drills" },
];
