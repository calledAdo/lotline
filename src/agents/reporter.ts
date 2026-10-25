// Reporter: writes the buyer's packet. The structure is assembled from claims; the short
// summary selects verbatim fact sentences with the fast lane. Numeric membership alone
// cannot stop a model attributing an alternative NDC to the recalled product.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { chatJson, LlmUnavailable, type Receipt } from "../llm.ts";
import type { RunContext } from "../context.ts";
import { format11 } from "../ndc.ts";
import type { CaseResult } from "../orchestrator.ts";
import { writePacketHtml } from "../render.ts";

const AGENT = "reporter";

export type Packet = {
  schema: "lotline.packet.v1";
  runId: string; generatedAt: string; today: string; backend: string;
  recall: CaseResult["exposure"]["recall"];
  headline: string; summary: string; summaryBy: "model" | "template";
  approved: boolean; criticSummary: string; rounds: number; revisions: CaseResult["revisions"];
  decisions: CaseResult["decisions"]; actions: CaseResult["actions"];
  lots: { location: string; item_id: string; lot: string; expiry: string; qty: number; verdict: string; reason: string; expired: boolean; claim: string }[];
  coverage: { item_id: string; decision: string; method: string; reason: string; claim: string }[];
  supply: { item_id: string; description: string; onHand: number; quarantined: number; expiredRecalled?: number; usable: number; avgDaily: number; daysBefore: number | null; daysAfter: number | null; shortage: string | null; useNow: string | null; useNowCautions?: string[]; order: string | null; orderReason: string; orderCautions?: string[]; alternatives: { ndc: string; labeler: string; status: string; flags: string[]; wholesaler: string | null; fda: string | null; onHand: number }[]; claim: string }[];
  escalations: CaseResult["critic"]["escalations"];
  audits: CaseResult["critic"]["audits"];
  dataIssues: string[];
  models: { agent: string; purpose: string; model: string | null; receipt: string | null; latencyMs: number | null; replayed: boolean }[];
  disclaimer: string;
};

const DISCLAIMER = "Supply-chain decision support for pharmacy operations. Not clinical advice: substitutions need pharmacist review. Recall and shortage data are from openFDA, which is unvalidated; confirm against the FDA notice and the manufacturer.";

export function selectSummary(value: unknown, sentences: string[]): string {
  const indices = (value as { sentences?: unknown } | null)?.sentences;
  if (!Array.isArray(indices) || indices.length < 2 || indices.length > 4 || indices[0] !== 0 || new Set(indices).size !== indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= sentences.length)) throw new Error("expected 2–4 unique sentence indices, starting with sentence 0");
  return indices.map(i => sentences[i]).join(" ");
}

