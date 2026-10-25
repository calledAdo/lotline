// Truth maintenance over the World Model (Lotline extension, see NOTICE).
//
// Agents never just "say" something. Each conclusion is a claim entity that
// records exactly what it was built from:
//   - evidence: source rows (a Zetaris table + row key), with the content hash
//     the agent actually saw, and
//   - upstream claims, with the revision the agent actually used.
// When a source row changes, nothing is mutated in place. Staleness is derived
// on read by comparing each claim's recorded dependencies with the current
// world, transitively, so exactly the conclusions that depended on the change
// are reopened, and the reason chain explains why.

import { canonicalJson, sha256Hex } from "./stableIds.ts";
import type { Entity, Provenance } from "./types.ts";
import type { WorldModel } from "./index.ts";

export type EvidenceInput = { table: string; key: string; row: Record<string, unknown>; source: Provenance };
export type EvidenceRecord = { id: string; table: string; key: string; hash: string; row: Record<string, unknown> };

export type Dependency =
  | { kind: "evidence"; id: string; hash: string }
  | { kind: "claim"; id: string; revision: number };

export type ClaimInput = {
  /** deterministic key, e.g. "affected:D-0727-2026:lot-1"; the same key revises the same claim */
  key: string;
  kind: string;
  subject: string;
  statement: string;
  value?: unknown;
  confidence: number;
  /** evidence entity ids and claim ids this claim was built from */
  evidence?: string[];
  claims?: string[];
  producedBy: string;
  /** Nightshift compute receipt id(s) for the model calls behind this claim */
  receipts?: string[];
  source: Provenance;
};

export type ClaimRecord = {
  id: string;
  key: string;
  kind: string;
  subject: string;
  statement: string;
  value: unknown;
  confidence: number;
  status: "active" | "retracted";
  revision: number;
  dependsOn: Dependency[];
  producedBy: string;
  receipts: string[];
  retractedReason?: string;
};

export type StaleReason =
  | { kind: "evidence-changed"; dependency: string; recordedHash: string; currentHash: string }
  | { kind: "evidence-missing"; dependency: string }
  | { kind: "claim-revised"; dependency: string; recordedRevision: number; currentRevision: number }
  | { kind: "claim-retracted"; dependency: string }
  | { kind: "claim-stale"; dependency: string; because: StaleReason[] };

export type Staleness = { stale: boolean; reasons: StaleReason[] };

export const evidenceId = (table: string, key: string) => `evidence:zetaris:${table}#${key}`;
export const claimId = (key: string) => `claim:lotline:${key}`;
export const rowHash = (row: Record<string, unknown>) => sha256Hex(canonicalJson(row));

export class TruthMaintenance {
  constructor(private world: WorldModel) {}

  private entity(id: string): Entity | undefined {
    return this.world.view("graph").entity(id);
  }

  /** Records (or refreshes) a source row. Returns whether its content changed. */
  async observeEvidence(input: EvidenceInput): Promise<EvidenceRecord & { changed: boolean; previousHash?: string }> {
    const id = evidenceId(input.table, input.key);
    const hash = rowHash(input.row);
    const existing = this.entity(id);
    const previousHash = existing?.attrs.hash as string | undefined;
    if (previousHash !== hash) {
      await this.world.upsertEntity({
        type: "evidence",
        externalKey: { system: "zetaris", id: `${input.table}#${input.key}` },
        name: `${input.table}#${input.key}`,
        attrs: { table: input.table, key: input.key, hash, row: input.row },
        source: input.source,
      });
    }
    return { id, table: input.table, key: input.key, hash, row: input.row, changed: previousHash !== undefined && previousHash !== hash, previousHash };
  }

  evidence(id: string): EvidenceRecord | undefined {
    const e = this.entity(id);
    if (!e || e.type !== "evidence") return undefined;
    return { id, table: e.attrs.table as string, key: e.attrs.key as string, hash: e.attrs.hash as string, row: e.attrs.row as Record<string, unknown> };
  }

  /**
   * Asserts or revises a claim. Dependencies are snapshotted at their current
   * hash/revision. Re-asserting identical content on identical dependencies is a
   * no-op (no event), so repeated runs do not churn the world.
   */
  async assertClaim(input: ClaimInput): Promise<ClaimRecord> {
    const id = claimId(input.key);
    const dependsOn: Dependency[] = [];
    for (const eid of [...new Set(input.evidence ?? [])].sort()) {
      const ev = this.evidence(eid);
      if (!ev) throw new Error(`Truth maintenance: claim ${input.key} cites unknown evidence ${eid}`);
      dependsOn.push({ kind: "evidence", id: eid, hash: ev.hash });
    }
    for (const cid of [...new Set(input.claims ?? [])].sort()) {
      const c = this.claim(cid);
      if (!c) throw new Error(`Truth maintenance: claim ${input.key} cites unknown claim ${cid}`);
      if (c.id === id) throw new Error(`Truth maintenance: claim ${input.key} cannot depend on itself`);
      dependsOn.push({ kind: "claim", id: cid, revision: c.revision });
    }

    const prior = this.claim(id);
    const content = { kind: input.kind, subject: input.subject, statement: input.statement, value: input.value ?? null, confidence: input.confidence, dependsOn, status: "active" };
    if (prior && canonicalJson(content) === canonicalJson({ kind: prior.kind, subject: prior.subject, statement: prior.statement, value: prior.value, confidence: prior.confidence, dependsOn: prior.dependsOn, status: prior.status })) {
      return prior;
    }
    const revision = (prior?.revision ?? 0) + 1;
    await this.world.upsertEntity({
      type: "claim",
      externalKey: { system: "lotline", id: input.key },
      name: input.key,
      attrs: { ...content, key: input.key, revision, producedBy: input.producedBy, receipts: input.receipts ?? [], retractedReason: null },
      source: { ...input.source, by: input.source.by ?? input.producedBy },
    });
    for (const d of dependsOn) {
      await this.world.relate({ from: id, type: "depends-on", to: d.id, context: `rev:${input.key}:${revision}:${d.id}`, attrs: { revision }, source: input.source });
    }
    return this.claim(id)!;
  }

