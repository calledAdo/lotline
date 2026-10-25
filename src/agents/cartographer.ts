// Source Cartographer: discovers how the fragmented sources name the same product.
//
// 1. Reads every registered source's columns from the data layer (Zetaris DESCRIBE).
// 2. Asks the fast lane (Nemotron Lightning) which columns hold product codes and which
//    named transform might align each with the hospital's item master.
// 3. Tests the model's hypotheses AND an exhaustive sweep of transforms with overlap SQL,
//    because a plausible guess is not evidence. Naive joins that match nothing are kept in
//    the record: they are the fragmentation the agent had to overcome.
// 4. Accepts the best transform per source, records each mapping as a claim backed by its
//    measured overlap, and materialises the crosswalk as a view in the data layer.
import { chatJson, LlmUnavailable } from "../llm.ts";
import { NDC_TRANSFORMS, asText, ident, ndcExpr, type NdcTransform } from "../data/dialect.ts";
import { evidence, type RunContext } from "../context.ts";

const AGENT = "cartographer";
const ANCHOR = { table: "hospital.item_master", column: "ndc11", key: "item_id" };

export type ColumnHypothesis = { table: string; column: string; transform: NdcTransform; rationale: string };
export type Probe = { table: string; column: string; transform: NdcTransform; matchedItems: number; totalItems: number; proposedByModel: boolean };
export type Mapping = { table: string; column: string; transform: NdcTransform; matchedItems: number; totalItems: number; claimId: string };
export type Crosswalk = { mappings: Mapping[]; probes: Probe[]; view: string | null; modelUsed: boolean };

const CODE_LIKE = /ndc|code|upc|gtin|item|product|package/i;

function validateHypotheses(tables: Map<string, string[]>) {
  return (v: unknown): ColumnHypothesis[] => {
    const obj = v as { hypotheses?: unknown };
    if (!obj || !Array.isArray(obj.hypotheses)) throw new Error('expected {"hypotheses": [...]}');
    const out: ColumnHypothesis[] = [];
    for (const h of obj.hypotheses as Record<string, unknown>[]) {
      const table = String(h.table ?? ""), column = String(h.column ?? ""), transform = String(h.transform ?? "") as NdcTransform;
      if (!tables.has(table)) throw new Error(`unknown table ${table}`);
      if (!tables.get(table)!.includes(column)) throw new Error(`table ${table} has no column ${column}`);
      if (!NDC_TRANSFORMS.includes(transform)) throw new Error(`unknown transform ${transform}; use one of ${NDC_TRANSFORMS.join(", ")}`);
      out.push({ table, column, transform, rationale: String(h.rationale ?? "").slice(0, 300) });
    }
    return out;
  };
}

