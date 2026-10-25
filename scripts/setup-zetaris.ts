// The single setup command: admin registration + view publication + read-only users.
import { readFileSync } from "node:fs";
import { env, redact } from "../src/env.ts";
import { adminSql } from "./zetaris-admin.ts";
import { setupPrincipals } from "./setup-zetaris-principals.ts";
import { LocalBackend } from "../src/data/local.ts";
import { makeContext } from "../src/context.ts";
import { silentTrace } from "../src/trace.ts";
import { WorldModel } from "../engines/world-model/src/index.ts";
import { discoverCrosswalk } from "../src/agents/cartographer.ts";
import { withModelRuntime } from "../src/llm.ts";
import { ident, lit, ndcExpr } from "../src/data/dialect.ts";
async function setup() {
  const statements = readFileSync("scripts/register_zetaris_sources.sql", "utf8").replace(/^\s*--.*$/gm, "").split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
  for (const statement of statements) {
    const sql = statement.replace(/\$\{(\w+)\}/g, (_, key) => { if (!env[key]) throw new Error(`Missing ${key}`); return env[key]!; });
    try { await adminSql(sql); console.log(`${statement.split("\n")[0]}: OK`); }
    catch (e) {
      if (/already exists|already registered/i.test((e as Error).message)) console.log(`${statement.split("\n")[0]}: exists (retained)`);
      else throw e;
    }
  }
  const local = new LocalBackend();
  process.env.LOTLINE_QUIET = "true";
  try {
    const ctx = makeContext({ runId: "setup-crosswalk", today: "2026-10-24", backend: local, trace: silentTrace(), world: new WorldModel({ storage: "memory", namespace: "setup" }) });
    const crosswalk = await withModelRuntime({ mode: "deterministic" }, () => discoverCrosswalk(ctx));
    const body = crosswalk.mappings.map(m => `SELECT i.item_id, ${lit(m.table)} AS source_table, cast(s.${ident(m.column)} as string) AS source_code FROM hospital.item_master i JOIN ${ident(m.table)} s ON i.ndc11 = ${ndcExpr("spark", `s.${ident(m.column)}`, m.transform)}`).join(" UNION ALL ");
    try { await adminSql("CREATE SCHEMASTORE CONTAINER lotline_views"); } catch(e) { if (!/already exists/i.test((e as Error).message)) throw e; }
    await adminSql(`CREATE OR REPLACE SCHEMASTORE VIEW ndc_crosswalk WITH CONTAINER lotline_views AS ${body}`);
    console.log("lotline_views.ndc_crosswalk: setup view published using measured fixture transforms");
  } finally { await local.close(); }
  await setupPrincipals();
}
setup().catch(e => { console.error(redact(e.message)); process.exitCode = 1; });
