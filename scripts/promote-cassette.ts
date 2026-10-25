// Promote only model recordings. SQL may contain deployment-specific information and
// is deliberately excluded; hashes and credentials are checked before any output write.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../src/env.ts";
import { requestKey, type Recording } from "../src/cassette.ts";
import { assertNoSecrets } from "../src/secrets.ts";

export function selectRecordings(contents: string): Recording[] {
  const unique = new Map<string, Recording>();
  for (const line of contents.split("\n").filter(l => l.trim())) {
    const r = JSON.parse(line) as Recording;
    if (r.kind !== "llm") continue;
    assertNoSecrets(JSON.stringify(r));
    if (r.key !== requestKey("llm", r.request)) throw new Error("Cassette request hash does not match its key");
    if (!r.response || !r.recordedAt) throw new Error("Incomplete model recording");
    // A successful retry is the effective reply. Within successful replies, first wins,
    // matching live per-run memoization; failed attempts remain in the raw trace.
    const prior = unique.get(r.key);
    if (!prior || ((prior.response as { status?: number }).status !== 200 && (r.response as { status?: number }).status === 200)) unique.set(r.key, r);
  }
  if (!unique.size) throw new Error("No model recordings to promote");
  return [...unique.values()];
}

export function promoteCassette(runId: string, name = runId): { file: string; count: number } {
  for (const id of [runId, name]) if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error("Run ID and name must be plain basenames");
  const rows = selectRecordings(readFileSync(path.join(ROOT, "runs", runId, "cassette.jsonl"), "utf8"));
  const dir = path.join(ROOT, "data", "cassettes");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  if (existsSync(file)) throw new Error("Destination exists; choose a new cassette name");
  writeFileSync(`${file}.tmp`, rows.map(r => JSON.stringify(r)).join("\n") + "\n", { flag: "wx" });
  renameSync(`${file}.tmp`, file);
  const runFile = path.join(ROOT, "runs", runId, "run.json");
  if (existsSync(runFile)) {
    const run = JSON.parse(readFileSync(runFile, "utf8"));
    const meta = JSON.stringify({ runId, cmd: run.cmd, today: run.today, recalls: run.recalls, backend: run.backend }, null, 2) + "\n";
    assertNoSecrets(meta);
    writeFileSync(path.join(dir, `${name}.meta.json`), meta);
  }
  return { file, count: rows.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error("usage: tsx scripts/promote-cassette.ts <runId> [name]");
    const result = promoteCassette(process.argv[2], process.argv[3]);
    console.log(`Promoted ${result.count} model recordings to ${path.relative(ROOT, result.file)}`);
  } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
}
