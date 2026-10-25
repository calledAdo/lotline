import { forAgent } from "../context.ts";
// Exposure Investigator: which of our products does this recall cover, and which lots,
// where? Two independent readings of coverage are taken: the fast-lane model reads the
// recall the way a pharmacist would, and code matches the recall's NDCs against our item
// master, including the carton-to-unit package relationships from the FDA NDC directory.
// Agreement is high confidence; disagreement is marked disputed for the Critic. Lot
// matching itself is exact and deterministic: a model never decides two lot numbers match.
import { chatJson, LlmUnavailable } from "../llm.ts";
import { asText, ident, inList, ndcExpr, type NdcTransform } from "../data/dialect.ts";
import { evidence, type RunContext } from "../context.ts";
import { format11, ndcsInText, normalize, toNdc11 } from "../ndc.ts";
import { editDistance, expiryLabel, lotInText, parseExpiry, readLots, sameMonth, strengthInconsistencies, type LotConstraint } from "../recall-text.ts";
import type { Coverage, CoverageDecision, Exposure, Item, LotFinding, LotRow, Recall } from "../domain.ts";
import type { Crosswalk } from "./cartographer.ts";

import { itemEvidenceRow, lotEvidenceRow, queryEvidence } from "../evidence.ts";

const AGENT = "exposure";

/** The recall as it stands now: the FDA record, overlaid with the latest revision in the change feed. */
export async function loadRecall(ctx: RunContext, recallNumber: string, agent = AGENT): Promise<Recall | null> {
  ctx = forAgent(ctx, agent);
  const rn = recallNumber.replace(/[^A-Za-z0-9-]/g, "");
  const cols = "recall_number, status, classification, recalling_firm, reason_for_recall, product_description, code_info, report_date, openfda_package_ndc, text_ndcs";
  const rows = await ctx.backend.query(`SELECT ${cols} FROM fda_snapshot.recalls WHERE recall_number = '${rn}'`, { agent, purpose: `read recall ${recallNumber}`, trace: ctx.trace });
  const base = (rows[0] as unknown as Recall) ?? null;
  if (!base) return null;
  const d = ctx.backend.dialect;
  const updates = await ctx.backend.query(`SELECT ${asText(d, "update_seq")} AS update_seq, update_date, update_kind, product_description, code_info, classification, status, ${asText(d, "drill")} AS drill, note FROM fda_updates.recall_updates WHERE recall_number = '${rn}'`, { agent, purpose: `check the change feed for revisions to ${recallNumber}`, trace: ctx.trace });
  const latest = updates.sort((a, b) => Number(b.update_seq) - Number(a.update_seq))[0];
  if (!latest) return base;
  const label = `revision ${latest.update_seq} (${latest.update_kind}, ${latest.update_date})${latest.drill === "true" ? " DRILL" : ""}`;
  ctx.trace.emit("note", AGENT, `${recallNumber} has ${label}: ${latest.note ?? ""}`);
  return { ...base, product_description: latest.product_description ?? base.product_description, code_info: latest.code_info ?? base.code_info, classification: latest.classification || base.classification, status: latest.status || base.status, updated_from: label };
}

/** The recall fields an exposure claim depends on. Shared with the watcher, so both hash the same thing. */
export const recallEvidenceRow = (r: Recall) => ({ product_description: r.product_description, code_info: r.code_info, classification: r.classification, status: r.status, recalling_firm: r.recalling_firm, openfda_package_ndc: r.openfda_package_ndc, reason_for_recall: r.reason_for_recall, report_date: r.report_date });

