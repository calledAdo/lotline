// Bounded live authorization check, no model calls or credential output.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { env, need, redact } from "../src/env.ts";
import { ZetarisBackend } from "../src/data/zetaris.ts";
import { Trace } from "../src/trace.ts";
import { renderRun } from "../src/render.ts";
const trace = new Trace(`principal-check-${Date.now()}`);
const backend = new ZetarisBackend(trace.dir);
try {
  for (const agent of ["cartographer", "planner", "exposure", "supply", "watcher"]) {
    const table = agent === "planner" ? "fda_snapshot.recalls" : agent === "supply" ? "hospital.inventory_lots" : "hospital.item_master";
    const rows = await backend.forAgent(agent).query(`SELECT count(*) AS n FROM ${table}`, { agent, purpose: "verify allowed principal read", trace });
    console.log(`${agent}: allowed SELECT ${table}; count=${rows[0]?.n}`);
  }
  // Deliberately bypass the app allowlist here to test Zetaris's own enforcement.
  const login = await fetch(`${need("ZETARIS_REST_URL")}/auth/login`, { headers: { Authorization: `Basic ${Buffer.from(`${need("ZETARIS_PLANNER_USER")}:${need("ZETARIS_PLANNER_PASSWORD")}`).toString("base64")}`, "X-Org-ID": env.ZETARIS_ORG_ID ?? "1", "X-Request-ID": randomUUID() }, signal: AbortSignal.timeout(15000) });
  if (!login.ok) throw new Error(`planner login HTTP ${login.status}`);
  const { idToken } = await login.json() as { idToken: string };
  const response = await fetch(`${need("ZETARIS_REST_URL")}/sql-editor/sqls/run`, { method: "POST", headers: { Authorization: `Bearer ${idToken}`, "X-Org-ID": env.ZETARIS_ORG_ID ?? "1", "X-Request-ID": randomUUID(), "Content-Type": "application/json" }, body: JSON.stringify({ queryId: randomUUID(), sql: "SELECT * FROM hospital.purchase_orders", source: "SqlEditor", limit: 1 }), signal: AbortSignal.timeout(30000) });
  const body = await response.json() as { msg?: string };
  const reason = redact(String(body.msg ?? "")).split("\n\tat")[0].slice(0, 600);
  if (response.ok || !/denied|permission|not.*(?:allowed|authoriz|exist|found)|privilege|cannot.*access/i.test(reason)) throw new Error(`Expected server refusal, got HTTP ${response.status}: ${reason}`);
  trace.emit("policy", "planner", "Zetaris refused SELECT hospital.purchase_orders", { principal: "lotline_planner", allowed: false, enforcement: "zetaris", status: response.status, reason });
  console.log(`planner: server refused SELECT hospital.purchase_orders; HTTP ${response.status}; ${reason}`);
  writeFileSync(`${trace.dir}/run.json`, JSON.stringify({ runId: trace.runId, packets: [], diffs: [] }));
  renderRun(trace.dir);
  console.log(`Policy event index: ${trace.dir}/index.html`);
} finally { await backend.close(); }