  /** Withdraws a claim (it stays in history). Claims built on it become stale. */
  async retractClaim(key: string, reason: string, source: Provenance): Promise<ClaimRecord> {
    const prior = this.claim(claimId(key));
    if (!prior) throw new Error(`Truth maintenance: no claim ${key}`);
    if (prior.status === "retracted") return prior;
    await this.world.upsertEntity({
      type: "claim",
      externalKey: { system: "lotline", id: key },
      name: key,
      attrs: { status: "retracted", retractedReason: reason, revision: prior.revision + 1 },
      source,
    });
    return this.claim(claimId(key))!;
  }

  claim(id: string): ClaimRecord | undefined {
    const e = this.entity(id);
    if (!e || e.type !== "claim") return undefined;
    const a = e.attrs;
    return {
      id: e.id,
      key: a.key as string,
      kind: a.kind as string,
      subject: a.subject as string,
      statement: a.statement as string,
      value: a.value ?? null,
      confidence: a.confidence as number,
      status: (a.status as ClaimRecord["status"]) ?? "active",
      revision: a.revision as number,
      dependsOn: (a.dependsOn as Dependency[]) ?? [],
      producedBy: a.producedBy as string,
      receipts: (a.receipts as string[]) ?? [],
      retractedReason: (a.retractedReason as string | null) ?? undefined,
    };
  }

  claims(filter?: { kind?: string; subject?: string; includeRetracted?: boolean }): ClaimRecord[] {
    return this.world.view("graph")
      .query({ type: "claim" })
      .map(e => this.claim(e.id)!)
      .filter(c => (!filter?.kind || c.kind === filter.kind) && (!filter?.subject || c.subject === filter.subject) && (filter?.includeRetracted || c.status === "active"));
  }

  /** Derived staleness with the full reason chain. */
  staleness(id: string, memo = new Map<string, Staleness>(), visiting = new Set<string>()): Staleness {
    const cached = memo.get(id);
    if (cached) return cached;
    const claim = this.claim(id);
    if (!claim) return { stale: true, reasons: [{ kind: "evidence-missing", dependency: id }] };
    if (visiting.has(id)) return { stale: false, reasons: [] }; // cycles are rejected at write time; defensive
    visiting.add(id);
    const reasons: StaleReason[] = [];
    for (const d of claim.dependsOn) {
      if (d.kind === "evidence") {
        const ev = this.evidence(d.id);
        if (!ev) reasons.push({ kind: "evidence-missing", dependency: d.id });
        else if (ev.hash !== d.hash) reasons.push({ kind: "evidence-changed", dependency: d.id, recordedHash: d.hash, currentHash: ev.hash });
      } else {
        const up = this.claim(d.id);
        if (!up) reasons.push({ kind: "evidence-missing", dependency: d.id });
        else if (up.status === "retracted") reasons.push({ kind: "claim-retracted", dependency: d.id });
        else if (up.revision !== d.revision) reasons.push({ kind: "claim-revised", dependency: d.id, recordedRevision: d.revision, currentRevision: up.revision });
        else {
          const upstream = this.staleness(d.id, memo, visiting);
          if (upstream.stale) reasons.push({ kind: "claim-stale", dependency: d.id, because: upstream.reasons });
        }
      }
    }
    visiting.delete(id);
    const result = { stale: reasons.length > 0, reasons };
    memo.set(id, result);
    return result;
  }

  /** Every active claim that is currently stale, with reasons. */
  staleClaims(): { claim: ClaimRecord; reasons: StaleReason[] }[] {
    const memo = new Map<string, Staleness>();
    return this.claims()
      .map(claim => ({ claim, s: this.staleness(claim.id, memo) }))
      .filter(x => x.s.stale)
      .map(x => ({ claim: x.claim, reasons: x.s.reasons }));
  }

  /** Impact analysis: every active claim that depends, directly or transitively, on a node. */
  dependents(nodeId: string): ClaimRecord[] {
    const all = this.claims();
    const out = new Map<string, ClaimRecord>();
    let frontier = [nodeId];
    while (frontier.length) {
      const next: string[] = [];
      for (const target of frontier) {
        for (const c of all) {
          if (!out.has(c.id) && c.dependsOn.some(d => d.id === target)) {
            out.set(c.id, c);
            next.push(c.id);
          }
        }
      }
      frontier = next;
    }
    return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
