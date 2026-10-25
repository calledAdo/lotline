// Model/source text is untrusted HTML input. Validate offline output, navigable claims,
// complete receipts and the watch diff without relying on an external UI framework.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { report, type Packet } from "../src/agents/reporter.ts";
import { withModelRuntime, DEFAULT_MODELS } from "../src/llm.ts";
import { renderPacket } from "../src/render.ts";
import type { TraceEvent } from "../src/trace.ts";

let packet: Packet;
before(async () => { const { ctx, result } = await fixture(); packet = await withModelRuntime({ mode: "deterministic" }, () => report(ctx, result)); });
test("offline renderer escapes text and every evidence link resolves after URL decoding", () => {
  const p = structuredClone(packet);
  p.summary = '<script>alert("bad")</script>';
  p.lots[0].reason = '<img src=x onerror="bad()">';
  const html = renderPacket(p, []);
  assert.ok(!/<script\b|<img\b/i.test(html));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("prefers-color-scheme:dark"));
  assert.ok(html.includes("default-src 'none'"));
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const m of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(decodeURIComponent(m[1])), m[1]);
});
test("renderer includes watch changes and full live/replayed model receipts", () => {
  const events: TraceEvent[] = [{ seq: 1, t: "2026-10-25", ms: 100, agent: "critic", type: "llm", summary: "review", data: { status: 200, receipt: { receiptId: "receipt-example", requestedModel: DEFAULT_MODELS.deep, routedModel: DEFAULT_MODELS.deep, provider: "nvidia", latencyMs: 123, inputTokens: 456, outputTokens: 789, costUsd: 0, replayed: true } } }, { seq: 2, t: "2026-10-25", ms: 101, agent: "supply", type: "sql", summary: "read", data: { backend: "duckdb", rows: 10, sql: "SELECT * FROM hospital.item_master" } }];
  const html = renderPacket(packet, events, { runId: "test", cmd: "watch", today: packet.today, backend: "duckdb", diffs: [{ recall: packet.recall.recall_number, lines: ["MAIN lot 6133437 newly affected"] }] });
  for (const value of ["What changed", "6133437 newly affected", DEFAULT_MODELS.deep, "receipt-example", "nvidia", "123 ms", "456", "789", "0.000000", "Replayed", "SELECT * FROM hospital.item_master"]) assert.ok(html.includes(value), value);
});
