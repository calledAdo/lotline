// Shared shapes passed between agents. Every decision field has the claim id that backs it.
import type { LotConstraint } from "./recall-text.ts";

export type Recall = {
  recall_number: string; status: string; classification: string; recalling_firm: string;
  reason_for_recall: string; product_description: string; code_info: string | null;
  report_date: string; openfda_package_ndc: string | null; text_ndcs: string | null;
  /** set when this text came from a later update to the original recall */
  updated_from?: string;
};

export type Item = {
  item_id: string; ndc11: string; description: string; generic_name: string; strength: string;
  dosage_form: string; route: string; manufacturer: string; unit_of_issue: string; units_per_pack: number;
  /** NDCs of the inner units of this package, from the FDA NDC directory (carton -> vial/bag) */
  unitNdcs: string[]; packageDescription: string | null;
};

export type LotRow = { lot_row_id: string; item_id: string; location_code: string; lot_number: string; expiry_date: string; qty_units: number; po_number: string | null };

export type CoverageDecision = "covered" | "not_covered" | "uncertain";
export type Coverage = {
  item_id: string; decision: CoverageDecision; reason: string;
  method: "agreed" | "rule" | "model" | "critic";
  rule: { decision: CoverageDecision; reason: string };
  model: { decision: CoverageDecision; reason: string } | null;
  disputed: boolean; claimId: string;
};

export type LotVerdict = "affected" | "not_affected" | "review";
export type LotFinding = {
  lot: LotRow; item_id: string; verdict: LotVerdict; reason: string;
  expired: boolean; nearMiss: string | null; claimId: string;
};

export type Exposure = {
  recall: Recall; recallEvidence: string; constraints: LotConstraint[]; parseClaim: string;
  parseMethod: "model" | "fallback"; coverage: Coverage[]; findings: LotFinding[]; dataIssues: string[];
};
