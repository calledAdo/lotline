import { forAgent } from "../context.ts";
// Supply Analyst: what does the quarantine do to our supply, and what can we use instead?
// Supply arithmetic is deterministic. Alternatives are screened by code (ingredient,
// strength, container, volume, recalling firm, repackager, FDA shortage, open recalls,
// wholesaler status, our own stock) and ranked; the fast-lane model independently picks
// a recommendation from the same screened table, and a disagreement goes to the Critic.
import { chatJson, LlmUnavailable } from "../llm.ts";
import { asText, ident, inList, ndcExpr } from "../data/dialect.ts";
import { evidence, type RunContext } from "../context.ts";
import { format11, ndcsInText, normalize, productOf, toNdc11 } from "../ndc.ts";
import { firmCore, REPACKAGER } from "../recall-text.ts";
import { ingredientCore, parseStrength, sameStrength, unitPackage } from "../pharma.ts";
import type { Exposure, Item } from "../domain.ts";
import type { Crosswalk } from "./cartographer.ts";

import { queryEvidence, usageEvidenceRow, directoryEvidenceRow } from "../evidence.ts";
import type { Row } from "../data/backend.ts";

const AGENT = "supply";
const TARGET_DAYS = 14;  // days of supply below which we act

export type AltStatus = "usable" | "caution" | "excluded";
export type Alternative = {
  ndc11: string; ndc: string; labeler: string; brand: string | null; ingredient: string; package: string;
  container: string | null; volumeMl: number | null; status: AltStatus; flags: string[]; score: number;
  fdaShortage: string | null; catalog: { status: string; eta: string | null } | null; onHandUnits: number; ongoingRecalls: string[];
  claimId: string;
};

export type ItemSupply = {
  item_id: string; description: string; unit: string;
  onHand: number; quarantined: number; expiredRecalled: number; usable: number; avgDaily: number;
  daysBefore: number | null; daysAfter: number | null;
  openPOs: { po_number: string; packs: number; expected_on: string }[];
  ownShortage: { availability: string | null; reason: string | null; related: string | null; liveCheck: string } | null;
  locations: { location: string; quarantined: number }[];
  alternatives: Alternative[];
  /** stock we already hold that can replace quarantined units today */
  useNow: { ndc11: string; labeler: string; units: number; flags: string[] } | null;
  /** what to buy: decided by the screened ranking and the model independently */
  recommendation: { ndc11: string | null; method: "agreed" | "rule" | "model" | "critic"; reason: string; disputed: boolean; model: { ndc11: string | null; reason: string } | null };
  claimId: string;
};

const days = (n: number, avg: number) => (avg > 0 ? Math.round((n / avg) * 10) / 10 : null);

// Owning stock and being able to buy it are separate facts. Every recommendation
// boundary, including a senior-model adjudication, must enforce the same condition.
export const isOrderable = (a: Alternative): boolean => a.status !== "excluded" && a.catalog?.status === "Available";

