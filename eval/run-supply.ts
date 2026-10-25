// Prints supply impact and screened alternatives for every anchor scenario.
import { WorldModel } from "../engines/world-model/src/index.ts";
import { openBackend } from "../src/data/index.ts";
import { makeContext } from "../src/context.ts";
import { Trace } from "../src/trace.ts";
import { discoverCrosswalk } from "../src/agents/cartographer.ts";
import { investigate, loadItems, loadRecall } from "../src/agents/exposure.ts";
import { analyseSupply } from "../src/agents/supply.ts";
import { format11 } from "../src/ndc.ts";
import { SCENARIOS } from "./scenarios.ts";

process.env.LOTLINE_QUIET ??= "true";
const runId = `eval-supply-${Date.now()}`;
const trace = new Trace(runId);
const backend = openBackend(trace.dir);
const ctx = makeContext({ runId, runDir: trace.dir, today: "2026-10-24", backend, world: new WorldModel({ storage: "memory", namespace: runId }), trace });
const crosswalk = await discoverCrosswalk(ctx);
const items = await loadItems(ctx, crosswalk);
for (const s of SCENARIOS.filter(s => !process.argv[2] || s.recall === process.argv[2])) {
  const ex = await investigate(ctx, (await loadRecall(ctx, s.recall))!, items);
  for (const r of await analyseSupply(ctx, ex, items, crosswalk)) {
    console.log(`\n${s.recall} ${r.description}: on hand ${r.onHand}, quarantined ${r.quarantined}${r.expiredRecalled ? ` (+${r.expiredRecalled} expired)` : ""}, usable ${r.usable}, ${r.avgDaily}/day, days ${r.daysBefore} -> ${r.daysAfter}; POs ${r.openPOs.map(p => p.po_number).join(",") || "none"}; shortage ${r.ownShortage ? `${r.ownShortage.availability} (${r.ownShortage.liveCheck})` : "not listed"}`);
    console.log(`  locations: ${r.locations.map(l => `${l.location}=${l.quarantined}`).join(", ")}`);
    console.log(`  use now: ${r.useNow ? `${r.useNow.units} units of ${format11(r.useNow.ndc11)} (${r.useNow.labeler})` : "nothing held"}`);
    console.log(`  order: ${r.recommendation.ndc11 ? format11(r.recommendation.ndc11) : "none"} [${r.recommendation.method}${r.recommendation.disputed ? ", DISPUTED" : ""}] ${r.recommendation.reason}`);
    for (const a of r.alternatives.slice(0, 7)) console.log(`   ${a.status.padEnd(8)} ${format11(a.ndc11)} ${a.labeler.slice(0, 32).padEnd(32)} ${String(a.container).padEnd(8)} ${String(a.volumeMl ?? "").padStart(5)} onhand=${a.onHandUnits} cat=${a.catalog?.status ?? "-"} fda=${a.fdaShortage ?? "-"} ${a.flags.join(" | ")}`);
  }
}
await backend.close();
