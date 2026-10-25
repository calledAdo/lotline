// Re-run a recorded live case through DuckDB and the real agents. Exact request hashes
// prove prompt parity; this never replays SQL or calls a provider.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorldModel } from "../engines/world-model/src/index.ts";
import { ROOT } from "../src/env.ts";
import { recordedLibrary, requestKey, type Recording } from "../src/cassette.ts";
import { LocalBackend } from "../src/data/local.ts";
import { makeContext } from "../src/context.ts";
import { Trace } from "../src/trace.ts";
import { discoverCrosswalk, ensureCrosswalk } from "../src/agents/cartographer.ts";
import { loadItems } from "../src/agents/exposure.ts";
import { runCase } from "../src/orchestrator.ts";
import { report } from "../src/agents/reporter.ts";
import { withModelRuntime } from "../src/llm.ts";
import assert from "node:assert/strict";
import { selectRecordings } from "./promote-cassette.ts";
import { detectChanges } from "../src/watch.ts";

process.env.LOTLINE_QUIET = "true";
const id = process.argv[2];
// Historical recordings predate T4's exact escalation dedupe. This explicit mode
// keeps core parity strict, reports policy differences, and preserves the original proof.
const policyUpdate = process.argv.includes("--policy-update");
if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("usage: check-replay.ts <live-run-id>");
const dir = path.join(ROOT, "runs", id);
const metadata = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
const records: Recording[] = selectRecordings(readFileSync(path.join(dir, "cassette.jsonl"), "utf8"));
// A run's replies take precedence over the shared library for nondeterministic calls.
const library = new Map(recordedLibrary());
for (const r of [...records].reverse()) library.set(r.key, r);
const trace = new Trace(`replay-check-${id}`, { persist: false });
const backend = new LocalBackend();
let worldDir: string | undefined;
if (metadata.cmd === "watch") {
  const baseline = process.argv[3];
  if (!baseline || !/^[A-Za-z0-9_-]+$/.test(baseline)) throw new Error("Watch replay needs the baseline run ID as a second argument, with the local drill expanded");
  worldDir = mkdtempSync(path.join(os.tmpdir(), "lotline-replay-world-"));
  mkdirSync(path.join(worldDir, ".world"));
  copyFileSync(path.join(ROOT, "runs", baseline, "world.events.jsonl"), path.join(worldDir, ".world", "riverside-sample.events.jsonl"));
}
const ctx = makeContext({ runId: trace.runId, today: metadata.today, backend, world: new WorldModel({ storage: worldDir ? "local" : "memory", directory: worldDir, namespace: "riverside-sample" }), trace });
const requests: { key: string; hit: boolean; presentationOnly: boolean }[] = [];
const policyDifferences: { recall: string; field: string }[] = [];
try {
  await withModelRuntime({ mode: "replay", recordings: library, onRequest: req => requests.push({ key: requestKey("llm", req), hit: library.has(requestKey("llm", req)), presentationOnly: req.messages[0]?.content.startsWith("Select 2–4 sentences") ?? false }) }, async () => {
    const crosswalk = await (worldDir ? ensureCrosswalk(ctx) : discoverCrosswalk(ctx)), items = await loadItems(ctx, crosswalk);
    if (worldDir) {
      const stale = await detectChanges(ctx);
      assert.deepEqual(stale.map(s => ({ recall: s.recall, keys: s.staleClaims.map(c => c.key).sort() })), metadata.stale.map((s: { recall: string; staleClaims: { key: string }[] }) => ({ recall: s.recall, keys: s.staleClaims.map(c => c.key).sort() })), "same dependent claims must become stale");
    }
    for (const recall of metadata.recalls) {
      const result = await runCase(ctx, recall, items, crosswalk);
      if (!result) throw new Error(`Missing ${recall}`);
      const packet = await report(ctx, result);
      const live = JSON.parse(readFileSync(path.join(dir, `packet-${recall}.json`), "utf8"));
      for (const field of ["lots", "coverage", "decisions", "actions", "dataIssues", "approved"] as const) {
        if (policyUpdate && (field === "actions" || field === "approved")) {
          if (JSON.stringify(packet[field]) !== JSON.stringify(live[field])) policyDifferences.push({ recall, field });
        } else assert.deepEqual(packet[field], live[field], `${recall}: ${field} must match the live run`);
      }
      const supply = (rows: typeof packet.supply) => rows.map(({ shortage, expiredRecalled, useNowCautions, orderCautions, ...rest }) => rest);
      assert.deepEqual(supply(packet.supply), supply(live.supply), `${recall}: supply outcomes must match (freshness labels intentionally differ)`);
    }
  });
  const result = { liveRun: id, backend: "duckdb", outcomeParity: !policyDifferences.length, coreOutcomeParity: true, policyDifferences, requests, hits: requests.filter(r => r.hit).length, misses: requests.filter(r => !r.hit).length, coreMisses: requests.filter(r => !r.hit && !r.presentationOnly).length, fallbacks: trace.events.filter(e => e.type === "fallback").map(e => e.summary) };
  writeFileSync(path.join(dir, policyUpdate ? "replay-check-hardened.json" : "replay-check.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = (policyUpdate ? result.coreMisses : result.misses) ? 1 : 0;
} finally { await backend.close(); if (worldDir) rmSync(worldDir, { recursive: true, force: true }); }
