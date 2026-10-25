// The orchestrator: runs one recall case through the agents with a bounded revision loop.
//   Exposure -> Supply -> Critic
//      ^____________________| (Critic adjudications or objections: re-investigate, max 3 rounds)
// Every agent reads and writes the same World Model, so a revision re-derives exactly the
// claims that changed, and the final packet cites claims, not prose.
import type { RunContext } from "./context.ts";
import { investigate, loadRecall } from "./agents/exposure.ts";
import { analyseSupply, type ItemSupply } from "./agents/supply.ts";
import { audit, review, type CriticReview } from "./agents/critic.ts";
import { decide, type Action, type ItemDecision } from "./decide.ts";
import type { CoverageDecision, Exposure, Item } from "./domain.ts";
import type { Crosswalk } from "./agents/cartographer.ts";

export const MAX_ROUNDS = 3;

export type CaseResult = {
  recallNumber: string; exposure: Exposure; supply: ItemSupply[]; critic: CriticReview;
  actions: Action[]; decisions: ItemDecision[]; rounds: number;
  revisions: { round: number; change: string }[];
};

export type RoundResult = { round: number; exposure: Exposure; supply: ItemSupply[]; critic: CriticReview };
export type CaseOptions = { critic?: boolean; onRound?: (result: RoundResult) => void; reviewer?: typeof review };
export async function runCase(ctx: RunContext, recallNumber: string, items: Item[], crosswalk: Crosswalk, opts: CaseOptions = {}): Promise<CaseResult | null> {
  const recall = await loadRecall(ctx, recallNumber);
  if (!recall) {
    for (const c of ctx.tm.claims().filter(c => c.key.split(":")[1] === recallNumber)) await ctx.tm.retractClaim(c.key, "recall source is missing; case cannot be verified", ctx.by("orchestrator"));
    ctx.trace.emit("invalidation", "orchestrator", `recall ${recallNumber} is missing; case claims withdrawn and pharmacist review required`);
    return null;
  }
  const coverageAdj = new Map<string, { decision: CoverageDecision; reason: string }>();
  const substituteAdj = new Map<string, { ndc11: string | null; reason: string }>();
  const lotOverrides = new Map<string, string>();
  const revisions: CaseResult["revisions"] = [];
  let round = 1;
  for (;;) {
    ctx.trace.emit("message", "orchestrator", `${recallNumber}: round ${round}`);
    const exposure = await investigate(ctx, recall, items, coverageAdj, lotOverrides);
    const supply = await analyseSupply(ctx, exposure, items, crosswalk, substituteAdj);
    const codeAudit = opts.critic === false ? audit(ctx, exposure, supply) : null;
    const critic: CriticReview = codeAudit
      ? { audits: codeAudit.findings, coverageAdjudications: new Map(), substituteAdjudications: new Map(), objections: [], escalations: codeAudit.escalations, approved: false, modelUsed: false, summary: "Senior model review disabled; deterministic audits only. Pharmacist review required." }
      : await (opts.reviewer ?? review)(ctx, exposure, supply, round);

    const changes: string[] = [];
    for (const [item, a] of critic.coverageAdjudications) {
      if (coverageAdj.get(item)?.decision !== a.decision) { coverageAdj.set(item, a); changes.push(`coverage of ${item} -> ${a.decision}`); }
    }
    for (const [item, a] of critic.substituteAdjudications) {
      if (substituteAdj.get(item)?.ndc11 !== a.ndc11 || !substituteAdj.has(item)) { substituteAdj.set(item, a); changes.push(`order for ${item} -> ${a.ndc11 ?? "none"}`); }
    }
    for (const o of critic.objections.filter(o => o.action === "recheck" || o.action === "retract")) {
      const lot = exposure.findings.find(f => f.claimId === o.target);
      if (!lot || lot.verdict === "review" || lotOverrides.has(lot.lot.lot_row_id)) continue;
      // Checks run both ways: the Critic may not flip a lot of a product that both coverage
      // readings agree the recall does not cover. To change that it must dispute coverage.
      const cov = exposure.coverage.find(c => c.item_id === lot.item_id);
      const coverageNow = coverageAdj.get(lot.item_id)?.decision ?? cov?.decision;
      if (coverageNow === "not_covered" && cov?.rule.decision === "not_covered" && cov.model?.decision === "not_covered" && !cov.disputed) {
        ctx.trace.emit("critique", "orchestrator", `critic objection on ${lot.lot.location_code} lot ${lot.lot.lot_number} overruled by evidence: both readings agree the recall does not cover ${lot.item_id} (${cov.reason}); the Critic did not dispute coverage`, { objection: o });
        continue;
      }
      lotOverrides.set(lot.lot.lot_row_id, o.issue); changes.push(`lot ${lot.lot.lot_number} at ${lot.lot.location_code} -> review`);
    }
    opts.onRound?.({ round, exposure, supply, critic });
    if (changes.length && round < MAX_ROUNDS) {
      for (const c of changes) revisions.push({ round, change: c });
      ctx.trace.emit("revision", "orchestrator", `critic changed ${changes.length} decision(s): ${changes.join("; ")}; re-investigating`);
      round++;
      continue;
    }
    if (changes.length) {
      const issue = `Revision budget (${MAX_ROUNDS} rounds) used up with changes still pending: ${changes.join("; ")}. A pharmacist must resolve these before release.`;
      for (const change of changes) revisions.push({ round, change: `pending: ${change}` });
      critic.approved = false;
      critic.escalations.push({ to: "pharmacist", urgency: "today", issue, source: "rule" });
      critic.summary = `${critic.summary} ${issue}`.trim();
      ctx.trace.emit("escalation", "orchestrator", issue);
    }
    const { actions, decisions } = decide(exposure, supply, critic);
    for (const d of decisions) ctx.trace.emit("decision", "orchestrator", `${d.description}: ${d.decision} (${d.why})`);
    return { recallNumber, exposure, supply, critic, actions, decisions, rounds: round, revisions };
  }
}
