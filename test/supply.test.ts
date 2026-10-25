// Exercise the real FDA snapshot and synthetic catalog through DuckDB. Clinical
// compatibility and purchasing availability are separate checks, including adjudications.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withHospital } from "./helpers.ts";
import { investigate, loadRecall } from "../src/agents/exposure.ts";
import { analyseSupply } from "../src/agents/supply.ts";
import { review } from "../src/agents/critic.ts";
import { withModelRuntime, type ChatRequest } from "../src/llm.ts";
import { requestKey } from "../src/cassette.ts";

test("snapshot screening excludes recalled firms and wrong strengths; retains container cautions", async () => {
  await withHospital(async (ctx, crosswalk, items) => {
    const ex = await investigate(ctx, (await loadRecall(ctx, "D-0815-2026"))!, items);
    const [s] = await analyseSupply(ctx, ex, items, crosswalk);
    const baxter = s.alternatives.find(a => a.ndc11 === "43066099524")!;
    assert.equal(baxter.status, "excluded");
    assert.ok(baxter.flags.some(f => f.includes("same firm")));
    assert.ok(!s.alternatives.some(a => /12 mg\/mL/.test(a.ingredient)));
    assert.ok(s.alternatives.some(a => a.labeler.includes("Civica") && /18 mg\/mL/.test(a.ingredient)));
    const chosen = s.alternatives.find(a => a.ndc11 === s.recommendation.ndc11)!;
    assert.equal(chosen.catalog?.status, "Available");
    assert.ok(chosen.flags.includes("different container (vial vs bag)"));
  });
});

test("held backordered stock is usable now but cannot be ordered, even after adjudication", async () => {
  await withHospital(async (ctx, crosswalk, items) => {
    const ex = await investigate(ctx, (await loadRecall(ctx, "D-0727-2026"))!, items);
    const [s] = await analyseSupply(ctx, ex, items, crosswalk);
    assert.equal(s.useNow?.ndc11, "70069006325");
    assert.equal(s.useNow?.units, 20);
    const backorder = s.alternatives.find(a => a.ndc11 === s.useNow!.ndc11)!;
    assert.equal(backorder.catalog?.status, "Backorder");
    assert.notEqual(s.recommendation.ndc11, backorder.ndc11);
    const [adjudicated] = await analyseSupply(ctx, ex, items, crosswalk, new Map([[s.item_id, { ndc11: backorder.ndc11, reason: "invalid reviewer choice" }]]));
    assert.notEqual(adjudicated.recommendation.ndc11, backorder.ndc11);
    assert.equal(adjudicated.recommendation.method, "rule");
    assert.ok(ctx.trace.events.some(e => /reject.*adjudication/i.test(e.summary)));
  });
});

test("critic rejects a model adjudication ordering a backordered alternative", async () => {
  await withHospital(async (ctx, crosswalk, items) => {
    const ex = await investigate(ctx, (await loadRecall(ctx, "D-0727-2026"))!, items);
    const supply = await analyseSupply(ctx, ex, items, crosswalk);
    let request: ChatRequest | undefined;
    await withModelRuntime({ mode: "deterministic", onRequest: r => { request = r; } }, () => review(ctx, ex, supply, 1));
    const req = request!, key = requestKey("llm", req);
    const response = { status: 200, body: { choices: [{ message: { content: JSON.stringify({ substitutes: [{ item_id: supply[0].item_id, ndc: "70069-0063-25", reason: "unsafe test choice" }], approve: true }) } }] } };
    const recordings = new Map([[key, { kind: "llm" as const, key, request: req, response, recordedAt: "test" }]]);
    const result = await withModelRuntime({ mode: "replay", recordings }, () => review(ctx, ex, supply, 1));
    assert.equal(result.substituteAdjudications.size, 0);
    assert.equal(result.approved, false);
  });
});
