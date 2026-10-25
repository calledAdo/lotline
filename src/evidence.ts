// Source projections are shared by producers and watcher. Query-set evidence also
// represents an empty result: insertions and removals can change a conclusion.
import { stableRows } from "./data/rows.ts";
import { rowHash } from "../engines/world-model/src/claims.ts";
import { evidence, type RunContext } from "./context.ts";
import type { Row } from "./data/backend.ts";

const pick = (row: Record<string, unknown>, fields: string[]) => Object.fromEntries(fields.map(k => [k, row[k] == null ? null : String(row[k])]));
export const itemEvidenceRow = (r: Record<string, unknown>) => pick(r, ["item_id", "ndc11", "description", "generic_name", "strength", "dosage_form", "route", "manufacturer", "unit_of_issue", "units_per_pack"]);
export const lotEvidenceRow = (r: Record<string, unknown>) => pick(r, ["lot_row_id", "item_id", "location_code", "lot_number", "expiry_date", "qty_units", "po_number"]);
export const shortageEvidenceRow = (r: Record<string, unknown>) => pick(r, ["package_ndc", "availability", "status", "shortage_reason", "related_info", "update_date"]);
export const liveShortageEvidenceRow = shortageEvidenceRow;
export const catalogEvidenceRow = (r: Record<string, unknown>) => pick(r, ["ndc_numeric", "status", "eta"]);
export const directoryEvidenceRow = (r: Record<string, unknown>) => pick(r, ["package_ndc", "molecule_query", "labeler_name", "brand_name", "active_ingredients", "ingredient_count", "dosage_form", "route", "package_description", "listing_expiration_date"]);
export const purchaseOrderEvidenceRow = (r: Record<string, unknown>) => pick(r, ["po_number", "item_id", "packs", "expected_on", "status"]);
export const usageEvidenceRow = (r: Record<string, unknown>) => ({ units30: String(Number(r.units ?? r.units30 ?? 0)) });
export const probeEvidenceRow = (r: Record<string, unknown>) => ({ matched: Number(r.matched), total: Number(r.total) });
export const recallScreenEvidenceRow = (r: Record<string, unknown>) => pick(r, ["recall_number", "product_description", "code_info", "recalling_firm"]);
export const projections: Record<string, (r: Record<string, unknown>) => Record<string, unknown>> = {
  "hospital.item_master": itemEvidenceRow, "hospital.inventory_lots": lotEvidenceRow,
  "hospital.dispensing_daily": usageEvidenceRow, "hospital.purchase_orders": purchaseOrderEvidenceRow,
  "fda_snapshot.shortages": shortageEvidenceRow, "fda_live_views.shortages": liveShortageEvidenceRow,
  "wholesaler.catalog": catalogEvidenceRow, "fda_snapshot.ndc_packages": directoryEvidenceRow,
  "fda_snapshot.recalls": recallScreenEvidenceRow,
};
export function queryEvidenceRow(table: string, sql: string, rows: Row[]) {
  const project = projections[table];
  if (!project) throw new Error(`No evidence projection for ${table}`);
  return { sql, rows: stableRows(rows.map(project)) };
}
export async function queryEvidence(ctx: RunContext, agent: string, table: string, sql: string, rows: Row[]): Promise<string> {
  return evidence(ctx, agent, table, `query:${rowHash({ sql })}`, queryEvidenceRow(table, sql, rows));
}