export async function report(ctx: RunContext, c: CaseResult): Promise<Packet> {
  ctx.trace.emit("agent-start", AGENT, `writing the ${c.recallNumber} packet`);
  const ex = c.exposure;
  const affected = ex.findings.filter(f => f.verdict === "affected"), review = ex.findings.filter(f => f.verdict === "review");
  const quarantineUnits = [...affected, ...review].reduce((s, f) => s + f.lot.qty_units, 0);
  const headline = `${ex.recall.recall_number} (${ex.recall.classification}, ${ex.recall.recalling_firm}): ${affected.length} affected lot${affected.length === 1 ? "" : "s"}, ${review.length} to check, ${quarantineUnits} units to quarantine across ${new Set([...affected, ...review].map(f => f.lot.location_code)).size} location(s).`;
  const sentences = [
    headline,
    ...c.decisions.map(d => `${d.description}: ${d.decision} (${d.why}).`),
    ...c.actions.slice(0, 6).map(a => `[${a.priority}] ${a.text}`),
    ...c.critic.escalations.map(e => `${e.to} (${e.urgency}): ${e.issue}`),
  ];
  if (sentences.length === 1) sentences.push("No stocked lots require quarantine for this recall.");
  let summary = "", summaryBy: Packet["summaryBy"] = "template";
  try {
    const { value } = await chatJson({
      lane: "fast", reasoning: false, agent: AGENT, purpose: `summarise the ${c.recallNumber} packet`, trace: ctx.trace, runDir: ctx.runDir,
      system: 'Select 2–4 sentences for a hospital pharmacy buyer briefing. Sentence 0 must be first; prioritize supply impact and immediate actions. Return ONLY JSON: {"sentences":[0, ...]}, using unique indices from the supplied sentences. Do not write or alter prose.',
      user: JSON.stringify({ sentences }),
      validate: v => selectSummary(v, sentences),
    });
    summary = value; summaryBy = "model";
  } catch (err) {
    if (!(err instanceof LlmUnavailable)) throw err;
    ctx.trace.emit("fallback", AGENT, `summary model unavailable or unreliable (${err.message}); using the template`);
    summary = sentences.slice(0, 4).join(" ");
  }

  const receipts = ctx.trace.events.filter(e => e.type === "llm").map(e => {
    const r = e.data?.receipt as Receipt | undefined;
    return { agent: e.agent, purpose: String(e.data?.purpose ?? ""), model: r?.routedModel ?? null, receipt: r?.receiptId ?? null, latencyMs: r?.latencyMs ?? null, replayed: !!r?.replayed };
  });

  const packet: Packet = {
    schema: "lotline.packet.v1", runId: ctx.runId, generatedAt: new Date().toISOString(), today: ctx.today, backend: ctx.backend.name,
    recall: ex.recall, headline, summary, summaryBy,
    approved: c.critic.approved, criticSummary: c.critic.summary, rounds: c.rounds, revisions: c.revisions,
    decisions: c.decisions, actions: c.actions,
    lots: ex.findings.map(f => ({ location: f.lot.location_code, item_id: f.item_id, lot: f.lot.lot_number, expiry: f.lot.expiry_date, qty: f.lot.qty_units, verdict: f.verdict, reason: f.reason, expired: f.expired, claim: f.claimId })),
    coverage: ex.coverage.map(cv => ({ item_id: cv.item_id, decision: cv.decision, method: cv.method, reason: cv.reason, claim: cv.claimId })),
    supply: c.supply.map(s => ({
      item_id: s.item_id, description: s.description, onHand: s.onHand, quarantined: s.quarantined, usable: s.usable, avgDaily: s.avgDaily, daysBefore: s.daysBefore, daysAfter: s.daysAfter,
      expiredRecalled: s.expiredRecalled, useNowCautions: s.useNow?.flags ?? [], orderCautions: s.alternatives.find(a => a.ndc11 === s.recommendation.ndc11)?.flags ?? [],
      shortage: s.ownShortage ? `${s.ownShortage.availability} (${s.ownShortage.liveCheck})` : null,
      useNow: s.useNow ? `${s.useNow.units} units of ${format11(s.useNow.ndc11)} (${s.useNow.labeler})` : null,
      order: s.recommendation.ndc11 ? format11(s.recommendation.ndc11) : null, orderReason: s.recommendation.reason,
      alternatives: s.alternatives.map(a => ({ ndc: format11(a.ndc11), labeler: a.labeler, status: a.status, flags: a.flags, wholesaler: a.catalog?.status ?? null, fda: a.fdaShortage, onHand: a.onHandUnits })),
      claim: s.claimId,
    })),
    escalations: c.critic.escalations, audits: c.critic.audits, dataIssues: ex.dataIssues, models: receipts, disclaimer: DISCLAIMER,
  };
  if (ctx.runDir) {
    writeFileSync(path.join(ctx.runDir, `packet-${c.recallNumber}.json`), JSON.stringify(packet, null, 2) + "\n");
    const csv = ["location,item_id,lot,expiry,qty,verdict,reason", ...packet.lots.filter(l => l.verdict !== "not_affected").map(l => [l.location, l.item_id, l.lot, l.expiry, l.qty, l.verdict, `"${l.reason.replaceAll('"', '""')}"`].join(","))].join("\n") + "\n";
    writeFileSync(path.join(ctx.runDir, `quarantine-${c.recallNumber}.csv`), csv);
  }
  ctx.trace.emit("agent-end", AGENT, headline);
  if (ctx.runDir) writePacketHtml(ctx.runDir, packet, ctx.trace.events);
  return packet;
}
