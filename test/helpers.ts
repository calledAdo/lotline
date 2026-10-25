// Real snapshot fixtures for policy tests; all model work is explicitly disabled and
// every backend is closed. Expected answers stay in tests, never in agent inputs.
import { WorldModel } from "../engines/world-model/src/index.ts";
import { LocalBackend } from "../src/data/local.ts";
import { makeContext, type RunContext } from "../src/context.ts";
import { silentTrace } from "../src/trace.ts";
import { discoverCrosswalk, type Crosswalk } from "../src/agents/cartographer.ts";
import { loadItems } from "../src/agents/exposure.ts";
import { runCase } from "../src/orchestrator.ts";
import { withModelRuntime } from "../src/llm.ts";
import type { Item } from "../src/domain.ts";

process.env.LOTLINE_QUIET = "true";
export async function fixture(recall = "D-0727-2026") {
  return withHospital(async (ctx, crosswalk, items) => ({ ctx, crosswalk, items, result: (await runCase(ctx, recall, items, crosswalk))! }));
}
export async function withHospital<T>(work: (ctx: RunContext, crosswalk: Crosswalk, items: Item[]) => Promise<T>): Promise<T> {
  const backend = new LocalBackend(), trace = silentTrace();
  const ctx = makeContext({ runId: "fixture", today: "2026-10-24", backend, world: new WorldModel({ storage: "memory", namespace: "riverside-sample" }), trace });
  try {
    return await withModelRuntime({ mode: "deterministic" }, async () => {
      const crosswalk = await discoverCrosswalk(ctx), items = await loadItems(ctx, crosswalk);
      return work(ctx, crosswalk, items);
    });
  } finally { await backend.close(); }
}
