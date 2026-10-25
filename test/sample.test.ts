// Exercise the real agent path offline. In addition to outcomes, capture requests from
// differently shaped SQL responses: exact prompt bytes are the cassette contract.
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
import { withModelRuntime, type ChatRequest } from "../src/llm.ts";
import type { DataBackend, Row } from "../src/data/backend.ts";

process.env.LOTLINE_QUIET = "true";
async function sample(permute = false) {
  const local = new LocalBackend(), trace = silentTrace(), requests: ChatRequest[] = [];
  const backend: DataBackend = permute ? {
    name: "duckdb", dialect: "duckdb", sources: () => local.sources(), close: () => local.close(),
    describe: async table => (await local.describe(table)).reverse(),
    query: async (sql, meta) => (await local.query(sql, meta)).reverse().map(row => Object.fromEntries(Object.entries(row).reverse().map(([k, v]) => [k, v === null ? undefined : ["qty_units", "units_per_pack", "ingredient_count", "packs", "lot_row_id"].includes(k) ? Number(v) : v])) as Row),
  } : local;
  const ctx = makeContext({ runId: "sample-test", today: "2026-10-24", backend, world: new WorldModel({ storage: "memory", namespace: "riverside-sample" }), trace });
  try {
    return await withModelRuntime({ mode: "deterministic", onRequest: request => requests.push(request) }, async () => {
      const crosswalk = await discoverCrosswalk(ctx), items = await loadItems(ctx, crosswalk);
      const result = (await runCase(ctx, "D-0727-2026", items, crosswalk))!;
      return { result, packet: await report(ctx, result), requests, events: trace.events };
    });
  } finally { await backend.close(); }
}

test("sample runCase uses no recordings and quarantines 68 units: 2 affected, 1 review", async () => {
  const { result, packet, events } = await sample();
  assert.equal(result.exposure.findings.filter(f => f.verdict === "affected").length, 2);
  assert.equal(result.exposure.findings.filter(f => f.verdict === "review").length, 1);
  assert.equal(result.supply[0].quarantined, 68);
  assert.equal(result.supply[0].daysAfter, 8.7);
  assert.equal(packet.approved, false);
  assert.equal(packet.summaryBy, "template");
  assert.match(packet.supply[0].shortage!, /snapshot only/i);
  for (const agent of ["cartographer", "exposure", "supply", "critic", "reporter"]) assert.ok(events.some(e => e.type === "fallback" && e.agent === agent), `${agent} must label its deterministic fallback`);
  assert.equal(events.filter(e => e.type === "llm").length, 0);
});

test("actual agent prompts are byte-identical with reordered, numeric and null backend responses", async () => {
  const baseline = await sample(), changed = await sample(true);
  assert.deepEqual(changed.requests, baseline.requests);
  assert.deepEqual(changed.packet.lots, baseline.packet.lots);
  assert.deepEqual(changed.packet.actions, baseline.packet.actions);
});
