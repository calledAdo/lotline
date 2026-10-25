import type { Trace } from "../trace.ts";

const catalog = ["fda_snapshot.recalls", "fda_snapshot.shortages", "fda_snapshot.ndc_packages", "wholesaler.catalog", "fda_updates.recall_updates"];
export const AGENT_TABLES = {
  cartographer: ["hospital.item_master", ...catalog],
  planner: ["fda_snapshot.recalls", "fda_live_views.recalls"],
  exposure: ["hospital.item_master", "hospital.inventory_lots", "fda_snapshot.ndc_packages", "fda_snapshot.recalls", "fda_updates.recall_updates"],
  supply: ["hospital.inventory_lots", "hospital.dispensing_daily", "hospital.purchase_orders", "fda_snapshot.recalls", "fda_snapshot.ndc_packages", "fda_snapshot.shortages", "fda_live_views.shortages", "wholesaler.catalog"],
  watcher: ["hospital.item_master", "hospital.inventory_lots", "hospital.dispensing_daily", "hospital.purchase_orders", ...catalog, "fda_live_views.shortages"],
} as const;
export type Principal = keyof typeof AGENT_TABLES;
export function isPrincipal(agent: string): agent is Principal { return Object.hasOwn(AGENT_TABLES, agent); }
export const principalName = (agent: Principal) => `lotline_${agent}`;
export class PolicyRefusal extends Error {
  constructor(readonly principal: string, reason: string) { super(`Data access refused for ${principal}: ${reason}`); this.name = "PolicyRefusal"; }
}
export function refuse(agent: string, reason: string, trace?: Trace): never {
  trace?.emit("policy", agent, `Data access refused: ${reason}`, { principal: isPrincipal(agent) ? principalName(agent) : agent, allowed: false, reason });
  throw new PolicyRefusal(agent, reason);
}
export function checkTable(agent: string, table: string, trace?: Trace): asserts agent is Principal {
  if (!isPrincipal(agent) || !(AGENT_TABLES[agent] as readonly string[]).includes(table.toLowerCase())) refuse(agent, `SELECT on ${table}`, trace);
}
/** Conservative grammar for application-generated reads, not a general SQL sandbox.
 * Reject comments, quoted identifiers, table functions, CTEs, comma joins and unknown
 * functions. Every FROM/JOIN is checked, including nested SELECTs and UNIONs. */
export function checkQuery(agent: string, sql: string, trace: Trace) {
  if (!isPrincipal(agent)) refuse(agent, "unknown principal", trace);
  const stripped = sql.replace(/'(?:''|[^'])*'/g, "''");
  if (/[';`"\\]|--|\/\*|\*\//.test(stripped.replaceAll("''", "")) || !/^\s*(SELECT|DESCRIBE)\b/i.test(stripped)) refuse(agent, "only a single generated SELECT or DESCRIBE is permitted", trace);
  if (/^\s*DESCRIBE\s+([\w]+\.[\w]+)\s*$/i.test(stripped)) { checkTable(agent, stripped.trim().split(/\s+/)[1], trace); return; }
  if (/\b(TABLE|PIVOT|UNPIVOT|INTO|COPY|EXPORT|IMPORT|INSTALL|LOAD|ATTACH|DETACH|PRAGMA|CALL|SET|UPDATE|DELETE|INSERT|CREATE|DROP|ALTER|EXECUTE|PREPARE)\b/i.test(stripped)) refuse(agent, "unsupported read syntax", trace);
  const functions = new Set(["cast", "count", "sum", "concat", "lpad", "replace", "split", "split_part", "lower", "upper", "coalesce", "in", "select", "varchar"]);
  for (const m of stripped.matchAll(/\b([a-z_][\w]*)\s*\(/gi)) if (!functions.has(m[1].toLowerCase())) refuse(agent, `unsupported SQL function ${m[1]}`, trace);
  for (const m of stripped.matchAll(/\b(?:FROM|JOIN)\s+([^\s,)]+)/gi)) {
    if (!/^[a-z_]\w*\.[a-z_]\w*$/i.test(m[1])) refuse(agent, "source must be a registered schema.table", trace);
    checkTable(agent, m[1], trace);
  }
  // Commas following FROM at its nesting depth could introduce an unchecked source.
  let depth = 0; const inFrom = new Set<number>();
  for (const token of stripped.match(/\w+|[(),]/g) ?? []) {
    if (token === "(") { depth++; continue; }
    if (token === ")") { inFrom.delete(depth); depth--; continue; }
    if (/^FROM$/i.test(token)) inFrom.add(depth);
    if (/^(WHERE|GROUP|ORDER|HAVING|LIMIT|UNION)$/i.test(token)) inFrom.delete(depth);
    if (token === "," && inFrom.has(depth)) refuse(agent, "comma joins are not permitted", trace);
  }
}
