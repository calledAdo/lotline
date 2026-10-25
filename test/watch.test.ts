// Packet differences must expose changes the buyer acts on, including removals and
// quantity corrections that leave the verdict unchanged.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { report, type Packet } from "../src/agents/reporter.ts";
import { withModelRuntime } from "../src/llm.ts";
import { diffPackets } from "../src/watch.ts";
let beforePacket: Packet;
before(async () => { const {ctx,result}=await fixture(); beforePacket=await withModelRuntime({mode:"deterministic"},()=>report(ctx,result)); });
test("identical packets have no diff; expansion exposes lot and supply consequences", () => {
  assert.deepEqual(diffPackets(beforePacket, structuredClone(beforePacket)).lines, []);
  const after=structuredClone(beforePacket); after.recall.code_info="Lot #: 6133436, 6133437, Exp. Date 10/2028";
  after.lots.find(l=>l.lot==="6133437")!.verdict="affected";
  after.supply[0].quarantined=143; after.supply[0].daysAfter=0;
  const lines=diffPackets(beforePacket,after).lines.join("\n");
  assert.match(lines,/not_affected -> affected/); assert.match(lines,/68 -> 143/); assert.match(lines,/8.7 -> 0/);
});
test("quantity, expiry, removed lots and approval changes are visible", () => {
  const after=structuredClone(beforePacket);
  after.lots[0].qty+=2; after.lots[0].expiry="2029-01-31";
  const removed=after.lots.pop()!; after.approved=!beforePacket.approved;
  const lines=diffPackets(beforePacket,after).lines.join("\n");
  assert.match(lines,/quantity|units.*->/i); assert.match(lines,/2029-01-31/); assert.ok(lines.includes(removed.lot) && /removed|no longer/i.test(lines)); assert.match(lines,/approval/i);
});
test("resolved supply review and removed actions are not silently dropped", () => {
  const after=structuredClone(beforePacket); after.supply=[]; after.decisions=[]; after.actions=[];
  const lines=diffPackets(beforePacket,after).lines.join("\n");
  assert.match(lines,/supply review.*ended|no longer under supply review/i); assert.match(lines,/removed action|action removed/i);
});
