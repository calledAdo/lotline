// The watcher: are yesterday's answers still true? For every recall case Lotline has
// worked, it re-reads the evidence those conclusions rest on (the recall as revised by the
// change feed, and the lots on hand), records it in the World Model, and asks truth
// maintenance which claims are now stale and why. Only the stale cases are re-derived, and
// the new packet is diffed against the last one, so the buyer sees exactly what changed.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./env.ts";
import { asText } from "./data/dialect.ts";
import type { RunContext } from "./context.ts";
import { loadRecall, recallEvidenceRow } from "./agents/exposure.ts";
import type { Packet } from "./agents/reporter.ts";
import type { StaleReason } from "../engines/world-model/src/index.ts";

const AGENT = "watcher";

export type StaleCase = { recall: string; staleClaims: { key: string; statement: string; reasons: StaleReason[] }[]; changedEvidence: string[] };

export async function detectChanges(ctx: RunContext): Promise<StaleCase[]> {
  const worked = ctx.tm.claims({ kind: "lot-constraints" }).map(c => c.subject);
  ctx.trace.emit("agent-start", AGENT, `re-checking the evidence behind ${worked.length} recall case(s): ${worked.join(", ") || "none"}`);
  const changed: string[] = [];
  for (const rn of worked) {
    const recall = await loadRecall(ctx, rn);
    if (!recall) continue;
    const ev = await ctx.tm.observeEvidence({ table: "fda_snapshot.recalls", key: rn, row: recallEvidenceRow(recall), source: ctx.by(AGENT) });
    if (ev.changed) { changed.push(ev.id); ctx.trace.emit("invalidation", AGENT, `${rn} text changed${recall.updated_from ? ` (${recall.updated_from})` : ""}: code_info is now "${recall.code_info}"`); }
  }
  const d = ctx.backend.dialect;
  const lots = await ctx.backend.query(`SELECT ${asText(d, "lot_row_id")} AS lot_row_id, item_id, location_code, lot_number, ${asText(d, "expiry_date")} AS expiry_date, ${asText(d, "qty_units")} AS qty_units, po_number FROM hospital.inventory_lots`, { agent: AGENT, purpose: "re-read lots on hand", trace: ctx.trace });
  const known = new Set(ctx.world.view("graph").query({ type: "evidence" }).map(e => e.id));
  for (const l of lots) {
    const id = `evidence:zetaris:hospital.inventory_lots#${l.lot_row_id}`;
    if (!known.has(id)) continue; // only lots an earlier conclusion actually used
    const ev = await ctx.tm.observeEvidence({ table: "hospital.inventory_lots", key: l.lot_row_id!, row: { ...l, qty_units: Number(l.qty_units) }, source: ctx.by(AGENT) });
    if (ev.changed) { changed.push(ev.id); ctx.trace.emit("invalidation", AGENT, `lot row ${l.lot_row_id} (${l.location_code} ${l.lot_number}) changed: now ${l.qty_units} units`); }
  }
  const stale = ctx.tm.staleClaims();
  const byRecall = new Map<string, StaleCase>();
  for (const s of stale) {
    const rn = s.claim.key.split(":")[1] ?? "";
    if (!worked.includes(rn)) continue;
    const entry = byRecall.get(rn) ?? { recall: rn, staleClaims: [], changedEvidence: changed };
    entry.staleClaims.push({ key: s.claim.key, statement: s.claim.statement, reasons: s.reasons });
    byRecall.set(rn, entry);
  }
  for (const c of byRecall.values()) ctx.trace.emit("invalidation", AGENT, `${c.recall}: ${c.staleClaims.length} conclusion(s) now stale (${c.staleClaims.slice(0, 4).map(s => s.key).join(", ")}${c.staleClaims.length > 4 ? ", ..." : ""})`, { stale: c.staleClaims });
  ctx.trace.emit("agent-end", AGENT, byRecall.size ? `${byRecall.size} case(s) need re-deriving` : `${changed.length} evidence change(s); every conclusion still holds`);
  return [...byRecall.values()];
}