export async function loadItems(ctx: RunContext, crosswalk: Crosswalk): Promise<Item[]> {
  ctx = forAgent(ctx, AGENT);
  const items = await ctx.backend.query(`SELECT item_id, ndc11, description, generic_name, strength, dosage_form, route, manufacturer, unit_of_issue, units_per_pack FROM hospital.item_master`, { agent: AGENT, purpose: "read the hospital item master", trace: ctx.trace });
  const pkgMap = crosswalk.mappings.find(m => m.table === "fda_snapshot.ndc_packages");
  const packages = pkgMap
    ? await ctx.backend.query(`SELECT package_ndc, package_description FROM fda_snapshot.ndc_packages WHERE ${ndcExpr(ctx.backend.dialect, ident(pkgMap.column), pkgMap.transform)} IN (${inList(items.map(i => i.ndc11!))})`, { agent: AGENT, purpose: "read package hierarchy (carton -> unit NDCs) via the discovered crosswalk", trace: ctx.trace })
    : [];
  const byNdc = new Map(packages.map(p => [toNdc11(p.package_ndc!)!, p]));
  return items.map(i => {
    const p = byNdc.get(i.ndc11!);
    const units = ndcsInText(p?.package_description).map(n => toNdc11(n)!).filter(n => n !== i.ndc11);
    return { ...(i as any), units_per_pack: Number(i.units_per_pack), unitNdcs: [...new Set(units)], packageDescription: p?.package_description ?? null } as Item;
  });
}

function splitNdcs(list: string | null): string[] {
  return (list ?? "").split(";").map(s => normalize(s.trim())).filter((n): n is string => !!n);
}

/** Coverage by code: the recall text's NDCs are authoritative; openFDA's harmonised list is the whole product family. */
function ruleCoverage(item: Item, textNdcs: Set<string>, familyNdcs: Set<string>, recall: Recall): { decision: CoverageDecision; reason: string } {
  const codes = [item.ndc11, ...item.unitNdcs];
  const hit = codes.find(c => textNdcs.has(c));
  if (hit) return { decision: "covered", reason: `recall text names ${format11(hit)}${hit === item.ndc11 ? " (our package)" : ` (a unit inside our package ${format11(item.ndc11)})`}` };
  if (textNdcs.size > 0) {
    if (codes.some(c => familyNdcs.has(c))) return { decision: "not_covered", reason: `openFDA lists ${format11(item.ndc11)} in the product family, but the recall text names only ${[...textNdcs].map(format11).join(", ")}` };
    return { decision: "not_covered", reason: "the recall text names other NDCs" };
  }
  if (codes.some(c => familyNdcs.has(c))) return { decision: "uncertain", reason: "the recall text has no NDC; openFDA's product-family list includes this package" };
  const generic = item.generic_name.split(" ")[0]!;
  if (new RegExp(`\\b${generic}`, "i").test(recall.product_description)) return { decision: "uncertain", reason: `the recall text has no NDC but mentions ${generic}` };
  return { decision: "not_covered", reason: "no NDC or product match" };
}

function validateCoverage(candidates: Item[]) {
  const ids = new Set(candidates.map(c => c.item_id));
  return (v: unknown) => {
    const arr = (v as { items?: unknown }).items;
    if (!Array.isArray(arr)) throw new Error('expected {"items":[...]}');
    const out = new Map<string, { decision: CoverageDecision; reason: string }>();
    for (const x of arr as Record<string, unknown>[]) {
      const id = String(x.item_id), decision = String(x.decision) as CoverageDecision;
      if (!ids.has(id)) throw new Error(`unknown item_id ${id}`);
      if (!["covered", "not_covered", "uncertain"].includes(decision)) throw new Error(`decision must be covered, not_covered or uncertain (got ${decision})`);
      out.set(id, { decision, reason: String(x.reason ?? "").slice(0, 400) });
    }
    for (const id of ids) if (!out.has(id)) throw new Error(`missing decision for ${id}`);
    return out;
  };
}

function validateLots(codeInfo: string) {
  return (v: unknown) => {
    const o = v as { lots?: unknown; expiry_only?: unknown };
    if (!Array.isArray(o.lots)) throw new Error('expected {"lots":[...]}');
    return {
      lots: (o.lots as Record<string, unknown>[]).map(l => ({ lot: String(l.lot ?? "").trim(), expiryText: l.expiry === null || l.expiry === undefined ? null : String(l.expiry) })),
      expiryOnly: o.expiry_only === true,
      codeInfo,
    };
  };
}

