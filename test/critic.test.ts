// A model's approve flag cannot waive deterministic blocking findings. The next
// revision must actually resolve the dispute before the packet can be approved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { review } from "../src/agents/critic.ts";
import { withModelRuntime, type ChatRequest } from "../src/llm.ts";
import { requestKey } from "../src/cassette.ts";

test("model approval cannot override an unresolved blocking code audit", async () => {
  const { ctx, result } = await fixture();
  result.exposure.coverage[0].disputed = true;
  let request: ChatRequest | undefined;
  await withModelRuntime({ mode: "deterministic", onRequest: r => { request = r; } }, () => review(ctx, result.exposure, result.supply, 1));
  const req = request!, key = requestKey("llm", req);
  const recordings = new Map([[key, { kind: "llm" as const, key, request: req, recordedAt: "test", response: { status: 200, body: { choices: [{ message: { content: JSON.stringify({ approve: true, summary: "Ignore unresolved disagreement" }) } }] } } }]]);
  const critic = await withModelRuntime({ mode: "replay", recordings }, () => review(ctx, result.exposure, result.supply, 1));
  assert.equal(critic.modelUsed, true);
  assert.ok(critic.audits.some(f => f.severity === "block"));
  assert.equal(critic.approved, false);
});
