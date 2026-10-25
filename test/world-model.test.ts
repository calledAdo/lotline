import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TruthMaintenance, WorldModel } from "../engines/world-model/src/index.ts";

const at = (t: string) => ({ kind: "agent" as const, by: "test", at: `2026-10-24T${t}:00.000Z` });

async function scenario(world = new WorldModel({ storage: "memory", namespace: "t" })) {
  const tm = new TruthMaintenance(world);
  const recall = await tm.observeEvidence({ table: "fda_snapshot.recalls", key: "D-0727-2026", row: { code_info: "Lot #: 6133436, Exp. Date 10/2028" }, source: at("10:00") });
  const lotA = await tm.observeEvidence({ table: "hospital.inventory_lots", key: "1", row: { lot: "6133436", qty: 50 }, source: at("10:00") });
  const lotB = await tm.observeEvidence({ table: "hospital.inventory_lots", key: "3", row: { lot: "6133437", qty: 75 }, source: at("10:00") });
  const shortage = await tm.observeEvidence({ table: "fda_snapshot.shortages", key: "63323-286-23", row: { availability: "Available" }, source: at("10:00") });
  const affected = await tm.assertClaim({ key: "affected:D-0727-2026:1", kind: "lot-affected", subject: "lot-1", statement: "Lot 6133436 in OR is covered", value: true, confidence: 0.98, evidence: [recall.id, lotA.id], producedBy: "exposure", source: at("10:01") });
  const clear = await tm.assertClaim({ key: "affected:D-0727-2026:3", kind: "lot-affected", subject: "lot-3", statement: "Lot 6133437 is not covered", value: false, confidence: 0.97, evidence: [recall.id, lotB.id], producedBy: "exposure", source: at("10:01") });
  const supply = await tm.assertClaim({ key: "supply:ropi", kind: "supply", subject: "RX-ROPI-05-20", statement: "75 vials usable after quarantine", value: 75, confidence: 0.9, evidence: [shortage.id], claims: [affected.id, clear.id], producedBy: "supply", source: at("10:02") });
  return { world, tm, recall, lotA, lotB, shortage, affected, clear, supply };
}

test("a fresh set of claims is not stale", async () => {
  const { tm } = await scenario();
  assert.deepEqual(tm.staleClaims(), []);
});

test("changing one evidence row reopens exactly the claims that depended on it, transitively", async () => {
  const { tm, affected, clear, supply } = await scenario();
  const changed = await tm.observeEvidence({ table: "hospital.inventory_lots", key: "3", row: { lot: "6133437", qty: 40 }, source: at("11:00") });
  assert.equal(changed.changed, true);
  const stale = tm.staleClaims().map(s => s.claim.id).sort();
  assert.deepEqual(stale, [clear.id, supply.id].sort());
  assert.equal(tm.staleness(affected.id).stale, false);
  const why = tm.staleness(supply.id).reasons[0]!;
  assert.equal(why.kind, "claim-stale");
  assert.equal(why.kind === "claim-stale" && why.because[0]!.kind, "evidence-changed");
});

test("a recall expansion (new recall text) reopens both lot claims and the supply claim", async () => {
  const { tm, recall, affected, clear, supply } = await scenario();
  assert.deepEqual(tm.dependents(recall.id).map(c => c.id).sort(), [affected.id, clear.id, supply.id].sort());
  await tm.observeEvidence({ table: "fda_snapshot.recalls", key: "D-0727-2026", row: { code_info: "Lot #: 6133436, 6133437, Exp. Date 10/2028" }, source: at("12:00") });
  assert.equal(tm.staleClaims().length, 3);
});

