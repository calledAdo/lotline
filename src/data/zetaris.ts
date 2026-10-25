// Runtime REST transport: every reader logs in as its own non-admin user. The
// administrator key is intentionally absent from this module.
import { randomUUID } from "node:crypto";
import { env, need, redact } from "../env.ts";
import { record } from "../cassette.ts";
import { SOURCES, type Column, type DataBackend, type Row } from "./backend.ts";
import type { Trace } from "../trace.ts";
import { AGENT_TABLES, checkQuery, checkTable, isPrincipal, principalName, refuse, type Principal } from "./policy.ts";

type Result = { headers: string[]; data: (string | null)[][] };
export class ZetarisBackend implements DataBackend {
  readonly name = "zetaris" as const;
  readonly dialect = "spark" as const;
  private token?: string;
  private loginPending?: Promise<string>;
  private children = new Map<string, ZetarisBackend>();
  constructor(private runDir?: string, private principal?: Principal) {}
  forAgent(agent: string): DataBackend {
    if (!isPrincipal(agent)) refuse(agent, "unknown principal");
    if (this.principal && this.principal !== agent) refuse(this.principal, "cannot switch principal");
    if (this.principal) return this;
    if (!this.children.has(agent)) this.children.set(agent, new ZetarisBackend(this.runDir, agent));
    return this.children.get(agent)!;
  }
  private async credential(): Promise<string> {
    if (!this.principal) throw new Error("Zetaris requires a bound agent principal");
    const prefix = `ZETARIS_${this.principal.toUpperCase()}`;
    if (env[`${prefix}_API_KEY`]) return need(`${prefix}_API_KEY`);
    if (this.token) return this.token;
    if (!this.loginPending) this.loginPending = (async () => {
      const response = await fetch(`${need("ZETARIS_REST_URL")}/auth/login`, {
        headers: { Authorization: `Basic ${Buffer.from(`${need(`${prefix}_USER`)}:${need(`${prefix}_PASSWORD`)}`).toString("base64")}`, "X-Org-ID": env.ZETARIS_ORG_ID ?? "1", "X-Request-ID": randomUUID() }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Zetaris login for ${this.principal}: HTTP ${response.status}. Run npm run setup:zetaris; no administrator fallback is allowed.`);
      const body = await response.json() as { idToken?: string };
      if (!body.idToken) throw new Error(`Zetaris login for ${this.principal} returned no idToken`);
      this.token = body.idToken; return this.token;
    })().finally(() => { this.loginPending = undefined; });
    return this.loginPending;
  }
  private async run(sql: string): Promise<Result> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${need("ZETARIS_REST_URL")}/sql-editor/sqls/run`, {
        method: "POST", headers: { Authorization: `Bearer ${await this.credential()}`, "X-Org-ID": env.ZETARIS_ORG_ID ?? "1", "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
        body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 10000 }), signal: AbortSignal.timeout(Number(env.ZETARIS_TIMEOUT_MS ?? 120000)),
      });
      if (response.status === 401 && attempt === 0) { this.token = undefined; continue; }
      const body = await response.json().catch(() => ({})) as any;
      if (!response.ok && attempt === 0 && (response.status >= 500 || /HTTP response code: 50[0234]/.test(String(body.msg ?? "")))) {
        await new Promise(resolve => setTimeout(resolve, 500)); continue;
      }
      if (!response.ok) throw new Error(redact(`Zetaris HTTP ${response.status}: ${String(body.msg ?? "query failed").split("\n\tat")[0]}`).slice(0, 500));
      return { headers: body.headers ?? [], data: body.data ?? [] };
    }
    throw new Error("Zetaris authentication retry exhausted");
  }
  async sources() {
    return this.principal ? SOURCES.filter(s => (AGENT_TABLES[this.principal!] as readonly string[]).includes(s.table)) : SOURCES;
  }
  async describe(table: string, ctx?: { agent: string; trace: Trace }): Promise<Column[]> {
    if (!this.principal) return this.forAgent("cartographer").describe(table, ctx);
    checkTable(this.principal, table, ctx?.trace);
    // This version gates DESCRIBE separately from SELECT. Read only column headers
    // using the granted SELECT privilege; discovery needs names, not inferred types.
    let r: Result;
    try { r = await this.run(`SELECT * FROM ${table} LIMIT 0`); }
    catch (err) {
      const error = redact((err as Error).message);
      if (/denied|permission|not authorized|unauthori[sz]ed|forbidden|privilege|HTTP 403/i.test(error)) refuse(this.principal, error, ctx?.trace);
      throw err;
    }
    return r.headers.map(name => ({ name, type: "unknown" }));
  }
  async query(sql: string, ctx: { agent: string; purpose: string; trace: Trace }): Promise<Row[]> {
    if (!isPrincipal(ctx.agent)) refuse(ctx.agent, "unknown principal", ctx.trace);
    if (!this.principal) return this.forAgent(ctx.agent).query(sql, ctx);
    if (ctx.agent !== this.principal) refuse(this.principal, "query agent does not match bound principal", ctx.trace);
    checkQuery(this.principal, sql, ctx.trace);
    const principal = principalName(this.principal), t0 = Date.now();
    let r: Result;
    try { r = await this.run(sql); }
    catch (err) {
      const error = redact((err as Error).message);
      if (/denied|permission|not authorized|unauthori[sz]ed|forbidden|privilege|HTTP 403/i.test(error)) refuse(this.principal, error, ctx.trace);
      ctx.trace.emit("sql", ctx.agent, `${ctx.purpose}: Zetaris query failed`, { principal, backend: "zetaris", sql, rows: 0, error }); throw err;
    }
    const rows = r.data.map(values => Object.fromEntries(r.headers.map((h, i) => [h, values[i] == null ? null : String(values[i])])));
    if (this.runDir) record(this.runDir, "sql", { principal, sql }, rows);
    ctx.trace.emit("sql", ctx.agent, `${ctx.purpose}: ${rows.length} rows from Zetaris in ${Date.now() - t0}ms`, { principal, backend: "zetaris", sql, rows: rows.length, sample: rows.slice(0, 3) });
    return rows;
  }
  async close() { this.token = undefined; for (const child of this.children.values()) await child.close(); }
}
