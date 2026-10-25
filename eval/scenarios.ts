// The six anchor scenarios: real FDA recalls against the synthetic hospital. Expected lot
// verdicts come from data/eval/lot_answer_key.json, which is never shown to the agents.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/env.ts";

export const SCENARIOS = [
  { recall: "D-0727-2026", title: "Naropin 0.5% 20 mL, particulate (hair)", items: ["RX-ROPI-05-20", "RX-ROPI-02-100", "RX-ROPI-05-30", "RX-ROPI-05-20-SOM"] },
  { recall: "D-0850-2026", title: "Dextrose 70% 2000 mL, Class I, stainless steel particles", items: ["RX-DEX-70-2000"] },
  { recall: "D-0815-2026", title: "Clindamycin 900 mg/50 mL premix, CGMP", items: ["RX-CLIN-900-50"] },
  { recall: "D-0486-2026", title: "Furosemide 80 mg tablets, nitrosamine", items: ["RX-FURO-80-TAB"] },
  { recall: "D-0591-2025", title: "Sodium bicarbonate 8.4% syringe, sterility", items: ["RX-BICARB-84-50", "RX-BICARB-84-50-FK"] },
  { recall: "D-0036-2026", title: "Ketorolac 60 mg/2 mL vials, glass particulate", items: ["RX-KETO-60-2"] },
];

type Key = { lot_row_id: number; item_id: string; location_code: string; lot_number: string; note: string };
const key: Key[] = JSON.parse(readFileSync(path.join(ROOT, "data", "eval", "lot_answer_key.json"), "utf8"));

export function expectedFor(items: string[]): { lot_row_id: string; expected: "affected" | "not_affected" | "review"; note: string }[] {
  return key.filter(k => items.includes(k.item_id) && !k.note.startsWith("ALTERNATIVE")).map(k => ({
    lot_row_id: String(k.lot_row_id),
    expected: k.note.startsWith("AFFECTED") ? "affected" : k.note.startsWith("REVIEW") ? "review" : "not_affected",
    note: k.note,
  }));
}
