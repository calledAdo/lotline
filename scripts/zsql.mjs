// Runs Zetaris Lightning SQL over REST, one statement per call (no trailing semicolons).
// Usage: node scripts/zsql.mjs "SELECT 1" ["SELECT 2" ...]   or   node scripts/zsql.mjs -f file.sql
// ${VAR} placeholders are filled from .env, so credentials never live in SQL files,
// and every secret value is masked in the printed output.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8")
  .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const secrets = Object.entries(env).filter(([k]) => /KEY|SECRET|PASSWORD|TOKEN/.test(k)).map(([, v]) => v).filter(v => v.length > 3);
const mask = s => secrets.reduce((t, v) => t.replaceAll(v, "***"), s);
const fill = sql => sql.replace(/\$\{(\w+)\}/g, (_, k) => { if (!(k in env)) throw new Error(`missing ${k} in .env`); return env[k]; });

const args = process.argv.slice(2);
// A file is split on semicolons at line ends; each command-line argument is one statement.
const statements = (args[0] === "-f"
  ? readFileSync(args[1], "utf8").split(/;\s*(?:\n|$)/)
  : args).map(s => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
for (const raw of statements) {
  const t0 = Date.now();
  const res = await fetch(`${env.ZETARIS_REST_URL}/sql-editor/sqls/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ZETARIS_API_KEY}`, "X-Org-ID": env.ZETARIS_ORG_ID, "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
    body: JSON.stringify({ queryId: randomUUID(), sql: fill(raw), source: "SqlEditor", limit: 200 }),
    signal: AbortSignal.timeout(300_000),
  });
  const body = await res.text();
  console.log(`-- ${mask(raw).split("\n")[0].slice(0, 100)}  [HTTP ${res.status}, ${Date.now() - t0} ms]`);
  console.log(mask(body).slice(0, 2000));
  if (!res.ok) process.exitCode = 1;
}
