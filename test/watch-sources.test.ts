import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../src/env.ts";
import { LocalBackend } from "../src/data/local.ts";
import { makeContext } from "../src/context.ts";
import { WorldModel } from "../engines/world-model/src/index.ts";
import { silentTrace } from "../src/trace.ts";
import { withModelRuntime } from "../src/llm.ts";
import { discoverCrosswalk } from "../src/agents/cartographer.ts";
import { loadItems } from "../src/agents/exposure.ts";
import { runCase } from "../src/orchestrator.ts";
import { detectChanges } from "../src/watch.ts";
import { applyDrill } from "../scripts/drill.ts";
process.env.LOTLINE_QUIET = "true";
async function hospital(work: (ctx: ReturnType<typeof makeContext>, root: string, derive: () => ReturnType<typeof runCase>) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "lotline-watch-"));
  for (const dir of ["snapshot", "sources", "drills"]) cpSync(path.join(ROOT, "data", dir), path.join(root, "data", dir), { recursive: true });
  // Tests own their fixtures even when an operator has an active local drill.
  for (const [from, to] of [["recall_updates.baseline.jsonl", "drills/recall_updates.jsonl"], ["wholesaler_catalog.baseline.csv", "sources/wholesaler_catalog.csv"], ["fda_shortages.baseline.jsonl", "snapshot/fda_shortages.jsonl"]]) cpSync(path.join(root, "data/drills", from), path.join(root, "data", to));
  const backend = new LocalBackend(undefined, undefined, root);
  const ctx = makeContext({ runId: "watch-test", today: "2026-10-24", backend, world: new WorldModel({ storage: "memory", namespace: "test" }), trace: silentTrace() });
  try { await withModelRuntime({ mode: "deterministic" }, async () => {
    const crosswalk = await discoverCrosswalk(ctx);
    const derive = async () => runCase(ctx, "D-0727-2026", await loadItems(ctx, crosswalk), crosswalk);
    await derive(); await work(ctx, root, derive);
  }); } finally { await backend.close(); rmSync(root, { recursive: true, force: true }); }
}
test("unchanged sources leave every case claim fresh", async () => hospital(async ctx => {
  assert.deepEqual(await detectChanges(ctx), []);
  assert.deepEqual(ctx.tm.staleClaims(), []);
}));
test("wholesaler drill invalidates supply and changes the order; reset restores it", async () => hospital(async (ctx, root, derive) => {
  const before = (await derive())!;
  assert.equal(before.supply[0].recommendation.ndc11, "43066001910");
  await applyDrill("wholesaler", undefined, root, false);
  const stale = await detectChanges(ctx);
  assert.equal(stale.length, 1);
  assert.ok(stale[0].changedEvidence.some(e => e.table === "wholesaler.catalog"));
  assert.ok(stale[0].staleClaims.some(c => c.key.startsWith("supply:")));
  assert.ok(!stale[0].staleClaims.some(c => c.key.startsWith("lot:")));
  assert.ok((await detectChanges(ctx))[0].changedEvidence.some(e => e.table === "wholesaler.catalog"), "repeat polling retains the stale evidence identity");
  const after = (await derive())!;
  assert.notEqual(after.supply[0].recommendation.ndc11, before.supply[0].recommendation.ndc11);
  assert.ok(after.supply[0].recommendation.ndc11);
  assert.deepEqual(await detectChanges(ctx), []);
  await applyDrill("reset", undefined, root, false);
  await detectChanges(ctx);
  assert.equal((await derive())!.supply[0].recommendation.ndc11, "43066001910");
}));
test("deleted lot produces evidence-missing and is retracted after re-derivation", async () => hospital(async (ctx, root, derive) => {
  const file = path.join(root, "data/sources/hospital_inventory_lots.jsonl");
  const rows = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const deleted = rows.find(r => r.lot_number === "6133436");
  writeFileSync(file, rows.filter(r => r.lot_row_id !== deleted.lot_row_id).map(r => JSON.stringify(r)).join("\n") + "\n");
  const stale = await detectChanges(ctx);
  assert.match(JSON.stringify(stale), /evidence-missing/);
  await derive();
  assert.equal(ctx.tm.claims({ kind: "lot-verdict" }).some(c => c.subject === String(deleted.lot_row_id)), false);
  assert.deepEqual(await detectChanges(ctx), []);
}));
test("shortage drill refreshes snapshot and sample live view, then resets", async () => hospital(async (ctx, root, derive) => {
  await applyDrill("shortage", undefined, root, false);
  const stale = await detectChanges(ctx);
  assert.ok(stale[0].changedEvidence.some(e => e.table === "fda_snapshot.shortages"));
  assert.ok(stale[0].changedEvidence.some(e => e.table === "fda_live_views.shortages"));
  assert.equal((await derive())!.supply[0].ownShortage?.availability, "Unavailable");
  assert.deepEqual(await detectChanges(ctx), []);
  await applyDrill("reset", undefined, root, false);
}));
test("usage, purchase orders and item master changes refresh their dependent supply", async () => hospital(async (ctx, root, derive) => {
  const before = (await derive())!;
  const item = before.supply[0].item_id;
  const edit = (file: string, mutate: (rows: any[]) => any[]) => {
    const target = path.join(root, "data", file);
    const rows = readFileSync(target, "utf8").trim().split("\n").map(l => JSON.parse(l));
    writeFileSync(target, mutate(rows).map(r => JSON.stringify(r)).join("\n") + "\n");
  };
  edit("sources/hospital_dispensing_daily.jsonl", rows => [...rows, { item_id: item, location_code: "MAIN", day: "2026-10-24", units: 300 }, { item_id: item, location_code: "MAIN", day: "2026-10-25", units: 99999 }]);
  edit("sources/hospital_purchase_orders.jsonl", rows => [...rows, { po_number: "DRILL-PO", item_id: item, packs: 9, expected_on: "2026-10-30", status: "open" }]);
  edit("sources/hospital_item_master.jsonl", rows => rows.map(r => r.item_id === item ? { ...r, description: `${r.description} TEST` } : r));
  const stale = await detectChanges(ctx);
  for (const table of ["hospital.dispensing_daily", "hospital.purchase_orders", "hospital.item_master"]) assert.ok(stale[0].changedEvidence.some(e => e.table === table), table);
  const after = (await derive())!;
  assert.equal(after.supply[0].avgDaily, before.supply[0].avgDaily + 10);
  assert.ok(after.supply[0].openPOs.some(p => p.po_number === "DRILL-PO" && p.packs === 9));
  assert.match(after.supply[0].description, /TEST$/);
  assert.deepEqual(await detectChanges(ctx), []);
}));
test("a lot quantity correction leaves recall parsing, coverage and other lot verdicts fresh", async () => hospital(async (ctx, root) => {
  const file = path.join(root, "data/sources/hospital_inventory_lots.jsonl");
  const rows = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const changed = rows.find(r => r.lot_number === "6133436");
  changed.qty_units += 1;
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const stale = await detectChanges(ctx);
  assert.equal(stale.length, 1);
  const keys = stale[0].staleClaims.map(c => c.key);
  assert.deepEqual(keys.filter(k => k.startsWith("lot:")), [`lot:D-0727-2026:${changed.lot_row_id}`]);
  assert.ok(!keys.some(k => /^(coverage|lots|inputs):/.test(k)));
  assert.ok(keys.some(k => k.startsWith("supply:")));
}));
