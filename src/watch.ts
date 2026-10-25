import { forAgent } from "./context.ts";
// The watcher: are yesterday's answers still true? For every recall case Lotline has
// worked, it re-reads the source projections and query sets those conclusions rest on,
// records changes and missing rows in the World Model, and asks truth
// maintenance which claims are now stale and why. Only the stale cases are re-derived, and
// the new packet is diffed against the last one, so the buyer sees exactly what changed.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./env.ts";
import { asText, lit, ident, ndcExpr, NDC_TRANSFORMS, type NdcTransform } from "./data/dialect.ts";
import type { RunContext } from "./context.ts";
import { loadRecall, recallEvidenceRow } from "./agents/exposure.ts";
import type { Packet } from "./agents/reporter.ts";
import type { StaleReason } from "../engines/world-model/src/index.ts";

import { projections, queryEvidenceRow, usageEvidenceRow, probeEvidenceRow } from "./evidence.ts";
import { canonicalJson } from "../engines/world-model/src/stableIds.ts";

const AGENT = "watcher";

export type EvidenceChange = { id: string; table: string; key: string; changes: Record<string, { before: unknown; after: unknown }>; missing: boolean };
export type StaleCase = { recall: string; staleClaims: { key: string; statement: string; reasons: StaleReason[] }[]; changedEvidence: EvidenceChange[] };

export async function detectChanges(ctx: RunContext): Promise<StaleCase[]> {
  ctx = forAgent(ctx, AGENT);
  const worked = ctx.tm.claims({ kind: "lot-constraints" }).map(c => c.subject);
  ctx.trace.emit("agent-start", AGENT, `re-checking source evidence for ${worked.length} recall case(s)`);
  const changed: EvidenceChange[] = [];
  const q = (sql: string) => ctx.backend.query(sql, { agent: AGENT, purpose: "refresh recorded evidence", trace: ctx.trace });
  // Snapshot the entity list: refreshing must not recursively discover new evidence.
  for (const e of ctx.world.view("graph").query({ type: "evidence" })) {
    if (!ctx.tm.dependents(e.id).length) continue;
    const table = String(e.attrs.table), key = String(e.attrs.key);
    const old = e.attrs.row as Record<string, unknown>;
    let row: Record<string, unknown> | null;
    try {
      if (key.startsWith("query:") && typeof old.sql === "string") {
        row = queryEvidenceRow(table, old.sql, await q(old.sql));
      } else if (table === "fda_snapshot.recalls") {
        const recall = await loadRecall(ctx, key, AGENT);
        row = recall ? recallEvidenceRow(recall) : null;
      } else if (table === "hospital.dispensing_daily") {
        const [item, , today] = key.split(":");
        const since = new Date(Date.parse(today) - 30 * 86400000).toISOString().slice(0, 10);
        const rows = await q(`SELECT sum(units) AS units FROM hospital.dispensing_daily WHERE item_id = ${lit(item)} AND day > cast(${lit(since)} as date) AND day <= cast(${lit(today)} as date)`);
        row = usageEvidenceRow(rows[0] ?? {});
      } else if (table === "probe.ndc_overlap") {
        const match = /^(.+\..+)\.([^.:]+):([^:]+)$/.exec(key);
        if (!match || !NDC_TRANSFORMS.includes(match[3] as NdcTransform)) throw new Error("unrecognized overlap probe");
        const [, source, column, transform] = match;
        const matched = (await q(`SELECT count(DISTINCT i.ndc11) n FROM hospital.item_master i JOIN ${ident(source)} s ON i.ndc11 = ${ndcExpr(ctx.backend.dialect, `s.${ident(column)}`, transform as NdcTransform)}`))[0]?.n;
        const total = (await q("SELECT count(DISTINCT ndc11) n FROM hospital.item_master"))[0]?.n;
        row = probeEvidenceRow({ matched, total });
      } else {
        const keyColumn: Record<string, string> = { "hospital.inventory_lots": "lot_row_id", "hospital.item_master": "item_id", "fda_snapshot.ndc_packages": "package_ndc", "fda_snapshot.shortages": "package_ndc", "fda_live_views.shortages": "package_ndc", "wholesaler.catalog": "ndc_numeric", "hospital.purchase_orders": "po_number" };
        if (!keyColumn[table] || !projections[table]) throw new Error(`unsupported evidence kind ${table}`);
        const rows = await q(`SELECT * FROM ${ident(table)} WHERE ${asText(ctx.backend.dialect, keyColumn[table])} = ${lit(key)}`);
        row = rows.length ? projections[table](rows[0]) : null;
      }
    } catch (err) {
      // A failed read is unknown, never a deletion or a successful freshness check.
      ctx.trace.emit("error", AGENT, `could not refresh ${table}#${key}`, { error: (err as Error).message });
      throw err;
    }
    const didChange = row === null
      ? await ctx.tm.markEvidenceMissing(e.id, ctx.by(AGENT))
      : (await ctx.tm.observeEvidence({ table, key, row, source: ctx.by(AGENT) })).changed;
    if (didChange) {
      const changes = Object.fromEntries([...new Set([...Object.keys(old), ...Object.keys(row ?? {})])].filter(k => canonicalJson(old[k] ?? null) !== canonicalJson(row?.[k] ?? null)).map(k => [k, { before: old[k] ?? null, after: row?.[k] ?? null }]));
      changed.push({ id: e.id, table, key, changes, missing: row === null });
      ctx.trace.emit("invalidation", AGENT, `${table}#${key}: ${row === null ? "evidence missing" : `changed ${Object.keys(changes).join(", ")}`}`, { evidence: changed.at(-1) });
    }
  }
  const byRecall = new Map<string, StaleCase>();
  for (const s of ctx.tm.staleClaims()) {
    const rn = s.claim.key.split(":")[1] ?? "";
    if (!worked.includes(rn)) continue;
    const entry = byRecall.get(rn) ?? { recall: rn, staleClaims: [], changedEvidence: [] };
    entry.staleClaims.push({ key: s.claim.key, statement: s.claim.statement, reasons: s.reasons });
    byRecall.set(rn, entry);
  }
  for (const c of byRecall.values()) {
    c.changedEvidence = changed.filter(e => ctx.tm.dependents(e.id).some(cl => cl.key.split(":")[1] === c.recall));
    // A prior poll may have refreshed evidence before failing or before re-derivation.
    // Preserve its source identity and recorded/current hashes in the case report.
    const addReasons = (reasons: StaleReason[]) => {
      for (const reason of reasons) {
        if (reason.kind === "claim-stale") { addReasons(reason.because); continue; }
        if (reason.kind !== "evidence-changed" && reason.kind !== "evidence-missing") continue;
        if (c.changedEvidence.some(e => e.id === reason.dependency)) continue;
        const entity = ctx.world.view("graph").entity(reason.dependency);
        if (entity?.type !== "evidence") continue;
        c.changedEvidence.push({ id: reason.dependency, table: String(entity.attrs.table), key: String(entity.attrs.key), missing: reason.kind === "evidence-missing", changes: reason.kind === "evidence-changed" ? { hash: { before: reason.recordedHash, after: reason.currentHash } } : { present: { before: true, after: false } } });
      }
    };
    for (const claim of c.staleClaims) addReasons(claim.reasons);
    ctx.trace.emit("invalidation", AGENT, `${c.recall}: ${c.staleClaims.length} conclusion(s) stale`, { stale: c.staleClaims, changedEvidence: c.changedEvidence });
  }
  ctx.trace.emit("agent-end", AGENT, `${byRecall.size} case(s) need re-deriving`);
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
