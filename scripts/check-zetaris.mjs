// Checks the Zetaris REST connection with SELECT 1. Never prints the API key.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8")
  .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const key = env.ZETARIS_API_KEY;
if (!key || key === "your-zetaris-api-key") { console.error("ZETARIS_API_KEY not set in .env"); process.exit(2); }
const res = await fetch(`${env.ZETARIS_REST_URL}/sql-editor/sqls/run`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "X-Org-ID": env.ZETARIS_ORG_ID, "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
  body: JSON.stringify({ queryId: randomUUID(), sql: "SELECT 1 AS one", source: "SqlEditor", limit: 10 }),
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text.replaceAll(key, "***").slice(0, 800));
process.exit(res.ok ? 0 : 1);
