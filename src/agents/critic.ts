// Critic: challenges the case before anything reaches the buyer. Rule auditors run first
// (exact, cheap, always available); then the deep lane (Nemotron Ultra) reviews the whole
// case with those findings and may adjudicate disputes between code and model, object to
// specific claims, and escalate to people. Every target it names is validated against the
// claims that exist, so it cannot invent work or approve something that is not there.
import { chatJson, LlmUnavailable } from "../llm.ts";
import type { RunContext } from "../context.ts";
import { format11, normalize } from "../ndc.ts";
import { lotInText } from "../recall-text.ts";
import type { CoverageDecision, Exposure } from "../domain.ts";
import { isOrderable, type ItemSupply } from "./supply.ts";

const AGENT = "critic";

export type AuditFinding = { rule: string; severity: "block" | "warn" | "info"; target: string; message: string };
export type Objection = { target: string; severity: "block" | "warn"; issue: string; action: "recheck" | "retract" | "escalate" | "note" };
export type Escalation = { to: "pharmacist" | "P&T committee" | "risk management" | "wholesaler"; urgency: "now" | "today" | "this week"; issue: string; source: "rule" | "model" };
export type CriticReview = {
  audits: AuditFinding[];
  coverageAdjudications: Map<string, { decision: CoverageDecision; reason: string }>;
  substituteAdjudications: Map<string, { ndc11: string | null; reason: string }>;
  objections: Objection[];
  escalations: Escalation[];
  approved: boolean;
  modelUsed: boolean;
  summary: string;
};

/** Exact checks that do not need a model. */
export function audit(ctx: RunContext, ex: Exposure, supply: ItemSupply[]): { findings: AuditFinding[]; escalations: Escalation[] } {
  const findings: AuditFinding[] = [];
  const escalations: Escalation[] = [];
  const r = ex.recall;
  for (const c of ex.coverage.filter(c => c.disputed)) findings.push({ rule: "coverage-dispute", severity: "block", target: c.item_id, message: c.reason });
  for (const s of supply.filter(s => s.recommendation.disputed)) findings.push({ rule: "substitute-dispute", severity: "block", target: s.item_id, message: s.recommendation.reason });
  for (const f of ex.findings) {
    if (f.verdict === "affected" && !lotInText(f.lot.lot_number, r.code_info)) findings.push({ rule: "lot-not-in-text", severity: "block", target: `lot:${r.recall_number}:${f.lot.lot_row_id}`, message: `lot ${f.lot.lot_number} is marked affected but does not appear in the recall text` });
    if (f.expired && f.verdict !== "not_affected") {
      findings.push({ rule: "expired-recalled-stock", severity: "warn", target: `lot:${r.recall_number}:${f.lot.lot_row_id}`, message: `lot ${f.lot.lot_number} at ${f.lot.location_code} is recalled and expired on ${f.lot.expiry_date}, yet still counted on hand` });
      escalations.push({ to: "pharmacist", urgency: "today", issue: `Expired recalled stock found on the shelf (${f.lot.location_code}, lot ${f.lot.lot_number}): remove, document, and check the expiry-date sweep.`, source: "rule" });
    }
    if (f.verdict === "review") findings.push({ rule: "physical-check", severity: "warn", target: `lot:${r.recall_number}:${f.lot.lot_row_id}`, message: `${f.lot.location_code} lot ${f.lot.lot_number}: ${f.reason}` });
    if (f.verdict !== "not_affected" && /CART/.test(f.lot.location_code)) escalations.push({ to: "pharmacist", urgency: "now", issue: `Recalled ${f.item_id} is in ${f.lot.location_code} (lot ${f.lot.lot_number}, ${f.lot.qty_units} units): crash carts must be restocked before the recalled units are pulled.`, source: "rule" });
  }
  for (const issue of ex.dataIssues) findings.push({ rule: "fda-text-inconsistent", severity: "warn", target: r.recall_number, message: `${issue}. Confirm the recalled presentation with the manufacturer before relying on strength.` });
  if (r.classification === "Class I") escalations.push({ to: "risk management", urgency: "now", issue: `${r.recall_number} is Class I (reasonable probability of serious harm): notify risk management and check whether any recalled units were administered.`, source: "rule" });
  for (const s of supply) {
    const chosen = s.alternatives.find(a => a.ndc11 === s.recommendation.ndc11);
    if (chosen?.flags.length) findings.push({ rule: "substitute-caution", severity: "warn", target: s.item_id, message: `order recommendation ${format11(chosen.ndc11)} has cautions: ${chosen.flags.join("; ")}` });
    if (chosen?.flags.some(f => f.startsWith("sources disagree"))) escalations.push({ to: "wholesaler", urgency: "today", issue: `Confirm availability of ${format11(chosen.ndc11)} (${chosen.labeler}); FDA and the wholesaler disagree.`, source: "rule" });
    if ((s.daysAfter ?? Infinity) < 7 && !s.recommendation.ndc11 && !s.useNow) escalations.push({ to: "P&T committee", urgency: "today", issue: `${s.description}: ${s.daysAfter} days of supply after quarantine and no orderable alternative.`, source: "rule" });
    for (const po of s.openPOs) findings.push({ rule: "inbound-recalled-product", severity: "warn", target: s.item_id, message: `${po.po_number} (${po.packs} packs, expected ${po.expected_on}) is for the recalled product: inspect lots on receipt` });
  }
  for (const a of findings) ctx.trace.emit("critique", AGENT, `[rule ${a.rule}] ${a.message}`, { audit: a });
  return { findings, escalations };
}

