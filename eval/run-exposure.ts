// Scores Exposure lot verdicts against the answer key for every anchor scenario.
// Usage: tsx eval/run-exposure.ts            (uses the configured backend and models)
//        SAMPLE_MODE=true tsx eval/run-exposure.ts   (deterministic paths only, offline)
import { WorldModel } from "../engines/world-model/src/index.ts";
import { openBackend } from "../src/data/index.ts";
import { makeContext } from "../src/context.ts";
import { Trace } from "../src/trace.ts";
import { discoverCrosswalk } from "../src/agents/cartographer.ts";
import { investigate, loadItems, loadRecall } from "../src/agents/exposure.ts";
import { SCENARIOS, expectedFor } from "./scenarios.ts";

process.env.LOTLINE_QUIET ??= "true";
const runId = `eval-exposure-${Date.now()}`;
const trace = new Trace(runId);
const backend = openBackend(trace.dir);
const world = new WorldModel({ storage: "memory", namespace: runId });
const ctx = makeContext({ runId, runDir: trace.dir, today: "2026-10-24", backend, world, trace });
const crosswalk = await discoverCrosswalk(ctx);
const items = await loadItems(ctx, crosswalk);

let correct = 0, total = 0;
for (const s of SCENARIOS) {
  const recall = await loadRecall(ctx, s.recall);
  if (!recall) { console.log(`MISSING recall ${s.recall}`); continue; }
  const ex = await investigate(ctx, recall, items);
  console.log(`\n${s.recall}  ${s.title}   [lots read by ${ex.parseMethod}; coverage: ${ex.coverage.map(c => `${c.item_id}=${c.decision}/${c.method}${c.disputed ? "!" : ""}`).join(", ")}]`);
  for (const e of expectedFor(s.items)) {
    const got = ex.findings.find(f => f.lot.lot_row_id === e.lot_row_id)?.verdict ?? "not_affected";
    const ok = got === e.expected;
    total++; if (ok) correct++;
    console.log(`  ${ok ? "ok  " : "MISS"} lot row ${e.lot_row_id.padStart(2)} expected ${e.expected.padEnd(12)} got ${got.padEnd(12)} ${e.note}`);
  }
  for (const issue of ex.dataIssues) console.log(`  data issue: ${issue}`);
}
console.log(`\n${correct}/${total} lot verdicts match the answer key (trace: ${trace.dir})`);
await backend.close();
process.exit(correct === total ? 0 : 1);
