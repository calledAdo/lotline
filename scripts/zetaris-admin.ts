// Setup-only transport. Never imported by src/ runtime agents.
import { randomUUID } from "node:crypto";
import { env, need, redact } from "../src/env.ts";
export async function adminSql(sql: string) {
  const response = await fetch(`${need("ZETARIS_REST_URL")}/sql-editor/sqls/run`, {
    method: "POST", headers: { Authorization: `Bearer ${need("ZETARIS_API_KEY")}`, "X-Org-ID": env.ZETARIS_ORG_ID ?? "1", "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
    body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 10000 }), signal: AbortSignal.timeout(120000),
  });
  const body = await response.json() as { headers?: string[]; data?: unknown[][]; msg?: string };
  if (!response.ok) throw new Error(redact(`HTTP ${response.status}: ${body.msg ?? "setup failed"}`).split("\n\tat")[0]);
  return body;
}
