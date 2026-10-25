// Lotline command line.
//   lotline run <RECALL_NUMBER> [--no-critic]   work one recall end to end
//   lotline sweep [--max N]                     triage today's ongoing recalls, then work the relevant ones
//   lotline watch                               re-check earlier conclusions; re-derive only what went stale
// SAMPLE_MODE=true runs without Zetaris, Nightshift or credentials (local data, recorded model replies).
import { WorldModel } from "../engines/world-model/src/index.ts";
import { ROOT, env, redact, sampleMode } from "./env.ts";
import { randomUUID } from "node:crypto";
import { openBackend } from "./data/index.ts";
import { makeContext } from "./context.ts";
import { Trace } from "./trace.ts";
import { ensureCrosswalk } from "./agents/cartographer.ts";
import { loadItems } from "./agents/exposure.ts";
import { triage } from "./agents/planner.ts";
import { runCase } from "./orchestrator.ts";
import { report, type Packet } from "./agents/reporter.ts";
import { writeFileSync } from "node:fs";
import { detectChanges, diffPackets, lastPacket, type PacketDiff } from "./watch.ts";
import path from "node:path";
import { withModelRuntime } from "./llm.ts";
import { recordingsFor } from "./cassette.ts";
import { renderRun } from "./render.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const today = opt("today") ?? process.env.LOTLINE_TODAY ?? "2026-10-24";

async function main() {
  if (cmd !== "run" && cmd !== "sweep" && cmd !== "watch") {
    console.log("usage: lotline run <RECALL_NUMBER> [--no-critic] | lotline sweep [--max N] | lotline watch");
    process.exit(2);
  }
  if (cmd === "run" && !/^[A-Z]-\d{4}-\d{4}$/.test(args[1] ?? "")) throw new Error("run requires a recall number such as D-0727-2026");
  const seconds = Number(opt("timeout-seconds") ?? 600);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 2400) throw new Error("timeout-seconds must be between 1 and 2400");
  const timer = setTimeout(() => { console.error(`Run exceeded ${seconds}s; stopped`); process.exit(124); }, seconds * 1000);
  timer.unref();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${cmd === "run" ? args[1] : cmd}${sampleMode ? "-sample" : ""}-${randomUUID().slice(0, 8)}`;
  const trace = new Trace(runId);
  const backend = openBackend(trace.dir);
  // One persistent world per hospital, so later runs can see what changed since earlier ones.
  const world = new WorldModel({ storage: flag("ephemeral") ? "memory" : "local", namespace: sampleMode ? "riverside-sample" : "riverside", directory: env.LOTLINE_WORLD_DIR ?? ROOT });
  const ctx = makeContext({ runId, runDir: trace.dir, today, backend, world, trace });
  trace.emit("run-start", "lotline", `${cmd} ${args.slice(1).join(" ")} on ${backend.name}${sampleMode ? " (SAMPLE_MODE: recorded model replies, local data)" : ""}`);
  try {
    const crosswalk = await ensureCrosswalk(ctx);
    const items = await loadItems(ctx, crosswalk);
    const stale = cmd === "watch" ? await detectChanges(ctx) : [];
    const recalls = cmd === "run" ? [args[1]!] : cmd === "watch" ? stale.map(s => s.recall) : (await triage(ctx, items)).filter(t => t.relevant !== "no").slice(0, Number(opt("max") ?? 10)).map(t => t.recall_number);
    const before = new Map(recalls.map(r => [r, cmd === "watch" ? lastPacket(r, runId, backend.name) : null]));
    const packets: Packet[] = [];
    for (const r of recalls) {
      const work = async () => {
        const result = await runCase(ctx, r, items, crosswalk, { critic: !flag("no-critic") });
        if (result) packets.push(await report(ctx, result));
      };
      if (sampleMode) await withModelRuntime({ mode: "replay", recordings: recordingsFor(r, cmd === "watch") }, work);
      else await work();
    }
    const diffs: PacketDiff[] = packets.map(p => before.get(p.recall.recall_number) ? diffPackets(before.get(p.recall.recall_number)!, p) : null).filter((d): d is PacketDiff => !!d);
    for (const dff of diffs) trace.emit("invalidation", "watcher", `${dff.recall}: ${dff.lines.length ? dff.lines.join(" | ") : "no change in the packet"}`, { diff: dff.lines });
    writeFileSync(path.join(trace.dir, "run.json"), JSON.stringify({ runId, cmd, today, backend: backend.name, sampleMode, recalls, stale, diffs, packets: packets.map(p => ({ recall: p.recall.recall_number, headline: p.headline, approved: p.approved })) }, null, 2) + "\n");
    if (flag("ephemeral")) writeFileSync(path.join(trace.dir, "world.events.jsonl"), world.events().map(e => JSON.stringify(e)).join("\n") + "\n");
    trace.emit("run-end", "lotline", `${packets.length} packet(s) written to ${path.relative(ROOT, trace.dir)}`);
    renderRun(trace.dir);
    for (const p of packets) console.log(`\n${p.headline}\n${p.summary}\n${p.actions.slice(0, 8).map(a => `  [${a.priority}] ${a.text}`).join("\n")}`);
    for (const p of packets) console.log(`Packet: ${path.join(trace.dir, `packet-${p.recall.recall_number}.html`)}`);
    console.log(`Index: ${path.join(trace.dir, "index.html")}`);
    for (const dff of diffs) console.log(`\nWhat changed in ${dff.recall}:\n${dff.lines.map(l => `  - ${l}`).join("\n") || "  nothing"}`);
    if (cmd === "watch" && !recalls.length) console.log("\nEvery earlier conclusion still holds.");
  } finally {
    clearTimeout(timer);
    await backend.close();
  }
}

main().catch(err => { console.error(redact((err as Error).message)); process.exit(1); });
