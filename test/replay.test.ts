// A live cassette must drive the entire DuckDB agent run, not a saved packet or SQL
// replay. This fails when prompt bytes drift from the promoted live recordings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldModel } from "../engines/world-model/src/index.ts";
import { LocalBackend } from "../src/data/local.ts";
import { makeContext } from "../src/context.ts";
import { silentTrace } from "../src/trace.ts";
import { discoverCrosswalk } from "../src/agents/cartographer.ts";
import { loadItems } from "../src/agents/exposure.ts";
import { runCase } from "../src/orchestrator.ts";
import { report } from "../src/agents/reporter.ts";
import { chatJson, DEFAULT_MODELS, LlmUnavailable, modelFor, withModelRuntime, type Receipt } from "../src/llm.ts";
import { env } from "../src/env.ts";
import { recordingsFor } from "../src/cassette.ts";

process.env.LOTLINE_QUIET = "true";
test("promoted live Naropin recordings replay the investigative agents on local data", async () => {
  const backend = new LocalBackend(), trace = silentTrace();
  const ctx = makeContext({ runId: "replay-test", today: "2026-10-24", backend, world: new WorldModel({ storage: "memory", namespace: "riverside-sample" }), trace });
  try {
    await withModelRuntime({ mode: "replay", recordings: recordingsFor("D-0727-2026") }, async () => {
      const crosswalk = await discoverCrosswalk(ctx), items = await loadItems(ctx, crosswalk);
      const result = (await runCase(ctx, "D-0727-2026", items, crosswalk))!;
      const packet = await report(ctx, result);
      assert.equal(result.supply[0].quarantined, 68);
      assert.ok(packet.summary.startsWith(packet.headline));
    });
    assert.deepEqual(trace.events.filter(e => e.type === "fallback" && e.agent !== "reporter").map(e => e.summary), []);
    assert.ok(trace.events.filter(e => e.type === "fallback").every(e => e.agent === "reporter"), "only the summary may fall back after action-policy hardening changes its sentences");
    const calls = trace.events.filter(e => e.type === "llm");
    for (const agent of ["cartographer", "exposure", "supply", "critic"]) assert.ok(calls.some(e => e.agent === agent));
    assert.ok(calls.every(e => (e.data?.receipt as Receipt).replayed));
    assert.ok(calls.some(e => (e.data?.receipt as Receipt).routedModel === DEFAULT_MODELS.deep));
  } finally { await backend.close(); }
});

test("an unrecorded request fails closed without contacting any provider", async () => {
  await withModelRuntime({ mode: "replay", recordings: new Map() }, () => assert.rejects(chatJson({ lane: "fast", agent: "test", purpose: "unrecorded", system: "test", user: "unique request", validate: v => v, trace: silentTrace() }), LlmUnavailable));
});

test("a checkout without configured model names uses the pinned cassette lanes", () => {
  const previous = [env.METERLESS_FAST_MODE, env.METERLESS_DEEP_MODE];
  try {
    delete env.METERLESS_FAST_MODE; delete env.METERLESS_DEEP_MODE;
    assert.equal(modelFor("fast"), DEFAULT_MODELS.fast);
    assert.equal(modelFor("deep"), DEFAULT_MODELS.deep);
  } finally { [env.METERLESS_FAST_MODE, env.METERLESS_DEEP_MODE] = previous; }
});