/** The most recent packet written for a recall, from any earlier run. */
export function lastPacket(recall: string, excludeRun?: string, backend?: string): Packet | null {
  const runs = path.join(ROOT, "runs");
  if (!existsSync(runs)) return null;
  const candidates = readdirSync(runs).filter(r => r !== excludeRun).sort().reverse();
  for (const r of candidates) {
    const f = path.join(runs, r, `packet-${recall}.json`);
    if (existsSync(f)) {
      const packet = JSON.parse(readFileSync(f, "utf8")) as Packet;
      if (!backend || packet.backend === backend) return packet;
    }
  }
  return null;
}

export type PacketDiff = { recall: string; lines: string[] };

export function diffPackets(before: Packet, after: Packet): PacketDiff {
  const lines: string[] = [];
  if (before.approved !== after.approved) lines.push(`Automated approval: ${before.approved} -> ${after.approved}`);
  if (before.recall.code_info !== after.recall.code_info) lines.push(`Recall text: "${before.recall.code_info}" -> "${after.recall.code_info}"${after.recall.updated_from ? ` [${after.recall.updated_from}]` : ""}`);
  // Stable claim IDs distinguish separate inventory rows sharing a lot and location.
  const label = (l: Packet["lots"][number]) => `${l.location} ${l.lot} (${l.item_id})`;
  const key = (l: Packet["lots"][number]) => l.claim || label(l);
  const b = new Map(before.lots.map(l => [key(l), l])), a = new Map(after.lots.map(l => [key(l), l]));
  for (const [k, l] of a) {
    const old = b.get(k), name = label(l);
    if (!old) lines.push(`${name}: newly ${l.verdict} (${l.qty} units)`);
    else {
      if (old.verdict !== l.verdict) lines.push(`${name}: ${old.verdict} -> ${l.verdict} (${l.qty} units)`);
      if (old.qty !== l.qty) lines.push(`${name}: quantity ${old.qty} -> ${l.qty} units`);
      if (old.expiry !== l.expiry) lines.push(`${name}: expiry ${old.expiry} -> ${l.expiry}`);
      if (old.expired !== l.expired) lines.push(`${name}: expired ${old.expired} -> ${l.expired}`);
      if (label(old) !== name) lines.push(`Inventory identity corrected: ${label(old)} -> ${name}`);
    }
  }
  for (const [k, l] of b) if (!a.has(k)) lines.push(`${label(l)}: removed from packet (${l.qty} units; previously ${l.verdict})`);
  for (const s of after.supply) {
    const old = before.supply.find(x => x.item_id === s.item_id);
    if (!old) lines.push(`${s.description}: now under supply review (${s.daysAfter} days after quarantine)`);
    else {
      if (old.quarantined !== s.quarantined) lines.push(`${s.description}: quarantined ${old.quarantined} -> ${s.quarantined} units`);
      if (old.daysAfter !== s.daysAfter) lines.push(`${s.description}: days of supply after quarantine ${old.daysAfter} -> ${s.daysAfter}`);
      for (const field of ["onHand", "usable", "avgDaily", "daysBefore", "expiredRecalled", "useNow", "order", "shortage"] as const) {
        if (old[field] !== s[field]) lines.push(`${s.description}: ${field} ${old[field] ?? "none"} -> ${s[field] ?? "none"}`);
      }
    }
  }
  for (const old of before.supply) if (!after.supply.some(s => s.item_id === old.item_id)) lines.push(`${old.description}: supply review ended`);
  for (const d of after.decisions) {
    const old = before.decisions.find(x => x.item_id === d.item_id);
    if (old?.decision !== d.decision) lines.push(`${d.description}: decision ${old?.decision ?? "none"} -> ${d.decision}`);
  }
  for (const old of before.decisions) if (!after.decisions.some(d => d.item_id === old.item_id)) lines.push(`${old.description}: decision ${old.decision} removed`);
  const actionKey = (x: Packet["actions"][number]) => JSON.stringify([x.item_id, x.kind, x.text]);
  const oldActions = new Map(before.actions.map(x => [actionKey(x), x]));
  const newActions = new Map(after.actions.map(x => [actionKey(x), x]));
  for (const [k, x] of newActions) {
    const old = oldActions.get(k);
    if (!old) lines.push(`new action [${x.priority}]: ${x.text}`);
    else if (old.priority !== x.priority) lines.push(`action priority ${old.priority} -> ${x.priority}: ${x.text}`);
  }
  for (const [k, x] of oldActions) if (!newActions.has(k)) lines.push(`removed action [${x.priority}]: ${x.text}`);
  return { recall: after.recall.recall_number, lines };
}
