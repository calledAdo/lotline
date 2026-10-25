// Labels are used only by the evaluator, never by an agent or a registered datasource.
// Traps are real snapshot recalls of different products, not edited adversarial prompts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/env.ts";
import { SCENARIOS, expectedFor } from "./scenarios.ts";
import type { LotVerdict } from "../src/domain.ts";

export type AblationScenario = { recall: string; title: string; kind: "anchor" | "trap"; coveredItems: string[]; expected: { lot_row_id: string; verdict: LotVerdict; note: string }[] };
export const EVAL_LOTS = readFileSync(path.join(ROOT, "data/sources/hospital_inventory_lots.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l) as { lot_row_id: number; item_id: string; qty_units: number; lot_number: string; location_code: string });
const traps = [
  { recall: "D-0113-2026", title: "QuVa R.E.C.K. combination periarticular syringe, not stocked ropivacaine or ketorolac" },
  { recall: "D-0178-2026", title: "Park Avenue compounded fentanyl/ropivacaine bag, not stocked Naropin" },
  { recall: "D-0221-2026", title: "Fagron four-ingredient topical ophthalmic syringe, not injectable ketorolac" },
  { recall: "D-0305-2025", title: "Imprimis compounded ophthalmic combination bottle, not injectable ketorolac" },
];
const snapshot = new Set(readFileSync(path.join(ROOT, "data/snapshot/fda_recalls.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l).recall_number));
for (const t of traps) if (!snapshot.has(t.recall)) throw new Error(`Trap ${t.recall} is missing from the real snapshot`);

export const ABLATION_SCENARIOS: AblationScenario[] = [
  ...SCENARIOS.map(s => {
    const key = new Map(expectedFor(s.items).map(e => [e.lot_row_id, e]));
    return { recall: s.recall, title: s.title, kind: "anchor" as const, coveredItems: [s.items[0]], expected: EVAL_LOTS.map(l => ({ lot_row_id: String(l.lot_row_id), verdict: key.get(String(l.lot_row_id))?.expected ?? "not_affected", note: key.get(String(l.lot_row_id))?.note ?? "Not covered by this anchor recall" })) };
  }),
  ...traps.map(t => ({ ...t, kind: "trap" as const, coveredItems: [], expected: EVAL_LOTS.map(l => ({ lot_row_id: String(l.lot_row_id), verdict: "not_affected" as const, note: "Different product; no stocked lot should be quarantined" })) })),
];
