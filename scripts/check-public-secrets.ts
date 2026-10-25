// Check only publishable files. Load configured secrets solely for in-memory comparison;
// never print values, copy .env, inspect browser state, or echo matching lines.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { ROOT, redact } from "../src/env.ts";
import { assertNoSecrets } from "../src/secrets.ts";
import path from "node:path";

const listing = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" });
const files = [...new Set(listing.split("\0").filter(Boolean))].filter(f => f === ".env.example" || !f.split("/").some(p => p.startsWith(".env") || [".git", ".agents", ".codex", ".aws", ".gstack", "node_modules", "runs", ".world"].includes(p)));
const credentialPatterns = [
  /\b(?:sk-[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
let checked = 0, artifacts = 0;
const failures: string[] = [];
for (const file of files) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) continue; // screenshots are checked visually, not as text
  const text = bytes.toString("utf8");
  checked++;
  let failed = redact(text) !== text || credentialPatterns.some(p => p.test(text));
  if (/^(data\/cassettes\/|eval\/results\/)/.test(file)) {
    artifacts++;
    try { assertNoSecrets(text); } catch { failed = true; }
  }
  if (failed) failures.push(file);
}
console.log(`Scanned ${checked} public text files (${artifacts} strict cassette/result artifacts); ${failures.length} suspected-secret files. No credential values printed.`);
for (const file of failures) console.log(`Review required: ${file}`);
process.exitCode = failures.length ? 1 : 0;