export async function analyseSupply(ctx: RunContext, ex: Exposure, items: Item[], crosswalk: Crosswalk, adjudicated = new Map<string, { ndc11: string | null; reason: string }>()): Promise<ItemSupply[]> {
  ctx = forAgent(ctx, AGENT);
  const d = ctx.backend.dialect;
  const affectedItems = [...new Set(ex.findings.filter(f => f.verdict !== "not_affected").map(f => f.item_id))];
  ctx.trace.emit("agent-start", AGENT, `supply impact for ${affectedItems.length} product(s) under ${ex.recall.recall_number}`);
  if (!affectedItems.length) {
    for (const c of ctx.tm.claims().filter(c => ["supply", "alternative"].includes(c.kind) && c.key.split(":")[1] === ex.recall.recall_number)) await ctx.tm.retractClaim(c.key, "no remaining supply impact", ctx.by(AGENT));
    ctx.trace.emit("agent-end", AGENT, "nothing quarantined; no supply impact"); return []; }

  const q = (sql: string, purpose: string) => ctx.backend.query(sql, { agent: AGENT, purpose, trace: ctx.trace });
  const map = (table: string) => crosswalk.mappings.find(m => m.table === table);
  const pkgMap = map("fda_snapshot.ndc_packages"), shortMap = map("fda_snapshot.shortages"), catMap = map("wholesaler.catalog");

  const lots = await q(`SELECT lot_row_id, item_id, location_code, lot_number, po_number, ${asText(d, "expiry_date")} AS expiry_date, ${asText(d, "qty_units")} AS qty_units FROM hospital.inventory_lots`, "read all lots on hand");
  const since = new Date(Date.parse(ctx.today) - 30 * 86_400_000).toISOString().slice(0, 10);
  const usage = await q(`SELECT item_id, ${asText(d, "sum(units)")} AS units FROM hospital.dispensing_daily WHERE day > cast('${since}' as date) AND day <= cast('${ctx.today}' as date) GROUP BY item_id`, "30-day dispensing by product");
  const pos = await q(`SELECT po_number, item_id, ${asText(d, "packs")} AS packs, ${asText(d, "expected_on")} AS expected_on, status FROM hospital.purchase_orders WHERE status = 'open'`, "open purchase orders");
  const ongoing = await q(`SELECT recall_number, product_description, code_info, recalling_firm FROM fda_snapshot.recalls WHERE status = 'Ongoing'`, "ongoing recalls, to screen alternatives");
  const catalog = catMap ? await q(`SELECT ${ident(catMap.column)} AS ndc_numeric, status, eta FROM wholesaler.catalog`, "wholesaler availability") : [];
  const catByNdc = new Map(catalog.map(c => [normalize(c.ndc_numeric), { status: c.status ?? "", eta: c.eta ?? null }]));
  const recalledProducts = new Map<string, string[]>();
  for (const r of ongoing) for (const n of ndcsInText(`${r.product_description} ${r.code_info ?? ""}`)) {
    const p = productOf(toNdc11(n)!);
    recalledProducts.set(p, [...(recalledProducts.get(p) ?? []), r.recall_number!]);
  }
  const ownedByNdc = new Map(items.map(i => [i.ndc11, i]));

  // Products are independent, so they are analysed concurrently (World Model writes are serialised).
  const results = (await Promise.all(affectedItems.map(async (itemId): Promise<ItemSupply> => {
    const item = items.find(i => i.item_id === itemId)!;
    const deps: string[] = [];
    const remember = async (table: string, sql: string, rows: Row[]) => {
      const id = await queryEvidence(ctx, AGENT, table, sql, rows); deps.push(id); return id;
    };
    const qe = async (sql: string, purpose: string) => {
      const rows = await q(sql, purpose);
      const table = /FROM ([a-z_]+\.[a-z_]+)/i.exec(sql)![1];
      await remember(table, sql, rows); return rows;
    };
    await remember("hospital.inventory_lots", `SELECT lot_row_id, item_id, location_code, lot_number, po_number, ${asText(d, "expiry_date")} AS expiry_date, ${asText(d, "qty_units")} AS qty_units FROM hospital.inventory_lots WHERE item_id = '${itemId}'`, lots.filter(l => l.item_id === itemId));
    await remember("hospital.purchase_orders", `SELECT po_number, item_id, ${asText(d, "packs")} AS packs, ${asText(d, "expected_on")} AS expected_on, status FROM hospital.purchase_orders WHERE status = 'open' AND item_id = '${itemId}'`, pos.filter(p => p.item_id === itemId));
    await remember("fda_snapshot.recalls", `SELECT recall_number, product_description, code_info, recalling_firm FROM fda_snapshot.recalls WHERE status = 'Ongoing'`, ongoing);

    const own = pkgMap ? (await qe(`SELECT package_ndc, molecule_query, active_ingredients, dosage_form, route, package_description, labeler_name FROM fda_snapshot.ndc_packages WHERE ${ndcExpr(d, ident(pkgMap.column), pkgMap.transform)} = '${item.ndc11}'`, `FDA directory entry for ${item.item_id}`))[0] : undefined;

    // --- supply arithmetic ---
    const itemLots = lots.filter(l => l.item_id === itemId);
    const findings = ex.findings.filter(f => f.item_id === itemId);
    const onHand = itemLots.filter(l => l.expiry_date! >= ctx.today).reduce((s, l) => s + Number(l.qty_units), 0);
    const quarantinedFindings = findings.filter(f => f.verdict !== "not_affected");
    const quarantined = quarantinedFindings.filter(f => !f.expired).reduce((s, f) => s + f.lot.qty_units, 0);
    const expiredRecalled = quarantinedFindings.filter(f => f.expired).reduce((s, f) => s + f.lot.qty_units, 0);
    const usable = Math.max(0, onHand - quarantined);
    const avgDaily = Math.round((Number(usage.find(u => u.item_id === itemId)?.units ?? 0) / 30) * 100) / 100;
    const openPOs = pos.filter(p => p.item_id === itemId).map(p => ({ po_number: p.po_number!, packs: Number(p.packs), expected_on: p.expected_on! }));
    const locations = [...new Set(quarantinedFindings.map(f => f.lot.location_code))].map(location => ({ location, quarantined: quarantinedFindings.filter(f => f.lot.location_code === location).reduce((s, f) => s + f.lot.qty_units, 0) }));

    // --- shortage status of our own product (snapshot, then the live API through Zetaris) ---
    let ownShortage: ItemSupply["ownShortage"] = null;
    if (shortMap) {
      const where = `${ndcExpr(d, ident(shortMap.column), shortMap.transform)} IN (${inList([item.ndc11, ...item.unitNdcs])})`;
      const snap = (await qe(`SELECT package_ndc, availability, status, shortage_reason, related_info, update_date FROM fda_snapshot.shortages WHERE ${where}`, `FDA shortage status of ${item.item_id}`))[0];
      const live = (await qe(`SELECT package_ndc, availability, status, shortage_reason, related_info, update_date FROM fda_live_views.shortages WHERE ${where}`, `live FDA shortage status of ${item.item_id}`))[0];
      const label = (a: string | null | undefined) => a ?? "listed, availability not stated";
      const liveCheck = ctx.backend.name === "duckdb" ? `snapshot only; no live freshness check (updated ${snap?.update_date ?? "unknown"})` : !live ? (snap ? "not on today's live list" : "not on the live list") : live.availability === snap?.availability ? `live list agrees (${label(live.availability)}, updated ${live.update_date})` : `live list now says ${label(live.availability)} (snapshot said ${snap ? label(snap.availability) : "nothing"})`;
      if (snap || live) ownShortage = { availability: label(live ? live.availability : snap?.availability), reason: snap?.shortage_reason ?? null, related: snap?.related_info ?? null, liveCheck };

    }

    // --- alternatives ---
    const alternatives: Alternative[] = [];
    const alternativeDeps = new Map<string, string[]>();
    if (own) {
      const ownDirectory = deps.find(id => ctx.tm.evidence(id)?.table === "fda_snapshot.ndc_packages")!;
      const recallScreen = deps.find(id => ctx.tm.evidence(id)?.table === "fda_snapshot.recalls")!;
      const ownIngredient = String(own.active_ingredients);
      const core = ingredientCore(ownIngredient.replace(/ [\d.]+ ?\w+\/.*$/, ""));
      const ownStrength = parseStrength(ownIngredient);
      const ownUnit = unitPackage(own.package_description);
      const ownForm = String(own.dosage_form).split(",")[0];
      const recalledFirm = firmCore(ex.recall.recalling_firm);
      const recalledLabelers = new Set([...ndcsInText(ex.recall.product_description)].map(n => toNdc11(n)!.slice(0, 5)));
      const candidates = await qe(`SELECT package_ndc, molecule_query, labeler_name, brand_name, active_ingredients, ${asText(d, "ingredient_count")} AS ingredient_count, dosage_form, route, package_description, listing_expiration_date FROM fda_snapshot.ndc_packages WHERE molecule_query = '${own.molecule_query}'`, `FDA directory products for ${own.molecule_query}`);
      for (const c of candidates) {
        const ndc11 = toNdc11(c.package_ndc!);
        if (!ndc11 || ndc11 === item.ndc11 || Number(c.ingredient_count) !== 1) continue;
        if (ingredientCore(String(c.active_ingredients).replace(/ [\d.]+ ?\w+\/.*$/, "")) !== core) continue;
        if (String(c.dosage_form).split(",")[0] !== ownForm) continue;
        const strengthOk = sameStrength(ownStrength, parseStrength(String(c.active_ingredients)), core);
        if (!strengthOk) continue; // a different strength is a different product, not a substitute
        const depStart = deps.length;
        const directory = await evidence(ctx, AGENT, "fda_snapshot.ndc_packages", c.package_ndc!, directoryEvidenceRow(c));
        deps.push(directory);
        const unit = unitPackage(c.package_description);
        const flags: string[] = [];
        let status: AltStatus = "usable";
        const caution = (f: string) => { flags.push(f); if (status === "usable") status = "caution"; };
        const exclude = (f: string) => { flags.push(f); status = "excluded"; };
        if (firmCore(c.labeler_name) === recalledFirm || recalledLabelers.has(ndc11.slice(0, 5))) exclude(`same firm or labeler as the recall (${c.labeler_name})`);
        const recalls = recalledProducts.get(productOf(ndc11)) ?? [];
        if (recalls.length) exclude(`under ongoing recall ${recalls.join(", ")}`);
        if (REPACKAGER.test(c.labeler_name ?? "")) caution(`repackager (${c.labeler_name}): source product may be the recalled one`);
        if (ownUnit.volumeMl && unit.volumeMl && ownUnit.volumeMl !== unit.volumeMl) caution(`different unit volume (${unit.volumeMl} mL vs ${ownUnit.volumeMl} mL)`);
        if (ownUnit.container && unit.container && ownUnit.container !== unit.container) caution(`different container (${unit.container} vs ${ownUnit.container})`);
        if (c.listing_expiration_date && String(c.listing_expiration_date) < ctx.today.replaceAll("-", "")) caution("FDA listing has expired");
        let fdaShortage: string | null = null;
        if (shortMap) {
          const units = ndcsInText(c.package_description).map(n => toNdc11(n)!);
          const s = (await qe(`SELECT package_ndc, availability, status, shortage_reason, related_info, update_date FROM fda_snapshot.shortages WHERE ${ndcExpr(d, ident(shortMap.column), shortMap.transform)} IN (${inList([ndc11, ...units])})`, `shortage status of alternative ${c.package_ndc}`))[0];
          fdaShortage = s?.availability ?? null;
          if (fdaShortage === "Unavailable") exclude("FDA shortage list: Unavailable");
          else if (fdaShortage && fdaShortage !== "Available") caution(`FDA shortage list: ${fdaShortage}`);
        }
        if (catMap) {
          const codes = catalog.filter(c => normalize(c.ndc_numeric) === ndc11);
          await remember("wholesaler.catalog", `SELECT ${ident(catMap.column)} AS ndc_numeric, status, eta FROM wholesaler.catalog WHERE ${ndcExpr(d, ident(catMap.column), catMap.transform)} = '${ndc11}'`, codes);
        }
        const cat = catByNdc.get(ndc11) ?? null;
        if (cat && cat.status !== "Available") caution(`wholesaler: ${cat.status}${cat.eta ? ` until ${cat.eta}` : ""}`);
        if (cat && fdaShortage && ((cat.status === "Available") !== (fdaShortage === "Available"))) flags.push(`sources disagree: FDA says ${fdaShortage}, wholesaler says ${cat.status}`);
        const ownedItem = ownedByNdc.get(ndc11);
        const onHandUnits = ownedItem ? lots.filter(l => l.item_id === ownedItem.item_id && l.expiry_date! >= ctx.today).reduce((s, l) => s + Number(l.qty_units), 0) : 0;
        if (ownedItem) await qe(`SELECT lot_row_id, item_id, location_code, lot_number, po_number, ${asText(d, "expiry_date")} AS expiry_date, ${asText(d, "qty_units")} AS qty_units FROM hospital.inventory_lots WHERE item_id = '${ownedItem.item_id}'`, "alternative stock evidence");
        if (!cat && !onHandUnits) caution("not in our wholesaler's catalog");
        const score = (status === "usable" ? 100 : status === "caution" ? 50 : 0) + (onHandUnits > 0 ? 30 : 0) + (cat?.status === "Available" ? 15 : 0) + (fdaShortage === null || fdaShortage === "Available" ? 5 : 0) - flags.length;
        alternativeDeps.set(ndc11, [ownDirectory, recallScreen, ex.recallEvidence, ...deps.slice(depStart)]);
        alternatives.push({ ndc11, ndc: c.package_ndc!, labeler: c.labeler_name!, brand: c.brand_name, ingredient: String(c.active_ingredients), package: String(c.package_description), container: unit.container, volumeMl: unit.volumeMl, status, flags, score, fdaShortage, catalog: cat, onHandUnits, ongoingRecalls: recalls, claimId: "" });
      }
      alternatives.sort((a, b) => b.score - a.score || a.ndc11.localeCompare(b.ndc11));
      alternatives.splice(12); // the screened shortlist; the rest are equivalent duplicates or excluded
      for (const a of alternatives) {

        const claim = await ctx.tm.assertClaim({
          key: `alt:${ex.recall.recall_number}:${itemId}:${a.ndc11}`, kind: "alternative", subject: itemId,
          statement: `${a.labeler} ${format11(a.ndc11)} (${a.container ?? "?"}${a.volumeMl ? ` ${a.volumeMl} mL` : ""}) is ${a.status}${a.flags.length ? `: ${a.flags.join("; ")}` : ""}`,
          value: { status: a.status, flags: a.flags, score: a.score }, confidence: 0.9, evidence: alternativeDeps.get(a.ndc11), producedBy: AGENT, source: ctx.by(AGENT),
        });
        a.claimId = claim.id;
      }
    }

    // --- recommendation: code ranking and the model's independent choice ---
    const needAction = quarantined + expiredRecalled > 0;
    const held = alternatives.filter(a => a.onHandUnits > 0 && a.status !== "excluded").sort((a, b) => b.onHandUnits - a.onHandUnits)[0];
    const useNow = held ? { ndc11: held.ndc11, labeler: held.labeler, units: held.onHandUnits, flags: held.flags.filter(f => !/^wholesaler|^sources disagree|catalog/.test(f)) } : null;
    const ruleChoice = alternatives.filter(isOrderable).sort((a, b) => (a.status === "usable" ? 0 : 1) - (b.status === "usable" ? 0 : 1) || b.score - a.score)[0] ?? null;
    let modelChoice: { ndc11: string | null; reason: string } | null = null;
    if (needAction && alternatives.length) {
      try {
        const { value } = await chatJson({
          lane: "fast", reasoning: false, agent: AGENT, purpose: `choose a substitute for ${itemId}`, trace: ctx.trace, runDir: ctx.runDir,
          system: "You are a hospital pharmacy buyer deciding what to ORDER while a recalled product is quarantined. Choose ONE product to order from the screened list, or null if none is safe and orderable. Never choose an excluded product. Only products our wholesaler lists as Available can be ordered today. Prefer the same container and volume as the recalled product, products FDA does not list as short, and manufacturers over repackagers. Reply with only JSON: {\"ndc\":string|null,\"reason\":string}, where ndc is copied exactly from the list.",
          user: JSON.stringify({
            recalled_product: { item: item.description, ndc: format11(item.ndc11), firm: ex.recall.recalling_firm, recall: ex.recall.recall_number },
            supply: { usable_units_after_quarantine: usable, average_daily_use: avgDaily, days_of_supply_after: days(usable, avgDaily) },
            alternatives: alternatives.map(a => ({ ndc: format11(a.ndc11), labeler: a.labeler, container: a.container, volume_ml: a.volumeMl, status: a.status, flags: a.flags, units_we_hold: a.onHandUnits, wholesaler: a.catalog?.status ?? "not listed", fda_shortage: a.fdaShortage ?? "not listed" })),
          }),
          validate: (v: unknown) => {
            const o = v as { ndc?: unknown; reason?: unknown };
            const ndc = o.ndc === null || o.ndc === undefined || o.ndc === "null" ? null : normalize(String(o.ndc));
            if (ndc && !alternatives.some(a => a.ndc11 === ndc)) throw new Error(`ndc ${o.ndc} is not in the list`);
            return { ndc11: ndc, reason: String(o.reason ?? "").slice(0, 400) };
          },
        });
        modelChoice = value;
      } catch (err) {
        if (!(err instanceof LlmUnavailable)) throw err;
        ctx.trace.emit("fallback", AGENT, `substitute model unavailable (${err.message}); using the screened ranking`);
      }
    }
    const requestedAdj = adjudicated.get(itemId);
    const rejectedAdj = requestedAdj && requestedAdj.ndc11 !== null && !alternatives.some(a => a.ndc11 === requestedAdj.ndc11 && isOrderable(a));
    const adj = rejectedAdj ? undefined : requestedAdj;
    if (rejectedAdj) ctx.trace.emit("critique", AGENT, `rejected order adjudication for ${itemId}: alternative is excluded, absent, or not available from the wholesaler; using the screened ranking`);
    const disputed = !!modelChoice && modelChoice.ndc11 !== (ruleChoice?.ndc11 ?? null);
    const chosen = adj ? adj.ndc11 : modelChoice && !disputed ? modelChoice.ndc11 : ruleChoice?.ndc11 ?? null;
    const chosenAlt = alternatives.find(a => a.ndc11 === chosen);
    const recommendation: ItemSupply["recommendation"] = {
      ndc11: chosen,
      method: adj ? "critic" : rejectedAdj || !modelChoice ? "rule" : disputed ? "rule" : "agreed",
      reason: adj?.reason ?? (disputed ? `disputed: ranking orders ${ruleChoice ? `${ruleChoice.labeler} ${format11(ruleChoice.ndc11)}` : "none"}; model prefers ${modelChoice!.ndc11 ? format11(modelChoice!.ndc11) : "none"} (${modelChoice!.reason})` : chosenAlt ? `${chosenAlt.labeler} ${format11(chosenAlt.ndc11)}: ${chosenAlt.status}${chosenAlt.onHandUnits ? `, ${chosenAlt.onHandUnits} units already on hand` : ""}` : "no usable alternative in the FDA directory"),
      disputed: disputed && !adj,
      model: modelChoice,
    };
    if (recommendation.disputed) ctx.trace.emit("branch", AGENT, `${itemId}: ${recommendation.reason}`);

    const usageEv = await evidence(ctx, AGENT, "hospital.dispensing_daily", `${itemId}:30d:${ctx.today}`, usageEvidenceRow({ units: usage.find(u => u.item_id === itemId)?.units ?? "0" }));
    const claim = await ctx.tm.assertClaim({
      key: `supply:${ex.recall.recall_number}:${itemId}`, kind: "supply", subject: itemId,
      statement: `${item.description}: ${onHand} usable units before quarantine, ${quarantined} quarantined${expiredRecalled ? ` (+${expiredRecalled} expired recalled units)` : ""}, ${usable} left; ${avgDaily}/day means ${days(onHand, avgDaily) ?? "n/a"} -> ${days(usable, avgDaily) ?? "n/a"} days of supply${ownShortage ? `; FDA shortage list: ${ownShortage.availability} (${ownShortage.liveCheck})` : ""}.`,
      value: { onHand, quarantined, expiredRecalled, usable, avgDaily, daysBefore: days(onHand, avgDaily), daysAfter: days(usable, avgDaily), useNow: useNow?.ndc11 ?? null, order: chosen },
      confidence: 0.95, evidence: [usageEv, ...deps], claims: [...crosswalk.mappings.map(m => m.claimId), ...quarantinedFindings.map(f => f.claimId), ...[chosenAlt, held].filter((a): a is Alternative => !!a).map(a => a.claimId)], producedBy: AGENT, source: ctx.by(AGENT),
    });
    ctx.trace.emit("claim", AGENT, claim.statement, { claim: claim.id, recommendation });
    return { item_id: itemId, description: item.description, unit: item.unit_of_issue, onHand, quarantined, expiredRecalled, usable, avgDaily, daysBefore: days(onHand, avgDaily), daysAfter: days(usable, avgDaily), openPOs, ownShortage, locations, alternatives, useNow, recommendation, claimId: claim.id };
  }))).sort((a, b) => a.item_id.localeCompare(b.item_id));
  const active = new Set(results.flatMap(r => [r.claimId, ...r.alternatives.map(a => a.claimId)]));
  for (const c of ctx.tm.claims().filter(c => ["supply", "alternative"].includes(c.kind) && c.key.split(":")[1] === ex.recall.recall_number && !active.has(c.id))) await ctx.tm.retractClaim(c.key, "product no longer in supply review", ctx.by(AGENT));
  ctx.trace.emit("agent-end", AGENT, results.map(r => `${r.item_id}: ${r.daysBefore ?? "n/a"} -> ${r.daysAfter ?? "n/a"} days`).join("; "));
  return results;
}

export { TARGET_DAYS };