export async function discoverCrosswalk(ctx: RunContext): Promise<Crosswalk> {
  ctx.trace.emit("agent-start", AGENT, "mapping product codes across the registered sources");
  const sources = (await ctx.backend.sources()).filter(s => s.table !== ANCHOR.table && !s.table.startsWith("hospital.") && !s.table.startsWith("fda_live_views."));
  const columns = new Map<string, string[]>();
  const samples: Record<string, Record<string, (string | null)[]>> = {};
  for (const s of sources) {
    const described = await ctx.backend.describe(s.table);
    ctx.trace.emit("sql", AGENT, `describe ${s.table}: ${described.length} columns`, { backend: ctx.backend.name, sql: `DESCRIBE ${ident(s.table)}`, rows: described.length });
    const cols = described.map(c => c.name);
    columns.set(s.table, cols);
    const candidates = cols.filter(c => CODE_LIKE.test(c));
    if (candidates.length) {
      const rows = await ctx.backend.query(`SELECT ${candidates.map(ident).join(", ")} FROM ${ident(s.table)} ORDER BY ${candidates.map(c => `${asText(ctx.backend.dialect, ident(c))} ASC NULLS FIRST`).join(", ")} LIMIT 3`, { agent: AGENT, purpose: `sample code columns of ${s.table}`, trace: ctx.trace });
      samples[s.table] = Object.fromEntries(candidates.map(c => [c, rows.map(r => r[c] ?? null)]));
    }
  }
  const anchorRows = await ctx.backend.query(`SELECT ${ANCHOR.column} FROM ${ANCHOR.table} ORDER BY ${ANCHOR.column} LIMIT 3`, { agent: AGENT, purpose: "sample the hospital's own product codes", trace: ctx.trace });

  // The model proposes; measurement decides.
  let hypotheses: ColumnHypothesis[] = [];
  let modelUsed = false;
  try {
    const { value } = await chatJson({
      lane: "fast", reasoning: false, agent: AGENT, purpose: "hypothesise product-code columns and transforms", trace: ctx.trace, runDir: ctx.runDir,
      system: `You are a data engineer mapping product identifiers across disconnected systems. The hospital stores products as ${ANCHOR.table}.${ANCHOR.column}, sample values ${JSON.stringify(anchorRows.map(r => r[ANCHOR.column]))}. For each other source, say which column most likely holds a product code that refers to the same products, and which ONE transform from this list would turn that column's values into the hospital's format: ${NDC_TRANSFORMS.join(", ")}. segments_to_11 pads each hyphen-separated segment (5-4-2); lpad_11 left-pads digits to 11; strip_hyphens removes hyphens. Reply with only JSON: {"hypotheses":[{"table":string,"column":string,"transform":string,"rationale":string}]}.`,
      user: JSON.stringify({ sources: Object.fromEntries([...columns].map(([t, cols]) => [t, { columns: cols, code_like_samples: samples[t] ?? {} }])) }),
      validate: validateHypotheses(columns),
    });
    hypotheses = value;
    modelUsed = true;
  } catch (err) {
    if (!(err instanceof LlmUnavailable)) throw err;
    ctx.trace.emit("fallback", AGENT, `model unavailable (${err.message}); testing every code-like column with every transform instead`);
  }

  // Exhaustive sweep over code-like columns, plus anything the model proposed.
  const total = Number((await ctx.backend.query(`SELECT count(DISTINCT ${ANCHOR.column}) n FROM ${ANCHOR.table}`, { agent: AGENT, purpose: "count hospital products", trace: ctx.trace }))[0]!.n);
  const toTest = new Map<string, { table: string; column: string; transform: NdcTransform; proposed: boolean }>();
  for (const h of hypotheses) toTest.set(`${h.table}|${h.column}|${h.transform}`, { ...h, proposed: true });
  for (const [table, cols] of columns) for (const column of cols.filter(c => /ndc/i.test(c))) for (const transform of NDC_TRANSFORMS) {
    const k = `${table}|${column}|${transform}`;
    if (!toTest.has(k)) toTest.set(k, { table, column, transform, proposed: false });
  }
  const probes: Probe[] = [];
  for (const t of toTest.values()) {
    const sql = `SELECT count(DISTINCT i.${ANCHOR.column}) n FROM ${ANCHOR.table} i JOIN ${ident(t.table)} s ON i.${ANCHOR.column} = ${ndcExpr(ctx.backend.dialect, `s.${ident(t.column)}`, t.transform)}`;
    const n = Number((await ctx.backend.query(sql, { agent: AGENT, purpose: `test ${t.table}.${t.column} via ${t.transform}`, trace: ctx.trace }))[0]!.n);
    probes.push({ table: t.table, column: t.column, transform: t.transform, matchedItems: n, totalItems: total, proposedByModel: t.proposed });
  }

  // Accept the best transform per table (ties go to the simplest transform, in list order).
  const mappings: Mapping[] = [];
  for (const table of columns.keys()) {
    const best = probes.filter(p => p.table === table && p.matchedItems > 0)
      .sort((a, b) => b.matchedItems - a.matchedItems || NDC_TRANSFORMS.indexOf(a.transform) - NDC_TRANSFORMS.indexOf(b.transform))[0];
    const naive = probes.find(p => p.table === table && p.transform === "identity");
    if (!best) {
      ctx.trace.emit("note", AGENT, `${table}: no product-code column aligns with the hospital's codes; not used for product joins`);
      continue;
    }
    for (const h of hypotheses.filter(h => h.table === table && (h.column !== best.column || h.transform !== best.transform))) {
      const measured = probes.find(p => p.table === h.table && p.column === h.column && p.transform === h.transform);
      ctx.trace.emit("critique", AGENT, `model proposed ${h.table}.${h.column} via ${h.transform} (${measured?.matchedItems ?? 0}/${total} matched); measurement chose ${best.column} via ${best.transform} (${best.matchedItems}/${total})`, { hypothesis: h, measured, accepted: best });
    }
    const probeEvidence = [];
    for (const p of probes.filter(p => p.table === table && p.column === best.column)) {
      probeEvidence.push(await evidence(ctx, AGENT, "probe.ndc_overlap", `${p.table}.${p.column}:${p.transform}`, { matched: p.matchedItems, total: p.totalItems }));
    }
    const claim = await ctx.tm.assertClaim({
      key: `mapping:${table}.${best.column}`,
      kind: "code-mapping",
      subject: table,
      statement: `${table}.${best.column} aligns with ${ANCHOR.table}.${ANCHOR.column} via ${best.transform}: ${best.matchedItems}/${total} hospital products matched (naive join: ${naive?.matchedItems ?? 0}).`,
      value: { column: best.column, transform: best.transform, matched: best.matchedItems, total, naiveMatched: naive?.matchedItems ?? 0 },
      confidence: best.matchedItems / total,
      evidence: probeEvidence,
      producedBy: AGENT,
      source: ctx.by(AGENT),
    });
    mappings.push({ table, column: best.column, transform: best.transform, matchedItems: best.matchedItems, totalItems: total, claimId: claim.id });
    ctx.trace.emit("claim", AGENT, claim.statement, { claim: claim.id });
  }

  const view = await materialise(ctx, mappings);
  ctx.trace.emit("agent-end", AGENT, `${mappings.length} sources mapped; crosswalk ${view ?? "kept in memory"}`);
  return { mappings, probes, view, modelUsed };
}

