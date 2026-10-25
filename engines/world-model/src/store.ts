// Event-sourced canonical store. State is a fold over an append-only event
// log; views are projections of the fold. Every mutation writes an audit
// entry; the control plane reads the audit log.
//
// Lotline change (see NOTICE): "local" storage is a durable append-only JSON
// Lines log (.world/<namespace>.events.jsonl), one event per line, appended as
// it happens, plus a small side-state file for the audit log and operator
// queues. Replay tolerates a torn final line, so a crash mid-append loses at
// most that one event and never corrupts the world. The fold also applies the
// fact resolution recorded on assertFact events, so a replayed world equals
// the live one.

import fs from "node:fs";
import path from "node:path";
import type {
  AuditEntry, Context, Entity, EventKind, Fact, Relationship,
  WorldEvent, MergeProposal, ObservationRecord, StoryAggregate, ScoreSnapshot,
} from "./types.ts";

export interface FoldedState {
  entities: Map<string, Entity>;
  contexts: Map<string, Context>;
  relationships: Map<string, Relationship>;
  facts: Map<string, Fact>;
  aliases: Map<string, string>; // aliasId -> primaryId
}

/** Recorded on an assertFact event: which fact won, and which facts it supersedes. */
export type FactResolution = { winnerId: string; superseded: string[] };
export type FactEventPayload = Fact & { resolution?: FactResolution };

type SideState = {
  audit: AuditEntry[];
  observations: [string, ObservationRecord][];
  stories: [string, StoryAggregate][];
  scores: ScoreSnapshot[];
  mergeQueue: MergeProposal[];
};

export class EventStore {
  events: WorldEvent[] = [];
  audit: AuditEntry[] = [];
  observations = new Map<string, ObservationRecord>();
  stories = new Map<string, StoryAggregate>();
  scores: ScoreSnapshot[] = [];
  mergeQueue: MergeProposal[] = [];
  state: FoldedState = {
    entities: new Map(),
    contexts: new Map(),
    relationships: new Map(),
    facts: new Map(),
    aliases: new Map(),
  };
  /** events dropped on load because the final line was torn (crash mid-append) */
  tornLines = 0;
  private seq = 0;
  private auditSeq = 0;
  private logFile?: string;
  private sideFile?: string;
  private subscribers = new Set<(e: WorldEvent) => void>();

  constructor(namespace: string, storage: "memory" | "local", directory?: string) {
    if (storage !== "local") return;
    const dir = path.join(directory ?? process.cwd(), ".world");
    fs.mkdirSync(dir, { recursive: true });
    this.logFile = path.join(dir, `${namespace}.events.jsonl`);
    this.sideFile = path.join(dir, `${namespace}.side.json`);
    if (fs.existsSync(this.sideFile)) {
      const side = JSON.parse(fs.readFileSync(this.sideFile, "utf-8")) as Partial<SideState>;
      this.audit = side.audit ?? [];
      this.auditSeq = this.audit.length ? this.audit[this.audit.length - 1]!.seq : 0;
      this.observations = new Map(side.observations ?? []);
      this.stories = new Map(side.stories ?? []);
      this.scores = side.scores ?? [];
      this.mergeQueue = side.mergeQueue ?? [];
    }
    if (fs.existsSync(this.logFile)) {
      const lines = fs.readFileSync(this.logFile, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (!line) continue;
        let event: WorldEvent;
        try {
          event = JSON.parse(line) as WorldEvent;
        } catch {
          // Only a final, partially written line is tolerated. Anything else is corruption.
          if (lines.slice(i + 1).every(l => !l.trim())) { this.tornLines++; break; }
          throw new Error(`World Model: corrupt event log ${this.logFile} at line ${i + 1}`);
        }
        this.seq = Math.max(this.seq, event.seq);
        this.events.push(event);
        this.fold(event);
      }
      if (this.tornLines) this.rewriteLog();
    }
  }

  append(kind: EventKind, payload: WorldEvent["payload"], at: string): WorldEvent {
    const event: WorldEvent = { id: `evt_${this.seq + 1}`, seq: this.seq + 1, kind, payload, schemaVersion: 1, at };
    this.seq = event.seq;
    if (this.logFile) fs.appendFileSync(this.logFile, JSON.stringify(event) + "\n", "utf-8");
    this.events.push(event);
    this.fold(event);
    this.persist();
    for (const fn of this.subscribers) fn(event);
    return event;
  }

