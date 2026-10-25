// Inject adversarial reviewer outcomes into the real offline pipeline. These checks
// protect the two-reader guard and the human handoff when revisions cannot converge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withHospital } from "./helpers.ts";
import { runCase, MAX_ROUNDS } from "../src/orchestrator.ts";
import type { CriticReview } from "../src/agents/critic.ts";
const emptyReview = (): CriticReview => ({ audits: [], coverageAdjudications: new Map(), substituteAdjudications: new Map(), objections: [], escalations: [], approved: true, modelUsed: true, summary: "test reviewer" });

for (const modelAgrees of [true, false]) test(`lot guard requires both readings: model agreement=${modelAgrees}`, async () => {
  await withHospital(async (ctx, crosswalk, items) => {
    let target = "";
    const result = await runCase(ctx, "D-0727-2026", items, crosswalk, { reviewer: async (_ctx, ex) => {
      const cov = ex.coverage.find(c => c.rule.decision === "not_covered")!;
      cov.model = modelAgrees ? { ...cov.rule } : null;
      const lot = ex.findings.find(f => f.item_id === cov.item_id)!;
      target = lot.lot.lot_row_id;
      const r = emptyReview();
      if (lot.verdict !== "review") r.objections.push({ target: lot.claimId, severity: "warn", action: "recheck", issue: "test objection on an uncovered presentation" });
      return r;
    } });
    assert.equal(result!.exposure.findings.find(f => f.lot.lot_row_id === target)!.verdict, modelAgrees ? "not_affected" : "review");
    assert.equal(ctx.trace.events.some(e => /overruled by evidence/.test(e.summary)), modelAgrees);
  });
});

test("revision exhaustion cannot approve pending changes and preserves them for a pharmacist", async () => {
  await withHospital(async (ctx, crosswalk, items) => {
    const result = await runCase(ctx, "D-0727-2026", items, crosswalk, { reviewer: async (_ctx, _ex, _supply, round) => {
      const r = emptyReview();
      r.coverageAdjudications.set("RX-ROPI-05-20", { decision: round % 2 ? "not_covered" : "covered", reason: "oscillating test reviewer" });
      return r;
    } });
    assert.equal(result!.rounds, MAX_ROUNDS);
    assert.equal(result!.critic.approved, false);
    assert.ok(result!.critic.escalations.some(e => e.to === "pharmacist" && /pending|budget/i.test(e.issue)));
    assert.ok(result!.revisions.some(r => r.round === MAX_ROUNDS && /pending/i.test(r.change)));
    assert.ok(result!.actions.some(a => /pending|budget/i.test(a.text)));
  });
});
