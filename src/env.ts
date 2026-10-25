// Loads .env without a dependency. Values already in process.env win, so judges and CI can
// override anything. Secrets are never logged; use `redact()` before printing text that
// might contain them.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parse(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const fileEnv = parse(path.join(ROOT, ".env"));
export const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };

export function need(name: string): string {
  const v = env[name];
  if (!v || v.startsWith("your-") || v.startsWith("change-me")) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

export const sampleMode = (env.SAMPLE_MODE ?? "false").toLowerCase() === "true";

const secretValues = () =>
  Object.entries(env)
    .filter(([k, v]) => /KEY|SECRET|PASSWORD|TOKEN/.test(k) && v && v.length > 3)
    .map(([, v]) => v as string);

export function redact(text: string): string {
  return secretValues().reduce((t, v) => t.replaceAll(v, "***"), text);
}
