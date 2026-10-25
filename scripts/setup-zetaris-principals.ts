import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, env, redact } from "../src/env.ts";
import { AGENT_TABLES } from "../src/data/policy.ts";
import { adminSql } from "./zetaris-admin.ts";

export function ensurePrincipalCredentials() {
  const file = path.join(ROOT, ".env");
  for (const agent of Object.keys(AGENT_TABLES)) {
    const prefix = `ZETARIS_${agent.toUpperCase()}`;
    for (const [suffix, value] of [["USER", `lotline_${agent}@local.test`], ["PASSWORD", "Aa9!" + randomBytes(24).toString("hex")]]) {
      const key = `${prefix}_${suffix}`;
      if (!env[key] || /^(your-|change-me)/.test(env[key]!)) {
        const contents = readFileSync(file, "utf8");
        writeFileSync(file, contents.replace(new RegExp(`^${key}=.*\\n?`, "gm"), "") + `\n${key}=${value}\n`, { mode: 0o600 }); env[key] = value;
      }
    }
  }
}
export async function setupPrincipals() {
  ensurePrincipalCredentials();
  const statements = readFileSync(path.join(ROOT, "scripts/setup_zetaris_principals.sql"), "utf8").replace(/^\s*--.*$/gm, "").split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
  for (const statement of statements) {
    const sql = statement.replace(/\$\{(\w+)\}/g, (_, key) => { if (!env[key]) throw new Error(`Missing ${key}`); return env[key]!.replaceAll("'", "''"); });
    try { await adminSql(sql); console.log(`${statement.split("\n")[0].slice(0, 100)}: OK`); }
    catch (err) {
      if (/already exists|already (?:been )?assigned|already (?:been )?granted/i.test((err as Error).message)) console.log(`${statement.split("\n")[0].slice(0, 100)}: exists`);
      else throw err;
    }
  }
}
if (process.argv[1]?.endsWith("setup-zetaris-principals.ts")) setupPrincipals().catch(e => { console.error(redact(e.message)); process.exitCode = 1; });
