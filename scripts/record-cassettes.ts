// Bounded sequential recording of the six anchors and one reversible watch drill.
// Seed an isolated watcher world from the first run, leaving the operator's world intact.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, redact } from "../src/env.ts";
import { promoteCassette } from "./promote-cassette.ts";

const exec = promisify(execFile);
const resume = process.argv[2];
if (resume && !/^recordings-\d+$/.test(resume)) throw new Error("usage: record-cassettes.ts [recordings-<timestamp>]");
const batch = path.join(ROOT, "runs", resume ?? `recordings-${Date.now()}`);
mkdirSync(batch, { recursive: true });
const records: { command: string; runId?: string; elapsedMs: number; status: string }[] = resume ? JSON.parse(readFileSync(path.join(batch, "recordings.json"), "utf8")) : [];
async function run(args: string[], name: string, extra: Record<string, string> = {}) {
  const start = Date.now();
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, timeout: 490_000, maxBuffer: 4_000_000, env: { ...process.env, SAMPLE_MODE: "false", LOTLINE_QUIET: "true", LLM_TIMEOUT_MS: "120000", ZETARIS_TIMEOUT_MS: "30000", ...extra } });
    writeFileSync(path.join(batch, `${name}.log`), redact(stdout + stderr));
    const r = { command: `npx tsx ${args.join(" ")}`, elapsedMs: Date.now() - start, status: "ok" };
    records.push(r);
    console.log(`${name}: ok (${r.elapsedMs}ms)`);
    return stdout;
  } catch (e) {
    records.push({ command: `npx tsx ${args.join(" ")}`, elapsedMs: Date.now() - start, status: "failed or timed out" });
    throw new Error(`${name} failed or timed out; recording stopped (provider details withheld)`);
  } finally { writeFileSync(path.join(batch, "recordings.json"), JSON.stringify(records, null, 2) + "\n"); }
}
function newestRun(before: Set<string>, cmd: string, recall?: string): string {
  const ids = readdirSync(path.join(ROOT, "runs")).filter(id => {
    if (before.has(id) || !existsSync(path.join(ROOT, "runs", id, "run.json"))) return false;
    const meta = JSON.parse(readFileSync(path.join(ROOT, "runs", id, "run.json"), "utf8"));
    return meta.cmd === cmd && !meta.sampleMode && (!recall || meta.recalls.includes(recall));
  });
  if (ids.length !== 1) throw new Error("Could not identify the new run uniquely");
  return ids[0];
}
const anchors = ["D-0727-2026", "D-0850-2026", "D-0815-2026", "D-0486-2026", "D-0591-2025", "D-0036-2026"];
let baseline = "";
try {
  for (const recall of anchors) {
    const prior = records.find(r => r.runId && r.status === "ok" && r.command.startsWith(`npx tsx src/cli.ts run ${recall} `));
    if (prior?.runId) {
      baseline ||= prior.runId;
      if (!existsSync(path.join(ROOT, "data", "cassettes", `${prior.runId}.jsonl`))) promoteCassette(prior.runId);
      await run(["scripts/check-replay.ts", prior.runId], `replay-${recall}`, { SAMPLE_MODE: "true" });
      continue;
    }
    const before = new Set(readdirSync(path.join(ROOT, "runs")));
    await run(["src/cli.ts", "run", recall, "--ephemeral", "--timeout-seconds", "480"], recall);
    const id = newestRun(before, "run", recall);
    records[records.length - 1].runId = id;
    baseline ||= id;
    const result = promoteCassette(id);
    console.log(`  ${id}: promoted ${result.count} model recordings`);
    await run(["scripts/check-replay.ts", id], `replay-${recall}`, { SAMPLE_MODE: "true" });
  }
  const isolated = path.join(batch, "watch-world");
  mkdirSync(path.join(isolated, ".world"), { recursive: true });
  copyFileSync(path.join(ROOT, "runs", baseline, "world.events.jsonl"), path.join(isolated, ".world", "riverside.events.jsonl"));
  try {
    await run(["scripts/drill.ts", "expand", "D-0727-2026"], "expand");
    const before = new Set(readdirSync(path.join(ROOT, "runs")));
    await run(["src/cli.ts", "watch", "--timeout-seconds", "480"], "watch", { LOTLINE_WORLD_DIR: isolated });
    const id = newestRun(before, "watch");
    records[records.length - 1].runId = id;
    console.log(`  ${id}: promoted ${promoteCassette(id).count} watch recordings`);
    await run(["scripts/check-replay.ts", id, baseline], "replay-watch", { SAMPLE_MODE: "true" });
  } finally { await run(["scripts/drill.ts", "reset"], "reset"); }
} finally {
  writeFileSync(path.join(batch, "recordings.json"), JSON.stringify(records, null, 2) + "\n");
  console.log(`Recording log: ${path.relative(ROOT, batch)}/recordings.json`);
}
