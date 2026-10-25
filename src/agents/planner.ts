import { forAgent } from "../context.ts";
// Planner: which of today's ongoing recalls touch our stock, and in what order do we work
// them? Code screens every ongoing recall (from the live openFDA feed through Zetaris, or
// the snapshot offline) against our item master by NDC, package hierarchy and product name.
// The fast lane (Nemotron Lightning) then triages the candidates: relevant or not, and how
// urgent, with a reason. A candidate the model drops is still listed, so nothing vanishes.
import { chatJson, LlmUnavailable } from "../llm.ts";
import type { RunContext } from "../context.ts";
import { ndcsInText, productOf, toNdc11 } from "../ndc.ts";
import type { Item } from "../domain.ts";

const AGENT = "planner";

export type Candidate = {
  recall_number: string; classification: string; firm: string; product: string; reason: string; report_date: string;
  match: "exact-ndc" | "product-code" | "name-only"; matchedItems: string[];
};
export type TriageEntry = Candidate & { relevant: "yes" | "no" | "maybe"; urgency: "now" | "today" | "this week"; why: string; by: "model" | "rule" };

export async function triage(ctx: RunContext, items: Item[]): Promise<TriageEntry[]> {
  ctx = forAgent(ctx, AGENT);
  ctx.trace.emit("agent-start", AGENT, "screening today's ongoing recalls against our stock");
  const live = ctx.backend.name === "zetaris";
  const rows = await ctx.backend.query(
    `SELECT recall_number, classification, recalling_firm, product_description, code_info, reason_for_recall, report_date FROM ${live ? "fda_live_views.recalls" : "fda_snapshot.recalls WHERE status = 'Ongoing'"}`,
    { agent: AGENT, purpose: live ? "read ongoing recalls from the live openFDA feed" : "read ongoing recalls from the snapshot", trace: ctx.trace },
  );
  const codes = new Map<string, string[]>(); // ndc11 or product code -> item ids
  for (const i of items) for (const c of [i.ndc11, ...i.unitNdcs]) {
    codes.set(c, [...(codes.get(c) ?? []), i.item_id]);
    codes.set(productOf(c), [...(codes.get(productOf(c)) ?? []), i.item_id]);
  }
  const candidates: Candidate[] = [];
  for (const r of rows) {
    const text = `${r.product_description} ${r.code_info ?? ""}`;
    const ndcs = ndcsInText(text).map(n => toNdc11(n)!);
    const exact = [...new Set(ndcs.flatMap(n => codes.get(n) ?? []))];
    const product = [...new Set(ndcs.flatMap(n => codes.get(productOf(n)) ?? []))];
    const names = items.filter(i => new RegExp(`\\b${i.generic_name.split(" ")[0]}\\b`, "i").test(r.product_description!)).map(i => i.item_id);
    const match: Candidate["match"] | null = exact.length ? "exact-ndc" : product.length ? "product-code" : names.length ? "name-only" : null;
    if (!match) continue;
    candidates.push({ recall_number: r.recall_number!, classification: r.classification!, firm: r.recalling_firm!, product: r.product_description!.slice(0, 300), reason: r.reason_for_recall!.slice(0, 200), report_date: r.report_date!, match, matchedItems: [...new Set(exact.length ? exact : product.length ? product : names)] });
  }
  ctx.trace.emit("note", AGENT, `${rows.length} ongoing recalls screened: ${candidates.filter(c => c.match === "exact-ndc").length} name one of our NDCs, ${candidates.filter(c => c.match === "product-code").length} share a product code, ${candidates.filter(c => c.match === "name-only").length} mention one of our molecules by name only`);

  const ruleUrgency = (c: Candidate) => (c.classification === "Class I" ? "now" : c.match === "exact-ndc" ? "today" : "this week") as TriageEntry["urgency"];
  const rule = (c: Candidate): TriageEntry => ({ ...c, relevant: c.match === "exact-ndc" ? "yes" : "maybe", urgency: ruleUrgency(c), why: c.match === "exact-ndc" ? "the recall names an NDC we stock" : c.match === "product-code" ? "same product code as one we stock, different package" : "mentions a molecule we stock, no NDC match", by: "rule" });

  let out: TriageEntry[] = candidates.map(rule);
  // The model sees every code match, plus the most recent name-only mentions (capped):
  // name-only candidates are mostly combination products, and 60 of them make a slow prompt.
  const forModel = [...candidates.filter(c => c.match !== "name-only"), ...candidates.filter(c => c.match === "name-only").sort((a, b) => b.report_date.localeCompare(a.report_date)).slice(0, 12)];
  if (forModel.length) {
    try {
      const { value } = await chatJson({
        lane: "fast", reasoning: false, agent: AGENT, purpose: `triage ${forModel.length} of ${candidates.length} candidate recalls`, trace: ctx.trace, runDir: ctx.runDir,
        system: 'You are the pharmacy buyer triaging FDA recalls against the hospital\'s stock. For each candidate recall decide whether it is relevant to the products we stock (yes, no, maybe) and how urgently to work it (now, today, this week). A recall is relevant only if it covers a product we stock in the same presentation; compounded or combination products made by outsourcing facilities are different products unless we stock them. Class I and emergency drugs are most urgent. Reply with only JSON: {"recalls":[{"recall_number":string,"relevant":"yes"|"no"|"maybe","urgency":"now"|"today"|"this week","why":string}]}',
        user: JSON.stringify({ our_products: items.map(i => ({ item_id: i.item_id, description: i.description, manufacturer: i.manufacturer })), candidates: forModel.map(c => ({ recall_number: c.recall_number, classification: c.classification, firm: c.firm, product: c.product.slice(0, 200), match: c.match })) }),
        validate: (v: unknown) => {
          const arr = (v as { recalls?: unknown }).recalls;
          if (!Array.isArray(arr)) throw new Error('expected {"recalls":[...]}');
          const m = new Map<string, { relevant: TriageEntry["relevant"]; urgency: TriageEntry["urgency"]; why: string }>();
          for (const x of arr as Record<string, unknown>[]) {
            if (!forModel.some(c => c.recall_number === x.recall_number)) throw new Error(`unknown recall ${x.recall_number}`);
            if (!["yes", "no", "maybe"].includes(String(x.relevant))) throw new Error(`relevant must be yes, no or maybe`);
            if (!["now", "today", "this week"].includes(String(x.urgency))) throw new Error(`urgency must be now, today or this week`);
            m.set(String(x.recall_number), { relevant: x.relevant as any, urgency: x.urgency as any, why: String(x.why ?? "").slice(0, 300) });
          }
          return m;
        },
      });
      out = candidates.map(c => {
        const m = value.get(c.recall_number);
        if (!m) return rule(c);
        // An exact NDC match is never dropped on the model's say-so: it is kept as "maybe".
        const relevant = c.match === "exact-ndc" && m.relevant === "no" ? "maybe" : m.relevant;
        return { ...c, relevant, urgency: c.classification === "Class I" ? "now" : m.urgency, why: m.why, by: "model" as const };
      });
    } catch (err) {
      if (!(err instanceof LlmUnavailable)) throw err;
      ctx.trace.emit("fallback", AGENT, `triage model unavailable (${err.message}); using the code screen`);
    }
  }
  const rank = { now: 0, today: 1, "this week": 2 };
  const relRank = { yes: 0, maybe: 1, no: 2 };
  out.sort((a, b) => relRank[a.relevant] - relRank[b.relevant] || rank[a.urgency] - rank[b.urgency] || b.report_date.localeCompare(a.report_date));
  for (const t of out) ctx.trace.emit(t.relevant === "no" ? "note" : "decision", AGENT, `${t.recall_number} ${t.classification} ${t.firm}: relevant=${t.relevant}, urgency=${t.urgency} (${t.by}: ${t.why})`);
  ctx.trace.emit("agent-end", AGENT, `${out.filter(t => t.relevant === "yes").length} relevant, ${out.filter(t => t.relevant === "maybe").length} to check, ${out.filter(t => t.relevant === "no").length} dismissed`);
  return out;
}
