// The action policy: turns findings into the buyer's checklist. Deterministic and explicit,
// so every action can be traced to the claims behind it and nothing is left to tone.
import { format11 } from "./ndc.ts";
import type { Exposure } from "./domain.ts";
import { isOrderable, type ItemSupply } from "./agents/supply.ts";
import type { CriticReview } from "./agents/critic.ts";

export const TARGET_DAYS = 14;

export type Priority = "now" | "today" | "this week";
export type Action = { priority: Priority; kind: string; item_id: string | null; text: string; claims: string[] };
export type ItemDecision = { item_id: string; description: string; decision: "substitute" | "reorder" | "escalate" | "monitor" | "no action"; why: string };

export function decide(ex: Exposure, supply: ItemSupply[], critic: CriticReview): { actions: Action[]; decisions: ItemDecision[] } {
  const actions: Action[] = [];
  const add = (a: Action) => actions.push(a);
  const byItem = new Map<string, typeof ex.findings>();
  for (const f of ex.findings.filter(f => f.verdict !== "not_affected")) byItem.set(f.item_id, [...(byItem.get(f.item_id) ?? []), f]);

  for (const [itemId, fs] of byItem) {
    for (const f of fs.filter(f => f.verdict === "affected" && !f.expired)) add({ priority: ex.recall.classification === "Class I" || /CART/.test(f.lot.location_code) ? "now" : "today", kind: "quarantine", item_id: itemId, text: `Quarantine ${f.lot.qty_units} units of lot ${f.lot.lot_number} at ${f.lot.location_code}.`, claims: [f.claimId] });
    for (const f of fs.filter(f => f.verdict === "review")) add({ priority: "today", kind: "check-label", item_id: itemId, text: `Quarantine and check the physical label of lot ${f.lot.lot_number} at ${f.lot.location_code} (${f.lot.qty_units} units): ${f.reason}`, claims: [f.claimId] });
    for (const f of fs.filter(f => f.expired)) add({ priority: "today", kind: "remove-expired", item_id: itemId, text: `Remove ${f.lot.qty_units} units of lot ${f.lot.lot_number} at ${f.lot.location_code}: recalled and past expiry (${f.lot.expiry_date}).`, claims: [f.claimId] });
  }

  const decisions: ItemDecision[] = [];
  for (const s of supply) {
    const carts = s.locations.filter(l => /CART/.test(l.location));
    for (const c of carts) add({ priority: "now", kind: "restock-cart", item_id: s.item_id, text: `Restock ${c.location} first (${c.quarantined} units leaving)${s.useNow ? ` from ${s.useNow.units} units of ${format11(s.useNow.ndc11)} (${s.useNow.labeler}) on hand` : " from unaffected lots in central pharmacy"}, then pull the recalled units.`, claims: [s.claimId] });
    for (const po of s.openPOs) add({ priority: "this week", kind: "inspect-po", item_id: s.item_id, text: `${po.po_number} (${po.packs} packs, due ${po.expected_on}) is for the recalled product: check lot numbers on receipt before putting away.`, claims: [s.claimId] });
    const short = (s.daysAfter ?? Infinity) < TARGET_DAYS;
    const order = s.alternatives.find(a => a.ndc11 === s.recommendation.ndc11 && isOrderable(a));
    if (s.quarantined + s.expiredRecalled === 0) { decisions.push({ item_id: s.item_id, description: s.description, decision: "no action", why: "nothing quarantined" }); continue; }
    if (!short) {
      decisions.push({ item_id: s.item_id, description: s.description, decision: "monitor", why: `${s.daysAfter} days of supply remain after quarantine (target ${TARGET_DAYS}); reorder unaffected lots as usual` });
      continue;
    }
    if (s.useNow) add({ priority: "today", kind: "use-substitute", item_id: s.item_id, text: `Release ${s.useNow.units} units of ${format11(s.useNow.ndc11)} (${s.useNow.labeler}) already on hand to replace quarantined stock${s.useNow.flags.length ? ` (note: ${s.useNow.flags.join("; ")})` : ""}.`, claims: [s.claimId] });
    if (order) {
      add({ priority: "today", kind: "order", item_id: s.item_id, text: `Order ${format11(order.ndc11)} (${order.labeler}, ${order.container ?? ""}${order.volumeMl ? ` ${order.volumeMl} mL` : ""})${order.flags.length ? `; cautions: ${order.flags.join("; ")}` : ""}.`, claims: [s.claimId, order.claimId] });
      decisions.push({ item_id: s.item_id, description: s.description, decision: "substitute", why: `${s.daysAfter} days of supply after quarantine; ${s.recommendation.reason}` });
    } else if (s.useNow) {
      decisions.push({ item_id: s.item_id, description: s.description, decision: "substitute", why: `${s.daysAfter} days of supply after quarantine; using stock already on hand, nothing orderable` });
      add({ priority: "today", kind: "escalate", item_id: s.item_id, text: `No orderable alternative for ${s.description} beyond stock on hand: ask the P&T committee for a conservation plan.`, claims: [s.claimId] });
    } else {
      decisions.push({ item_id: s.item_id, description: s.description, decision: "escalate", why: `${s.daysAfter} days of supply after quarantine and no safe, orderable alternative` });
      add({ priority: "now", kind: "escalate", item_id: s.item_id, text: `Escalate ${s.description} to the P&T committee: ${s.daysAfter} days of supply left and no safe alternative to order.`, claims: [s.claimId] });
    }
  }
  // Similar wording can refer to different locations or lots. Merge only exact
  // normalized text and preserve distinct escalation recipients.
  const normalized = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
  const rank: Priority[] = ["now", "today", "this week"];
  for (const e of critic.escalations) {
    const dup = actions.find(a => normalized(a.text) === normalized(e.issue) && (!a.kind.startsWith("escalate:") || a.kind === `escalate:${e.to}`));
    if (dup) { if (rank.indexOf(e.urgency) < rank.indexOf(dup.priority)) dup.priority = e.urgency; continue; }
    add({ priority: e.urgency, kind: `escalate:${e.to}`, item_id: null, text: e.issue, claims: [] });
  }
  const order: Priority[] = ["now", "today", "this week"];
  actions.sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority));
  // Preserve recipients and item identity when otherwise identical actions coincide.
  const seen = new Set<string>();
  return { actions: actions.filter(a => { const key = `${a.kind}:${a.item_id}:${normalized(a.text)}`; return !seen.has(key) && seen.add(key); }), decisions };
}
