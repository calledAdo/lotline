// SQL engines differ in field order, row order and numeric representation. Normalize
// at the agent boundary so evidence hashes and model prompts survive backend changes.
// Identifiers (especially NDCs and lot strings) must retain every leading zero.
import { canonicalJson } from "../../engines/world-model/src/stableIds.ts";
import type { Row } from "./backend.ts";

const NUMERIC = new Set(["n", "qty", "qty_units", "units", "units_per_pack", "packs", "ingredient_count", "lot_row_id", "update_seq"]);
export function stableRows(rows: Record<string, unknown>[]): Row[] {
  return rows.map(row => Object.fromEntries(Object.keys(row).sort().map(key => {
    const raw = row[key];
    const value = raw === null || raw === undefined ? null : String(raw);
    return [key, value !== null && NUMERIC.has(key) && /^-?\d+(?:\.0+)?$/.test(value) ? String(Number(value)) : value];
  }))).sort((a, b) => {
    const x = canonicalJson(a), y = canonicalJson(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