/**
 * @param adjudications coverage decisions made by the Critic in an earlier round
 * @param lotOverrides lots the Critic objected to; they become "review" (quarantine pending a
 *   physical check). The Critic can only make a lot outcome more conservative, never less.
 */
export async function investigate(ctx: RunContext, recall: Recall, items: Item[], adjudications: Map<string, { decision: CoverageDecision; reason: string }> = new Map(), lotOverrides: Map<string, string> = new Map()): Promise<Exposure> {
  ctx = forAgent(ctx, AGENT);
  ctx.trace.emit("agent-start", AGENT, `investigating ${recall.recall_number} (${recall.classification}, ${recall.recalling_firm})`);
  const recallEvidence = await evidence(ctx, AGENT, "fda_snapshot.recalls", recall.recall_number, recallEvidenceRow(recall));
  const dataIssues = strengthInconsistencies(recall.product_description).map(s => `FDA recall text is internally inconsistent: "${s.statement}" (${s.computed} mg/mL by arithmetic, ${s.stated} mg/mL stated)`);
  for (const d of dataIssues) ctx.trace.emit("note", AGENT, d);

  // --- Coverage: two independent readings ---
  const textNdcs = new Set(ndcsInText(`${recall.product_description} ${recall.code_info ?? ""}`).map(n => toNdc11(n)!));
  const familyNdcs = new Set(splitNdcs(recall.openfda_package_ndc));
  const generic = (recall.product_description.match(/[A-Za-z]+/g) ?? []).map(w => w.toLowerCase());
  const candidates = items.filter(i =>
    [i.ndc11, ...i.unitNdcs].some(c => textNdcs.has(c) || familyNdcs.has(c)) || generic.includes(i.generic_name.split(" ")[0]!.toLowerCase()));
  const rules = new Map(candidates.map(i => [i.item_id, ruleCoverage(i, textNdcs, familyNdcs, recall)]));

  let model: Map<string, { decision: CoverageDecision; reason: string }> | null = null;
  if (candidates.length) {
    try {
      const { value } = await chatJson({
        lane: "fast", reasoning: false, agent: AGENT, purpose: `decide which stocked products ${recall.recall_number} covers`, trace: ctx.trace, runDir: ctx.runDir,
        system: "You are a hospital pharmacy buyer reading an FDA drug recall. For each of our stocked products, decide whether the recall covers it: covered, not_covered or uncertain. A recall covers a product only if it is the same product and presentation the recall describes (same NDC, or a unit inside our carton, or the carton containing the recalled unit). A different strength, volume or container is not covered even from the same manufacturer. openFDA's harmonised NDC list for a recall often lists the whole product family; the recall's own text is authoritative. Reply with only JSON: {\"items\":[{\"item_id\":string,\"decision\":\"covered\"|\"not_covered\"|\"uncertain\",\"reason\":string}]}.",
        user: JSON.stringify({
          recall: { number: recall.recall_number, firm: recall.recalling_firm, product_description: recall.product_description, ndcs_in_recall_text: [...textNdcs].map(format11), openfda_family_ndc_count: familyNdcs.size },
          our_products: candidates.map(i => ({ item_id: i.item_id, description: i.description, ndc: format11(i.ndc11), unit_ndcs: i.unitNdcs.map(format11), package: i.packageDescription, strength: i.strength, manufacturer: i.manufacturer, in_openfda_family: [i.ndc11, ...i.unitNdcs].some(c => familyNdcs.has(c)) })),
        }),
        validate: validateCoverage(candidates),
      });
      model = value;
    } catch (err) {
      if (!(err instanceof LlmUnavailable)) throw err;
      ctx.trace.emit("fallback", AGENT, `coverage model unavailable (${err.message}); using the NDC rule alone`);
    }
  }

  const itemEvidence = new Map<string, string>();
  for (const i of candidates) itemEvidence.set(i.item_id, await evidence(ctx, AGENT, "hospital.item_master", i.item_id, itemEvidenceRow(i as unknown as Record<string, unknown>)));

  const packageMapping = ctx.tm.claims({ kind: "code-mapping", subject: "fda_snapshot.ndc_packages" })[0]?.value as { column: string; transform: NdcTransform } | undefined;
  const packageCode = ndcExpr(ctx.backend.dialect, ident(packageMapping?.column ?? "package_ndc"), packageMapping?.transform ?? "segments_to_11");

  // Enumeration evidence covers new items/packages/lots as well as deleted rows.
  const scopeEvidence: string[] = [];
  for (const table of ["hospital.item_master", "fda_snapshot.ndc_packages", "hospital.inventory_lots"]) {
    const sql = table === "fda_snapshot.ndc_packages"
      ? `SELECT package_ndc, package_description FROM ${table} WHERE ${packageCode} IN (${inList(items.map(i => i.ndc11))})`
      : table === "hospital.item_master" ? `SELECT item_id, ndc11, generic_name FROM ${table}` : `SELECT lot_row_id, item_id, lot_number FROM ${table}`;
    const rows = await ctx.backend.query(sql, { agent: AGENT, purpose: "observe case input membership", trace: ctx.trace });
    // Item/package membership decides which products qualify as candidates; inventory
    // membership is narrowed to candidate items or explicitly named recall lots.
    const filteredSql = table === "hospital.inventory_lots"
      ? `${sql} WHERE item_id IN (${inList(candidates.map(i => i.item_id))}) OR lot_number IN (${inList(readLots(recall.code_info ?? "").map(l => l.lot))})`
      : sql;
    const selected = table === "hospital.inventory_lots" ? rows.filter(r => candidates.some(i => i.item_id === r.item_id) || readLots(recall.code_info ?? "").some(l => l.lot === r.lot_number)) : rows;
    scopeEvidence.push(await queryEvidence(ctx, AGENT, table, filteredSql, selected));
  }
  await ctx.tm.assertClaim({
    key: `inputs:${recall.recall_number}`, kind: "case-inputs", subject: recall.recall_number,
    statement: `Candidate product and lot membership for ${recall.recall_number}`,
    evidence: scopeEvidence, confidence: 1, producedBy: AGENT, source: ctx.by(AGENT),
  });
  const coverage: Coverage[] = [];
  for (const i of candidates) {
    const packageSql = `SELECT package_ndc, package_description FROM fda_snapshot.ndc_packages WHERE ${packageCode} = '${i.ndc11}'`;
    const packageRows = await ctx.backend.query(packageSql, { agent: AGENT, purpose: "observe product package hierarchy", trace: ctx.trace });
    const packageEvidence = await queryEvidence(ctx, AGENT, "fda_snapshot.ndc_packages", packageSql, packageRows);
    const rule = rules.get(i.item_id)!;
    const m = model?.get(i.item_id) ?? null;
    const adjudicated = adjudications.get(i.item_id);
    const disputed = !!m && m.decision !== rule.decision;
    const decision = adjudicated?.decision ?? (m && !disputed ? m.decision : rule.decision);
    const method: Coverage["method"] = adjudicated ? "critic" : !m ? "rule" : disputed ? "rule" : "agreed";
    const reason = adjudicated?.reason ?? (disputed ? `disputed: code says ${rule.decision} (${rule.reason}); model says ${m!.decision} (${m!.reason})` : rule.reason);
    const claim = await ctx.tm.assertClaim({
      key: `coverage:${recall.recall_number}:${i.item_id}`, kind: "coverage", subject: i.item_id,
      statement: `${recall.recall_number} ${decision === "covered" ? "covers" : decision === "not_covered" ? "does not cover" : "may cover"} ${i.description}: ${reason}`,
      value: { decision, method, disputed: disputed && !adjudicated }, confidence: method === "agreed" ? 0.97 : method === "critic" ? 0.9 : disputed ? 0.5 : 0.85,
      evidence: [recallEvidence, itemEvidence.get(i.item_id)!, packageEvidence], claims: ctx.tm.claims({ kind: "code-mapping", subject: "fda_snapshot.ndc_packages" }).map(c => c.id), producedBy: AGENT, source: ctx.by(AGENT),
    });
    coverage.push({ item_id: i.item_id, decision, reason, method, rule, model: m, disputed: disputed && !adjudicated, claimId: claim.id });
    ctx.trace.emit(disputed && !adjudicated ? "branch" : "claim", AGENT, claim.statement, { claim: claim.id, rule, model: m });
  }

  // --- Lot constraints: model reading, verified against the literal text ---
  const codeInfo = recall.code_info ?? "";
  let constraints: LotConstraint[] = readLots(codeInfo);
  let parseMethod: Exposure["parseMethod"] = "fallback";
  try {
    const { value } = await chatJson({
      lane: "fast", reasoning: false, agent: AGENT, purpose: `read lot constraints from ${recall.recall_number}`, trace: ctx.trace, runDir: ctx.runDir,
      system: 'You extract recall lot constraints. Reply with ONLY a JSON object: {"lots":[{"lot":string,"expiry":"YYYY-MM"|"YYYY-MM-DD"|null}],"expiry_only":boolean}. Copy lot strings exactly as written. A lot listed before a shared expiry gets that expiry. expiry_only is true when the recall names expiry dates but no lot numbers.',
      user: `code_info: ${codeInfo}`,
      validate: validateLots(codeInfo),
    });
    const kept: LotConstraint[] = [];
    for (const l of value.lots) {
      if (!lotInText(l.lot, codeInfo)) { ctx.trace.emit("critique", AGENT, `dropped model lot "${l.lot}": it does not appear in the recall text`); continue; }
      kept.push({ lot: l.lot, expiry: l.expiryText ? parseExpiry(l.expiryText) : null });
    }
    const missed = constraints.filter(f => !kept.some(k => k.lot.toLowerCase() === f.lot.toLowerCase()));
    for (const f of missed) ctx.trace.emit("critique", AGENT, `model reading missed lot-like token "${f.lot}" that the text reader found; keeping it`);
    constraints = [...kept, ...missed];
    parseMethod = "model";
  } catch (err) {
    if (!(err instanceof LlmUnavailable)) throw err;
    ctx.trace.emit("fallback", AGENT, `lot reading model unavailable (${err.message}); using the deterministic text reader`);
  }
  const parseClaim = await ctx.tm.assertClaim({
    key: `lots:${recall.recall_number}`, kind: "lot-constraints", subject: recall.recall_number,
    statement: `${recall.recall_number} recalls ${constraints.length ? constraints.map(c => `${c.lot}${c.expiry ? ` (exp ${expiryLabel(c.expiry)})` : ""}`).join(", ") : "no specific lots"}`,
    value: constraints.map(c => ({ lot: c.lot, expiry: expiryLabel(c.expiry) })), confidence: parseMethod === "model" ? 0.95 : 0.85,
    evidence: [recallEvidence], producedBy: AGENT, source: ctx.by(AGENT),
  });
  ctx.trace.emit("claim", AGENT, parseClaim.statement, { claim: parseClaim.id, method: parseMethod });

  // --- Lots on hand: exact matching ---
  const coveredIds = coverage.filter(c => c.decision !== "not_covered").map(c => c.item_id);
  const lotStrings = constraints.map(c => c.lot);
  const d = ctx.backend.dialect;
  const lots = (await ctx.backend.query(
    `SELECT ${asText(d, "lot_row_id")} AS lot_row_id, item_id, location_code, lot_number, ${asText(d, "expiry_date")} AS expiry_date, ${asText(d, "qty_units")} AS qty_units, po_number FROM hospital.inventory_lots WHERE item_id IN (${inList(candidates.map(c => c.item_id))}) OR lot_number IN (${inList(lotStrings)})`,
    { agent: AGENT, purpose: "read lots on hand for candidate products and recalled lot numbers", trace: ctx.trace },
  )).map(r => ({ ...r, qty_units: Number(r.qty_units) }) as unknown as LotRow);

  const findings: LotFinding[] = [];
  for (const lot of lots) {
    const cov = coverage.find(c => c.item_id === lot.item_id);
    const match = constraints.find(c => c.lot.toLowerCase() === lot.lot_number.trim().toLowerCase());
    const expired = lot.expiry_date < ctx.today;
    const near = !match ? constraints.find(c => editDistance(c.lot, lot.lot_number) === 1)?.lot ?? null : null;
    let verdict: LotFinding["verdict"]; let reason: string;
    if (!cov || cov.decision === "not_covered") {
      if (!match) continue; // unrelated product, unrelated lot: nothing to say
      verdict = "not_affected"; reason = `same lot string as the recall, but ${cov ? cov.reason : "a product the recall does not cover"}`;
    } else if (match) {
      if (cov.decision === "uncertain") { verdict = "review"; reason = `lot ${lot.lot_number} is recalled, but whether the recall covers this product is uncertain`; }
      else if (!match.expiry || sameMonth(match.expiry, lot.expiry_date)) { verdict = "affected"; reason = `lot ${lot.lot_number}${match.expiry ? ` and expiry ${lot.expiry_date.slice(0, 7)}` : ""} match the recall`; }
      else { verdict = "review"; reason = `lot ${lot.lot_number} matches but our recorded expiry ${lot.expiry_date.slice(0, 7)} differs from the recall's ${expiryLabel(match.expiry)}: quarantine and check the physical label`; }
    } else if (constraints.length === 0 && cov.decision === "covered") {
      verdict = "review"; reason = "the recall names no lots; every lot of a covered product needs checking";
    } else {
      verdict = "not_affected"; reason = near ? `lot ${lot.lot_number} is not recalled (near miss: recall names ${near})` : `lot ${lot.lot_number} is not among the recalled lots`;
    }
    const override = lotOverrides.get(lot.lot_row_id);
    if (override && verdict !== "review") { reason = `critic: ${override} (was ${verdict.replace("_", " ")}: ${reason})`; verdict = "review"; }
    const lotEv = await evidence(ctx, AGENT, "hospital.inventory_lots", lot.lot_row_id, lotEvidenceRow(lot as unknown as Record<string, unknown>));
    const claim = await ctx.tm.assertClaim({
      key: `lot:${recall.recall_number}:${lot.lot_row_id}`, kind: "lot-verdict", subject: lot.lot_row_id,
      statement: `${lot.location_code} lot ${lot.lot_number} (${lot.qty_units} ${lot.item_id}): ${verdict.replace("_", " ")}. ${reason}${expired && verdict !== "not_affected" ? " Already past expiry: it should not be on the shelf at all." : ""}`,
      value: { verdict, qty: lot.qty_units, location: lot.location_code, expired, nearMiss: near },
      confidence: verdict === "review" ? 0.6 : 0.97,
      evidence: [recallEvidence, lotEv], claims: [parseClaim.id, ...(cov ? [cov.claimId] : [])], producedBy: AGENT, source: ctx.by(AGENT),
    });
    findings.push({ lot, item_id: lot.item_id, verdict, reason, expired, nearMiss: near, claimId: claim.id });
    ctx.trace.emit("claim", AGENT, claim.statement, { claim: claim.id });
  }
  const active = new Set([...coverage.map(c => c.claimId), ...findings.map(f => f.claimId)]);
  for (const c of ctx.tm.claims().filter(c => ["coverage", "lot-verdict"].includes(c.kind) && c.key.split(":")[1] === recall.recall_number && !active.has(c.id))) await ctx.tm.retractClaim(c.key, "source row or candidate removed", ctx.by(AGENT));
  ctx.trace.emit("agent-end", AGENT, `${findings.filter(f => f.verdict === "affected").length} affected, ${findings.filter(f => f.verdict === "review").length} to review, ${findings.filter(f => f.verdict === "not_affected").length} cleared`);
  return { recall, recallEvidence, constraints, parseClaim: parseClaim.id, parseMethod, coverage, findings, dataIssues };
}
