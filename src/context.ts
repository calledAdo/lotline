// What every agent receives: the data backend (Zetaris or local), the shared World Model
// with its truth-maintenance layer, the run trace, and the run's identity and clock.
import { TruthMaintenance, WorldModel } from "../engines/world-model/src/index.ts";
import type { DataBackend } from "./data/backend.ts";
import type { Trace } from "./trace.ts";
import type { Provenance } from "../engines/world-model/src/types.ts";
import { stableRows } from "./data/rows.ts";

export type RunContext = {
  runId: string;
  runDir?: string;
  /** the hospital's "today" (fixed for reproducible demos, real date otherwise) */
  today: string;
  backend: DataBackend;
  world: WorldModel;
  tm: TruthMaintenance;
  trace: Trace;
  /** provenance for writes by an agent in this run */
  by(agent: string): Provenance;
};

export function makeContext(o: { runId: string; runDir?: string; today: string; backend: DataBackend; world: WorldModel; trace: Trace }): RunContext {
  return {
    ...o,
    backend: {
      name: o.backend.name, dialect: o.backend.dialect,
      sources: () => o.backend.sources(),
      describe: async table => (await o.backend.describe(table)).sort((a, b) => a.name.localeCompare(b.name)),
      query: async (sql, meta) => stableRows(await o.backend.query(sql, meta)),
      close: () => o.backend.close(),
    },
    tm: new TruthMaintenance(o.world),
    by: (agent: string) => ({ kind: "agent", by: agent, at: new Date().toISOString(), runId: o.runId }),
  };
}

/** Records a source row as evidence and returns its id. */
export async function evidence(ctx: RunContext, agent: string, table: string, key: string, row: Record<string, unknown>): Promise<string> {
  const ev = await ctx.tm.observeEvidence({ table, key, row, source: ctx.by(agent) });
  return ev.id;
}
