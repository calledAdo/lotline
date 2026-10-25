// Probes each Nemotron model through Nightshift and prints status, latency, reply and the
// runtime's own routing metadata (the "meterless" block). Never prints the token.
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8")
  .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const base = env.METERLESS_BASE_URL.replace(/\/+$/, "");
const headers = { Authorization: `Bearer ${env.METERLESS_RUNTIME_TOKEN}`, "meterless-app": "lotline", "meterless-scope": "user", "Content-Type": "application/json" };
const models = process.argv.slice(2);
await Promise.all(models.map(async model => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/chat/completions`, { method: "POST", headers, signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: "user", content: "Reply with exactly: lotline ok" }] }) });
    const j = await r.json().catch(() => ({}));
    const reply = j.choices?.[0]?.message?.content;
    console.log(`${model} -> HTTP ${r.status} ${Date.now() - t0}ms | reply=${JSON.stringify(reply?.slice?.(0, 60))} | model=${j.model} | meterless=${JSON.stringify(j.meterless)}${j.error ? " | error=" + String(j.error.meterless_detail || j.error.message).slice(0, 120) : ""}`);
  } catch (e) { console.log(`${model} -> ${e.name} ${Date.now() - t0}ms`); }
}));
