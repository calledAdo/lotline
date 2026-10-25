// Checks the Meterless Nightshift runtime: lists routing modes, then sends one short
// chat request on each configured mode and prints which model the response reports.
// Never prints the token.
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8")
  .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const token = env.METERLESS_RUNTIME_TOKEN;
if (!token || token === "your-nightshift-runtime-token") { console.error("METERLESS_RUNTIME_TOKEN not set in .env"); process.exit(2); }
const base = env.METERLESS_BASE_URL.replace(/\/+$/, "");
const headers = { Authorization: `Bearer ${token}`, "meterless-app": env.METERLESS_APP_ID || "lotline", "Content-Type": "application/json" };
const mask = s => s.replaceAll(token, "***");

const models = await fetch(`${base}/models`, { headers });
console.log(`GET /models -> HTTP ${models.status}`);
if (models.status === 401 || models.status === 403) { console.error("unauthorized: check the token"); process.exit(1); }
const list = await models.json();
console.log("modes:", (list.data || []).map(m => m.id).join(", "));

for (const mode of [env.METERLESS_FAST_MODE, env.METERLESS_DEEP_MODE]) {
  const t0 = Date.now();
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST", headers: { ...headers, "meterless-scope": "user" },
    body: JSON.stringify({ model: mode, messages: [{ role: "user", content: "Reply with exactly: lotline ok" }], max_tokens: 20 }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await r.text();
  let parsed = {}; try { parsed = JSON.parse(body); } catch {}
  const routeHeaders = [...r.headers].filter(([k]) => /meterless|model|provider|lane|route|run|receipt/i.test(k));
  console.log(`\n${mode} -> HTTP ${r.status} in ${Date.now() - t0} ms`);
  console.log("  response.model:", parsed.model);
  console.log("  reply:", JSON.stringify(parsed.choices?.[0]?.message?.content));
  console.log("  routing headers:", JSON.stringify(routeHeaders));
  if (!r.ok) console.log("  body:", mask(body).slice(0, 500));
}
