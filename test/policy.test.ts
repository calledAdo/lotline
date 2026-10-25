import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalBackend } from "../src/data/local.ts";
import { PolicyRefusal } from "../src/data/policy.ts";
import { silentTrace } from "../src/trace.ts";
import { renderPacket } from "../src/render.ts";
import { fixture } from "./helpers.ts";
import { report } from "../src/agents/reporter.ts";
import { withModelRuntime } from "../src/llm.ts";
process.env.LOTLINE_QUIET = "true";
test("planner reads only its granted tables; denial is a visible policy event", async () => {
  const root = new LocalBackend(), backend = root.forAgent("planner"), trace = silentTrace();
  try {
    const ctx = { agent: "planner", purpose: "policy regression", trace };
    assert.equal((await backend.query("SELECT count(*) AS n FROM fda_snapshot.recalls", ctx))[0].n, "615");
    assert.equal((await backend.query("SELECT (SELECT count(*) FROM fda_snapshot.recalls) AS n", ctx))[0].n, "615");
    for (const sql of [
      "SELECT * FROM hospital.purchase_orders", "SELECT * FROM fda_snapshot.recalls UNION ALL TABLE hospital.purchase_orders", "SELECT * FROM fda_snapshot.recalls UNION ALL SELECT * FROM hospital.purchase_orders",
      "SELECT * FROM fda_snapshot.recalls, hospital.purchase_orders", "SELECT * FROM read_csv('/etc/passwd')",
      "SELECT * FROM fda_snapshot.recalls; DROP TABLE hospital.item_master", "SELECT * FROM fda_snapshot.recalls --hidden",
      "SELECT * FROM fda_snapshot.recalls r JOIN fda_snapshot.recalls s ON r.recall_number=s.recall_number, hospital.purchase_orders p",
      "SELECT * FROM fda_snapshot.recalls WHERE recall_number IN (SELECT po_number FROM hospital.purchase_orders)",
    ]) await assert.rejects(backend.query(sql, ctx), PolicyRefusal, sql);
    await assert.rejects(backend.query("SELECT * FROM hospital.purchase_orders", { ...ctx, agent: "supply" }), PolicyRefusal);
    await assert.rejects(backend.describe("hospital.purchase_orders"), PolicyRefusal);
    assert.throws(() => backend.forAgent!("supply"), PolicyRefusal);
    assert.ok(trace.events.some(e => e.type === "policy" && e.data?.principal === "lotline_planner"));
    assert.ok(trace.events.some(e => e.type === "sql" && e.data?.principal === "lotline_planner"));
    const { ctx: context, result } = await fixture();
    const packet = await withModelRuntime({ mode: "deterministic" }, () => report(context, result));
    const html = renderPacket(packet, trace.events);
    assert.match(html, /Data access policy/); assert.match(html, /lotline_planner/); assert.match(html, /was refused/);
  } finally { await root.close(); }
});
