// The run trace: every agent step, SQL query, model call (with its Nightshift receipt),
// claim, critique, branch and escalation, in order. Written as JSON Lines to
// runs/<runId>/trace.jsonl as it happens, so a crash still leaves a readable record.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ROOT, redact } from "./env.ts";

export type TraceType =
  | "run-start" | "run-end" | "agent-start" | "agent-end" | "message"
  | "sql" | "llm" | "claim" | "critique" | "revision" | "branch" | "escalation"
  | "policy" | "decision" | "fallback" | "error" | "invalidation" | "note";

export type TraceEvent = { seq: number; t: string; ms: number; type: TraceType; agent: string; summary: string; data?: Record<string, unknown> };

export class Trace {
  readonly events: TraceEvent[] = [];
  readonly dir: string;
  private seq = 0;
  private started = Date.now();
  private file: string;

  constructor(readonly runId: string, opts: { persist?: boolean } = {}) {
    this.dir = path.join(ROOT, "runs", runId);
    this.file = path.join(this.dir, "trace.jsonl");
    if (opts.persist !== false) mkdirSync(this.dir, { recursive: true });
    this.persist = opts.persist !== false;
  }
  private persist: boolean;

  emit(type: TraceType, agent: string, summary: string, data?: Record<string, unknown>): TraceEvent {
    const event: TraceEvent = JSON.parse(redact(JSON.stringify({ seq: ++this.seq, t: new Date().toISOString(), ms: Date.now() - this.started, type, agent, summary, data })));
    this.events.push(event);
    if (this.persist) appendFileSync(this.file, redact(JSON.stringify(event)) + "\n");
    if (process.env.LOTLINE_QUIET !== "true") console.log(`  ${String(event.ms).padStart(6)}ms  ${agent.padEnd(12)} ${type.padEnd(11)} ${event.summary}`);
    return event;
  }
}

/** A no-op trace for unit tests. */
export const silentTrace = () => {
  const t = new Trace(`test-${Math.random().toString(36).slice(2)}`, { persist: false });
  return t;
};