  private fold(event: WorldEvent): void {
    switch (event.kind) {
      case "upsertEntity": {
        const e = event.payload as Entity;
        const existing = this.state.entities.get(e.id);
        if (existing) {
          existing.attrs = { ...existing.attrs, ...e.attrs };
          existing.updatedAt = e.updatedAt;
          existing.source = e.source;
          if (e.name && !existing.aliases.includes(e.name)) existing.aliases.push(e.name);
          if (e.name) existing.name = e.name;
          if (e.state) existing.state = e.state;
        } else {
          this.state.entities.set(e.id, structuredClone(e));
        }
        break;
      }
      case "upsertContext": {
        const c = event.payload as Context;
        const existing = this.state.contexts.get(c.id);
        if (existing) {
          existing.attrs = { ...existing.attrs, ...c.attrs };
          existing.updatedAt = c.updatedAt;
        } else {
          this.state.contexts.set(c.id, structuredClone(c));
        }
        break;
      }
      case "relate": {
        const r = event.payload as Relationship;
        // Superseding semantics: a new open edge with the same (from, type,
        // context) but different target CLOSES the previous open edge.
        for (const other of this.state.relationships.values()) {
          if (
            other.from === r.from && other.type === r.type &&
            (other.context ?? "") === (r.context ?? "") &&
            other.to !== r.to && !other.validTo && !other.supersededBy
          ) {
            other.validTo = r.validFrom ?? r.createdAt;
            other.supersededBy = r.id;
          }
        }
        if (!this.state.relationships.has(r.id)) this.state.relationships.set(r.id, structuredClone(r));
        break;
      }
      case "assertFact": {
        const { resolution, ...f } = event.payload as FactEventPayload;
        if (!this.state.facts.has(f.id)) this.state.facts.set(f.id, structuredClone(f));
        if (resolution) {
          for (const id of resolution.superseded) {
            const loser = this.state.facts.get(id);
            if (loser) loser.supersededBy = resolution.winnerId;
          }
          const winner = this.state.facts.get(resolution.winnerId);
          const entity = this.state.entities.get(f.about);
          if (winner && entity) {
            entity.attrs[winner.predicate] = winner.value;
            entity.updatedAt = f.assertedAt;
          }
        }
        break;
      }
      case "alias": {
        const a = event.payload as { aliasId: string; primaryId: string };
        this.state.aliases.set(a.aliasId, a.primaryId);
        break;
      }
      case "snapshot":
      case "tombstone":
      case "view-rebuild":
        break;
    }
  }

  // Replays the event log up to (and including) a timestamp: the snapshot view.
  foldUntil(at: string): FoldedState {
    const scratch = new EventStore("scratch", "memory");
    for (const e of this.events) {
      if (e.at <= at) scratch.fold(e);
    }
    return scratch.state;
  }

  resolveAlias(id: string): string {
    let cur = id;
    const seen = new Set<string>();
    while (this.state.aliases.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.state.aliases.get(cur)!;
    }
    return cur;
  }

  logAudit(kind: string, actor: string, summary: string, eventId?: string, runId?: string, at?: string): void {
    this.audit.push({ seq: ++this.auditSeq, at: at ?? new Date(0).toISOString(), kind, actor, summary, eventId, runId });
    this.persist();
  }

  subscribe(fn: (e: WorldEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Writes the side state (audit, operator queues, observation records). Events are already on disk. */
  persist(): void {
    if (!this.sideFile) return;
    const side: SideState = {
      audit: this.audit,
      observations: [...this.observations.entries()],
      stories: [...this.stories.entries()],
      scores: this.scores,
      mergeQueue: this.mergeQueue,
    };
    const tmp = `${this.sideFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(side) + "\n", "utf-8");
    fs.renameSync(tmp, this.sideFile); // atomic replace: never a half-written side file
  }

  private rewriteLog(): void {
    if (!this.logFile) return;
    const tmp = `${this.logFile}.tmp`;
    fs.writeFileSync(tmp, this.events.map(e => JSON.stringify(e)).join("\n") + (this.events.length ? "\n" : ""), "utf-8");
    fs.renameSync(tmp, this.logFile);
  }
}
