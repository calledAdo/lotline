// Dev harness: runs one agent in isolation. Usage: tsx scripts/try-agent.ts cartographer
import { WorldModel } from "../engines/world-model/src/index.ts";
import { openBackend } from "../src/data/index.ts";
import { makeContext } from "../src/context.ts";
import { Trace } from "../src/trace.ts";
import { discoverCrosswalk } from "../src/agents/cartographer.ts";

const runId = `dev-${process.argv[2]}-${Date.now()}`;
const trace = new Trace(runId);
const backend = openBackend(trace.dir);
const world = new WorldModel({ storage: "memory", namespace: runId });
const ctx = makeContext({ runId, runDir: trace.dir, today: "2026-10-24", backend, world, trace });
const out = await discoverCrosswalk(ctx);
console.log(JSON.stringify({ mappings: out.mappings, modelUsed: out.modelUsed, view: out.view, probes: out.probes.filter(p => p.matchedItems > 0 || p.transform === "identity") }, null, 1));
await backend.close();
