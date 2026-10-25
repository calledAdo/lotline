// Action policy is safety-critical: urgency, available substitutes and escalation
// deduplication must refer to the correct stock and location.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { decide } from "../src/decide.ts";
import type { CaseResult } from "../src/orchestrator.ts";
let original: CaseResult;
before(async () => { original = (await fixture()).result; });
const copy = () => { const c = structuredClone(original); c.critic.escalations = []; return c; };

test("affected lots are quarantined, expiry mismatches checked, and Class I acts now", () => {
  const c = copy(); c.exposure.recall.classification = "Class I";
  const { actions, decisions } = decide(c.exposure, c.supply, c.critic);
  assert.equal(actions.filter(a => a.kind === "quarantine").length, 2);
  assert.ok(actions.filter(a => a.kind === "quarantine").every(a => a.priority === "now"));
  assert.equal(actions.filter(a => a.kind === "check-label").length, 1);
  assert.ok(actions.filter(a => a.kind === "quarantine" || a.kind === "check-label").every(a => a.claims.length));
  assert.equal(decisions[0].decision, "substitute");
});
test("supply policy distinguishes monitor, no action and escalation", () => {
  const c = copy(), s = c.supply[0];
  s.daysAfter = 14;
  assert.equal(decide(c.exposure, c.supply, c.critic).decisions[0].decision, "monitor");
  s.daysAfter = 2; s.quarantined = 0; s.expiredRecalled = 0;
  assert.equal(decide(c.exposure, c.supply, c.critic).decisions[0].decision, "no action");
  s.quarantined = 68; s.useNow = null; s.recommendation.ndc11 = null;
  assert.equal(decide(c.exposure, c.supply, c.critic).decisions[0].decision, "escalate");
});
test("an excluded or unavailable alternative never becomes an order action", () => {
  for (const invalid of ["excluded", "backorder"]) {
    const c = copy(), s = c.supply[0], chosen = s.alternatives.find(a => a.ndc11 === s.recommendation.ndc11)!;
    if (invalid === "excluded") chosen.status = "excluded"; else chosen.catalog = { status: "Backorder", eta: null };
    assert.equal(decide(c.exposure, c.supply, c.critic).actions.some(a => a.kind === "order"), false);
  }
});
test("escalation dedupe preserves distinct locations and urgent exact duplicates", () => {
  const c = copy();
  c.critic.escalations = [
    { to: "pharmacist", urgency: "now", issue: "ICU lot 6133436 (RX-ROPI-05-20) has expiry 2027-10 vs recall expiry 2028-10; need physical label verification and quarantine.", source: "model" },
    { to: "pharmacist", urgency: "today", issue: "Inspect incoming stock.", source: "rule" },
    { to: "pharmacist", urgency: "now", issue: "Inspect incoming stock.", source: "rule" },
  ];
  const { actions } = decide(c.exposure, c.supply, c.critic);
  assert.equal(actions.find(a => a.kind === "quarantine" && a.text.includes(" at LD"))?.priority, "today");
  const duplicates = actions.filter(a => a.text === "Inspect incoming stock.");
  assert.equal(duplicates.length, 1); assert.equal(duplicates[0].priority, "now");
  assert.ok(actions.some(a => a.text.includes("ICU") && a.priority === "now"));
});