/** Publishes the discovered crosswalk as a view, so people (and later runs) can query it directly. */
async function materialise(ctx: RunContext, mappings: Mapping[]): Promise<string | null> {
  if (!mappings.length) return null;
  const d = ctx.backend.dialect;
  const parts = mappings.map(m => `SELECT i.item_id, '${m.table}' AS source_table, cast(s.${ident(m.column)} as ${d === "spark" ? "string" : "varchar"}) AS source_code FROM ${ANCHOR.table} i JOIN ${ident(m.table)} s ON i.${ANCHOR.column} = ${ndcExpr(d, `s.${ident(m.column)}`, m.transform)}`);
  const body = parts.join(" UNION ALL ");
  try {
    if (d === "spark") {
      await ctx.backend.query(`CREATE SCHEMASTORE CONTAINER lotline_views`, { agent: AGENT, purpose: "ensure the lotline_views container", trace: ctx.trace }).catch(() => undefined);
      await ctx.backend.query(`CREATE OR REPLACE SCHEMASTORE VIEW ndc_crosswalk WITH CONTAINER lotline_views AS ${body}`, { agent: AGENT, purpose: "materialise the discovered crosswalk in Zetaris", trace: ctx.trace });
    } else {
      await ctx.backend.query(`CREATE SCHEMA IF NOT EXISTS lotline_views`, { agent: AGENT, purpose: "ensure the lotline_views schema", trace: ctx.trace });
      await ctx.backend.query(`CREATE OR REPLACE VIEW lotline_views.ndc_crosswalk AS ${body}`, { agent: AGENT, purpose: "materialise the discovered crosswalk locally", trace: ctx.trace });
    }
    return "lotline_views.ndc_crosswalk";
  } catch (err) {
    ctx.trace.emit("error", AGENT, `could not materialise the crosswalk view: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Reuses the crosswalk a previous run discovered, if it still holds: each known mapping is
 * re-measured with one probe, and any change in overlap triggers full rediscovery. The
 * measurement is recorded as fresh evidence, so a drifted mapping shows up as stale.
 */
export async function ensureCrosswalk(ctx: RunContext): Promise<Crosswalk> {
  const known = ctx.tm.claims({ kind: "code-mapping" });
  if (!known.length) return discoverCrosswalk(ctx);
  ctx.trace.emit("agent-start", AGENT, `re-checking ${known.length} mappings discovered in earlier runs`);
  const mappings: Mapping[] = [];
  for (const c of known) {
    const v = c.value as { column: string; transform: NdcTransform; matched: number; total: number };
    const table = c.subject;
    const n = Number((await ctx.backend.query(`SELECT count(DISTINCT i.${ANCHOR.column}) n FROM ${ANCHOR.table} i JOIN ${ident(table)} s ON i.${ANCHOR.column} = ${ndcExpr(ctx.backend.dialect, `s.${ident(v.column)}`, v.transform)}`, { agent: AGENT, purpose: `re-measure ${table}.${v.column} via ${v.transform}`, trace: ctx.trace }))[0]!.n);
    const total = Number((await ctx.backend.query(`SELECT count(DISTINCT ${ANCHOR.column}) n FROM ${ANCHOR.table}`, { agent: AGENT, purpose: "count hospital products", trace: ctx.trace }))[0]!.n);
    await evidence(ctx, AGENT, "probe.ndc_overlap", `${table}.${v.column}:${v.transform}`, { matched: n, total });
    if (n !== v.matched || total !== v.total) {
      ctx.trace.emit("invalidation", AGENT, `${table}.${v.column}: overlap changed from ${v.matched}/${v.total} to ${n}/${total}; rediscovering the crosswalk`);
      return discoverCrosswalk(ctx);
    }
    mappings.push({ table, column: v.column, transform: v.transform, matchedItems: n, totalItems: total, claimId: c.id });
  }
  ctx.trace.emit("agent-end", AGENT, `crosswalk still holds (${mappings.map(m => `${m.table} ${m.matchedItems}/${m.totalItems}`).join(", ")})`);
  return { mappings, probes: [], view: "lotline_views.ndc_crosswalk", modelUsed: false };
}