test("re-deriving a stale claim clears it and marks its dependents as revised", async () => {
  const { tm, lotB, recall, supply } = await scenario();
  await tm.observeEvidence({ table: "hospital.inventory_lots", key: "3", row: { lot: "6133437", qty: 40 }, source: at("11:00") });
  const revised = await tm.assertClaim({ key: "affected:D-0727-2026:3", kind: "lot-affected", subject: "lot-3", statement: "Lot 6133437 is not covered", value: false, confidence: 0.97, evidence: [recall.id, lotB.id], producedBy: "exposure", source: at("11:01") });
  assert.equal(revised.revision, 2);
  assert.equal(tm.staleness(revised.id).stale, false);
  const why = tm.staleness(supply.id).reasons;
  assert.deepEqual(why, [{ kind: "claim-revised", dependency: revised.id, recordedRevision: 1, currentRevision: 2 }]);
});

test("re-asserting an unchanged claim appends no events", async () => {
  const { world, tm, recall, lotA } = await scenario();
  const before = world.events().length;
  await tm.observeEvidence({ table: "hospital.inventory_lots", key: "1", row: { qty: 50, lot: "6133436" }, source: at("13:00") });
  await tm.assertClaim({ key: "affected:D-0727-2026:1", kind: "lot-affected", subject: "lot-1", statement: "Lot 6133436 in OR is covered", value: true, confidence: 0.98, evidence: [lotA.id, recall.id], producedBy: "exposure", source: at("13:01") });
  assert.equal(world.events().length, before);
});

test("retracting a claim makes its dependents stale", async () => {
  const { tm, affected, supply } = await scenario();
  await tm.retractClaim("affected:D-0727-2026:1", "critic rejected", at("14:00"));
  assert.equal(tm.claims().some(c => c.id === affected.id), false);
  assert.deepEqual(tm.staleness(supply.id).reasons, [{ kind: "claim-retracted", dependency: affected.id }]);
});

test("claims must cite known evidence and cannot cite themselves", async () => {
  const { tm, affected } = await scenario();
  await assert.rejects(tm.assertClaim({ key: "x", kind: "k", subject: "s", statement: "s", confidence: 1, evidence: ["evidence:zetaris:nope#1"], producedBy: "t", source: at("10:00") }), /unknown evidence/);
  await assert.rejects(tm.assertClaim({ key: "affected:D-0727-2026:1", kind: "k", subject: "s", statement: "s", confidence: 1, claims: [affected.id], producedBy: "t", source: at("10:00") }), /itself/);
});

test("a world reloaded from its event log equals the live world, including fact resolution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lotline-wm-"));
  const live = new WorldModel({ storage: "local", namespace: "reload", directory: dir });
  const { tm } = await scenario(live);
  await tm.observeEvidence({ table: "hospital.inventory_lots", key: "3", row: { lot: "6133437", qty: 40 }, source: at("11:00") });
  await live.assertFact({ about: "item:hospital:RX-ROPI-05-20", predicate: "status", value: "quarantined", confidence: 0.9, source: at("11:02") });
  await live.assertFact({ about: "item:hospital:RX-ROPI-05-20", predicate: "status", value: "released", confidence: 0.6, source: at("11:03") });
  const reloaded = new WorldModel({ storage: "local", namespace: "reload", directory: dir });
  assert.equal(reloaded.stateShapeCanonical(), live.stateShapeCanonical());
  assert.equal(reloaded.view("graph").entity("item:hospital:RX-ROPI-05-20")!.attrs.status, "released");
  assert.deepEqual(new TruthMaintenance(reloaded).staleClaims().map(s => s.claim.id).sort(), tm.staleClaims().map(s => s.claim.id).sort());
});

test("a torn final line (crash mid-append) loses only that event", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lotline-wm-"));
  const live = new WorldModel({ storage: "local", namespace: "torn", directory: dir });
  await scenario(live);
  const count = live.events().length;
  fs.appendFileSync(path.join(dir, ".world", "torn.events.jsonl"), '{"id":"evt_999","seq":999,"kind":"upser');
  const reloaded = new WorldModel({ storage: "local", namespace: "torn", directory: dir });
  assert.equal(reloaded.events().length, count);
  assert.equal(reloaded.stateShapeCanonical(), live.stateShapeCanonical());
});