export async function review(ctx: RunContext, ex: Exposure, supply: ItemSupply[], round: number): Promise<CriticReview> {
  ctx.trace.emit("agent-start", AGENT, `reviewing ${ex.recall.recall_number} (round ${round})`);
  const { findings, escalations } = audit(ctx, ex, supply);
  const coverageAdjudications = new Map<string, { decision: CoverageDecision; reason: string }>();
  const substituteAdjudications = new Map<string, { ndc11: string | null; reason: string }>();
  const objections: Objection[] = [];
  const claimKeys = new Set([...ex.coverage.map(c => c.claimId), ...ex.findings.map(f => f.claimId), ex.parseClaim, ...supply.map(s => s.claimId)].map(id => id.replace(/^claim:lotline:/, "")));
  let modelUsed = false;
  let summary = "";
  let approved = !findings.some(f => f.severity === "block");

  try {
    const { value } = await chatJson({
      lane: "deep", reasoning: true, agent: AGENT, purpose: `review the ${ex.recall.recall_number} case (round ${round})`, trace: ctx.trace, runDir: ctx.runDir,
      maxTokens: 8000,
      system: [
        "You are the senior pharmacist reviewing a recall response prepared by other agents before it reaches the buyer. Be concrete and skeptical.",
        "1. For every coverage dispute, decide covered, not_covered or uncertain for that item. A recall covers only the presentation it describes; combination or compounded products are different products.",
        "A recalled lot number found on a product the recall does not cover is NOT affected: manufacturers reuse lot strings across strengths and sizes. If you think such a product is covered, dispute its coverage in step 1 with your reason; do not object to its lot.",
        "2. For every substitute dispute, choose the NDC to order (from that item's alternatives) or null.",
        "3. Object to any claim that is unsupported or unsafe, naming its claim key exactly. Actions: recheck, retract, escalate, note.",
        "4. List escalations to people (pharmacist, P&T committee, risk management, wholesaler) with urgency now, today or this week. Do not repeat escalations already listed.",
        'Reply with only JSON: {"coverage":[{"item_id":string,"decision":string,"reason":string}],"substitutes":[{"item_id":string,"ndc":string|null,"reason":string}],"objections":[{"claim":string,"severity":"block"|"warn","issue":string,"action":string}],"escalations":[{"to":string,"urgency":string,"issue":string}],"approve":boolean,"summary":string}',
      ].join("\n"),
      user: JSON.stringify({
        recall: { number: ex.recall.recall_number, class: ex.recall.classification, firm: ex.recall.recalling_firm, reason: ex.recall.reason_for_recall, product: ex.recall.product_description, code_info: ex.recall.code_info },
        lot_reading: ex.constraints.map(c => c.lot),
        coverage: ex.coverage.map(c => ({ claim: c.claimId.replace(/^claim:lotline:/, ""), item_id: c.item_id, decision: c.decision, disputed: c.disputed, code_reading: c.rule, model_reading: c.model })),
        products: ex.coverage.map(c => c.item_id),
        lots: ex.findings.map(f => {
          const cov = ex.coverage.find(c => c.item_id === f.item_id);
          return { claim: f.claimId.replace(/^claim:lotline:/, ""), item_id: f.item_id, product_covered_by_recall: cov?.decision ?? "not a candidate", location: f.lot.location_code, lot: f.lot.lot_number, expiry: f.lot.expiry_date, qty: f.lot.qty_units, verdict: f.verdict, reason: f.reason, expired: f.expired };
        }),
        supply: supply.map(s => ({ claim: s.claimId.replace(/^claim:lotline:/, ""), item_id: s.item_id, item: s.description, days_before: s.daysBefore, days_after: s.daysAfter, use_now: s.useNow, order: s.recommendation, alternatives: s.alternatives.slice(0, 8).map(a => ({ ndc: format11(a.ndc11), labeler: a.labeler, container: a.container, volume_ml: a.volumeMl, status: a.status, flags: a.flags, wholesaler: a.catalog?.status ?? null })) })),
        rule_findings: findings.map(f => `${f.rule}: ${f.message}`),
        escalations_already_listed: escalations.map(e => e.issue),
        data_issues: ex.dataIssues,
      }),
      validate: (v: unknown) => {
        const o = v as Record<string, any>;
        const cov = (o.coverage ?? []) as Record<string, unknown>[];
        for (const c of cov) {
          if (!ex.coverage.some(x => x.item_id === c.item_id)) throw new Error(`coverage item ${c.item_id} is not in the case`);
          if (!["covered", "not_covered", "uncertain"].includes(String(c.decision))) throw new Error(`coverage decision ${c.decision} is invalid`);
        }
        for (const s of (o.substitutes ?? []) as Record<string, unknown>[]) {
          const item = supply.find(x => x.item_id === s.item_id);
          if (!item) throw new Error(`substitute item ${s.item_id} is not in the case`);
          if (s.ndc !== null && s.ndc !== undefined && !item.alternatives.some(a => a.ndc11 === normalize(String(s.ndc)) && isOrderable(a))) throw new Error(`substitute ${s.ndc} is not an allowed orderable alternative for ${s.item_id}`);
        }
        for (const ob of (o.objections ?? []) as Record<string, unknown>[]) {
          if (!claimKeys.has(String(ob.claim))) throw new Error(`objection names unknown claim ${ob.claim}`);
          if (!["recheck", "retract", "escalate", "note"].includes(String(ob.action))) throw new Error(`objection action ${ob.action} is invalid`);
        }
        for (const e of (o.escalations ?? []) as Record<string, unknown>[]) {
          if (!["pharmacist", "P&T committee", "risk management", "wholesaler"].includes(String(e.to))) throw new Error(`escalation target ${e.to} is invalid`);
          if (!["now", "today", "this week"].includes(String(e.urgency))) throw new Error(`escalation urgency ${e.urgency} is invalid`);
        }
        return o;
      },
    });
    modelUsed = true;
    for (const c of value.coverage ?? []) {
      const current = ex.coverage.find(x => x.item_id === c.item_id)!;
      if (current.disputed || current.decision !== c.decision) coverageAdjudications.set(String(c.item_id), { decision: c.decision as CoverageDecision, reason: `critic: ${String(c.reason).slice(0, 300)}` });
    }
    for (const s of value.substitutes ?? []) {
      const current = supply.find(x => x.item_id === s.item_id)!;
      const ndc = s.ndc === null || s.ndc === undefined ? null : normalize(String(s.ndc));
      if (current.recommendation.disputed || current.recommendation.ndc11 !== ndc) substituteAdjudications.set(String(s.item_id), { ndc11: ndc, reason: `critic: ${String(s.reason).slice(0, 300)}` });
    }
    for (const ob of value.objections ?? []) objections.push({ target: `claim:lotline:${ob.claim}`, severity: ob.severity === "block" ? "block" : "warn", issue: String(ob.issue).slice(0, 400), action: ob.action });
    for (const e of value.escalations ?? []) escalations.push({ to: e.to, urgency: e.urgency, issue: String(e.issue).slice(0, 400), source: "model" });
    summary = String(value.summary ?? "").slice(0, 800);
    // Model approval cannot waive a blocking code audit. Adjudications must first
    // survive the next investigation round and clear the underlying finding.
    approved = value.approve === true && !findings.some(f => f.severity === "block") && !objections.some(o => o.severity === "block");
    for (const [item, a] of coverageAdjudications) ctx.trace.emit("decision", AGENT, `coverage of ${item} -> ${a.decision}: ${a.reason}`);
    for (const [item, a] of substituteAdjudications) ctx.trace.emit("decision", AGENT, `order for ${item} -> ${a.ndc11 ? format11(a.ndc11) : "none"}: ${a.reason}`);
    for (const ob of objections) ctx.trace.emit("critique", AGENT, `[${ob.severity}] ${ob.target.replace("claim:lotline:", "")}: ${ob.issue} (${ob.action})`);
  } catch (err) {
    if (!(err instanceof LlmUnavailable)) throw err;
    ctx.trace.emit("fallback", AGENT, `deep review unavailable (${err.message}); disputes resolve to the code reading, and the case is flagged for pharmacist review`);
    for (const c of ex.coverage.filter(c => c.disputed)) coverageAdjudications.set(c.item_id, { decision: c.rule.decision === "covered" ? "covered" : "uncertain", reason: `no deep review available; keeping the conservative reading (${c.rule.reason})` });
    escalations.push({ to: "pharmacist", urgency: "today", issue: "The automated senior review was unavailable for this case; a pharmacist must review the packet before release.", source: "rule" });
    approved = false;
  }
  for (const e of escalations) ctx.trace.emit("escalation", AGENT, `${e.to} (${e.urgency}): ${e.issue}`, { escalation: e });
  ctx.trace.emit("agent-end", AGENT, `${approved ? "approved" : "not approved"}: ${coverageAdjudications.size + substituteAdjudications.size} adjudications, ${objections.length} objections, ${escalations.length} escalations`);
  return { audits: findings, coverageAdjudications, substituteAdjudications, objections, escalations, approved, modelUsed, summary };
}
