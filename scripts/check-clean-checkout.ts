// Validate the unpublished working tree as a clean checkout without copying .env,
// installed dependencies, runs or worlds. No commit or repository publication is needed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../src/env.ts";

const exec = promisify(execFile);
const dir = mkdtempSync(path.join(os.tmpdir(), "lotline-clean-"));
const { stdout: listing } = await exec("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT });
const files = [...new Set(listing.split("\0").filter(Boolean))].filter(f => f === ".env.example" || (!f.split("/").some(part => part.startsWith(".env") || [".git", ".agents", ".codex", ".aws", ".gstack", "node_modules", "runs", ".world"].includes(part))));
for (const file of files) {
  if (!existsSync(path.join(ROOT, file))) continue;
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  copyFileSync(path.join(ROOT, file), path.join(dir, file));
}
const childEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
const logs: { command: string; elapsedMs: number; stdout: string; stderr: string }[] = [];
for (const args of [["install", "--cache", path.join(dir, ".npm-cache"), "--no-audit", "--no-fund"], ["run", "demo"]]) {
  const start = Date.now();
  const { stdout, stderr } = await exec("npm", args, { cwd: dir, env: { ...childEnv, LOTLINE_QUIET: "true" }, timeout: args[0] === "install" ? 180_000 : 60_000, maxBuffer: 4_000_000 });
  logs.push({ command: `npm ${args.join(" ")}`, elapsedMs: Date.now() - start, stdout, stderr });
  console.log(`${args.join(" ")}: passed in ${Date.now() - start}ms`);
}
const run = readdirSync(path.join(dir, "runs"))[0];
const events = readFileSync(path.join(dir, "runs", run, "trace.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
const result = { directory: dir, envFilePresent: existsSync(path.join(dir, ".env")), files: files.length, logs, replayed: events.filter(e => e.type === "llm" && e.data?.receipt?.replayed).length, fallbacks: events.filter(e => e.type === "fallback").map(e => e.summary) };
mkdirSync(path.join(ROOT, "briefs", "validation"), { recursive: true });
writeFileSync(path.join(ROOT, "briefs", "validation", "clean-checkout.json"), JSON.stringify(result, null, 2) + "\n");
console.log(`Credential-free demo: ${result.replayed} replayed responses, ${result.fallbacks.length} fallbacks; ${dir}`);
