// Zetaris backend: Lightning SQL over REST (POST /sql-editor/sqls/run). One statement per
// call, bounded by a timeout with one retry on transient failure. Live results are
// recorded to the run cassette so SAMPLE_MODE can replay this exact run.
import { randomUUID } from "node:crypto";
import { env, need, redact } from "../env.ts";
import { record } from "../cassette.ts";
import { SOURCES, type Column, type DataBackend, type Row } from "./backend.ts";
import type { Trace } from "../trace.ts";

export class ZetarisBackend implements DataBackend {
  readonly name = "zetaris" as const;
  readonly dialect = "spark" as const;
  constructor(private runDir?: string) {}

  private async run(sql: string): Promise<{ headers: string[]; data: (string | null)[][] }> {
    let lastErr = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${need("ZETARIS_REST_URL")}/sql-editor/sqls/run`, {
          method: "POST",
          headers: { Authorization: `Bearer ${need("ZETARIS_API_KEY")}`, "X-Org-ID": env.ZETARIS_ORG_ID ?? "1", "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
          body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 10000 }),
          signal: AbortSignal.timeout(Number(env.ZETARIS_TIMEOUT_MS ?? 120_000)),
        });
        const body = await res.json().catch(() => ({})) as any;
        if (res.ok) return { headers: body.headers ?? [], data: body.data ?? [] };
        lastErr = `HTTP ${res.status}: ${redact(String(body.msg ?? "")).slice(0, 300)}`;
        if (res.status < 500) break; // a SQL error will not fix itself
      } catch (err) {
        lastErr = (err as Error).message;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error(`Zetaris query failed: ${lastErr}`);
  }

  async sources() {
    return SOURCES;
  }

  async describe(table: string): Promise<Column[]> {
    const r = await this.run(`DESCRIBE ${table}`);
    return r.data.map(row => ({ name: String(row[0]), type: String(row[1]) })).filter(c => c.name && !c.name.startsWith("#"));
  }

  async query(sql: string, ctx: { agent: string; purpose: string; trace: Trace }): Promise<Row[]> {
    const t0 = Date.now();
    let r: { headers: string[]; data: (string | null)[][] };
    try { r = await this.run(sql); }
    catch (err) {
      ctx.trace.emit("sql", ctx.agent, `${ctx.purpose}: Zetaris query failed in ${Date.now() - t0}ms`, { backend: "zetaris", sql, rows: 0, error: redact((err as Error).message) });
      throw err;
    }
    const rows = r.data.map(values => Object.fromEntries(r.headers.map((h, i) => [h, values[i] === null || values[i] === undefined ? null : String(values[i])])));
    if (this.runDir) record(this.runDir, "sql", { sql }, rows);
    ctx.trace.emit("sql", ctx.agent, `${ctx.purpose}: ${rows.length} rows from Zetaris in ${Date.now() - t0}ms`, { backend: "zetaris", sql, rows: rows.length, sample: rows.slice(0, 3) });
    return rows;
  }

  async close() {}
}
