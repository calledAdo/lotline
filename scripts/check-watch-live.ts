// Local Zetaris integration: source updates + real agents, models disabled, memory world.
import assert from "node:assert/strict";
import { WorldModel } from "../engines/world-model/src/index.ts";
import { ZetarisBackend } from "../src/data/zetaris.ts";
import { makeContext } from "../src/context.ts";
import { Trace } from "../src/trace.ts";
import { withModelRuntime } from "../src/llm.ts";
import { discoverCrosswalk } from "../src/agents/cartographer.ts";
import { loadItems } from "../src/agents/exposure.ts";
import { runCase } from "../src/orchestrator.ts";
import { detectChanges, diffPackets } from "../src/watch.ts";
import { report } from "../src/agents/reporter.ts";
import { renderRun } from "../src/render.ts";
import { applyDrill } from "./drill.ts";
import { writeFileSync } from "node:fs";
process.env.LOTLINE_QUIET = "true";
const trace = new Trace(`hardening-live-watch-${Date.now()}`), backend = new ZetarisBackend(trace.dir);
const ctx = makeContext({ runId: trace.runId, runDir: trace.dir, today: "2026-10-24", backend, trace, world: new WorldModel({ storage: "memory", namespace: "hardening-live" }) });
const start = Date.now();
try {
  await withModelRuntime({ mode: "deterministic" }, async () => {
    const crosswalk = await discoverCrosswalk(ctx), items = await loadItems(ctx, crosswalk);
    const derive = async () => (await runCase(ctx, "D-0727-2026", items, crosswalk))!;
    const baseline = await derive();
    const before = await report(ctx, baseline);
    console.log(`live baseline: order=${baseline.supply[0].recommendation.ndc11}; quarantined=${baseline.supply[0].quarantined}`);
    assert.deepEqual(await detectChanges(ctx), []);
    console.log("unchanged live sources: 0 stale cases");
    await applyDrill("wholesaler", undefined, undefined, true);
    const stale = await detectChanges(ctx);
    assert.ok(stale.some(c => c.changedEvidence.some(e => e.table === "wholesaler.catalog")));
    const after = await derive();
    assert.notEqual(after.supply[0].recommendation.ndc11, baseline.supply[0].recommendation.ndc11);
    console.log(`wholesaler: ${stale[0].staleClaims.length} stale claims; order ${baseline.supply[0].recommendation.ndc11} -> ${after.supply[0].recommendation.ndc11}`);
    const packet = await report(ctx, after), diff = diffPackets(before, packet);
    await applyDrill("shortage", undefined, undefined, true);
    const shortage = await detectChanges(ctx);
    assert.ok(shortage.some(c => c.changedEvidence.some(e => e.table === "fda_snapshot.shortages")));
    console.log(`shortage: ${shortage[0].staleClaims.length} stale claims; snapshot change detected through Zetaris`);
    await derive();
    writeFileSync(`${trace.dir}/run.json`, JSON.stringify({ runId: trace.runId, cmd: "live-watch-check", today: ctx.today, stale, shortage, diffs: [diff] }, null, 2));
    renderRun(trace.dir);
    console.log(`live watcher evidence: ${trace.dir}`);
  });
} finally { await applyDrill("reset", undefined, undefined, true); await backend.close(); console.log(`live watcher check elapsed: ${Date.now() - start} ms`); }
