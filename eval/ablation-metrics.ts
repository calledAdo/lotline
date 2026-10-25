// Count errors in units as well as lot rows. An omitted finding means not affected,
// so missed recalls cannot disappear from the denominator. Labels stay evaluator-only.
import type { CaseResult, RoundResult } from "../src/orchestrator.ts";
import type { TraceEvent } from "../src/trace.ts";
import type { Receipt } from "../src/llm.ts";
import { EVAL_LOTS, type AblationScenario } from "./ablation-scenarios.ts";

export function scoreCase(scenario: AblationScenario, result: CaseResult, rounds: RoundResult[], events: TraceEvent[], wallMs: number) {
  const verdicts = scenario.expected.map(expected => {
    const lot = EVAL_LOTS.find(l => String(l.lot_row_id) === expected.lot_row_id)!;
    const actual = result.exposure.findings.find(f => f.lot.lot_row_id === expected.lot_row_id)?.verdict ?? "not_affected";
    return { ...expected, expected: expected.verdict, actual, qty: lot.qty_units, item_id: lot.item_id, location: lot.location_code, lot: lot.lot_number, correct: actual === expected.verdict };
  });
  const failures = verdicts.filter(v => !v.correct);
  const keyRows = scenario.kind === "anchor" ? verdicts.filter(v => v.note !== "Not covered by this anchor recall") : [];
  const calls = events.filter(e => e.type === "llm");
  const receipts = calls.map(e => ({ agent: e.agent, purpose: e.data?.purpose, status: e.data?.status, requestKey: e.data?.requestKey, elapsedMs: e.data?.elapsedMs ?? 0, ...e.data?.receipt as Receipt }));
  const physical = receipts.filter(r => !r.replayed && !r.cached);
  const coverageDisputes = rounds.flatMap(r => r.exposure.coverage.filter(c => c.disputed).map(c => ({ round: r.round, item_id: c.item_id, rule: c.rule, model: c.model, final: result.exposure.coverage.find(x => x.item_id === c.item_id)?.decision, resolved: !result.exposure.coverage.find(x => x.item_id === c.item_id)?.disputed })));
  return {
    verdicts, lotVerdicts: { correct: verdicts.length - failures.length, total: verdicts.length, failures },
    anchorKeyVerdicts: { correct: keyRows.filter(v => v.correct).length, total: keyRows.length },
    wronglyQuarantinedUnits: verdicts.filter(v => v.expected === "not_affected" && v.actual !== "not_affected").reduce((n, v) => n + v.qty, 0),
    missedRecalledUnits: verdicts.filter(v => v.expected === "affected" && v.actual === "not_affected").reduce((n, v) => n + v.qty, 0),
    missedHoldUnits: verdicts.filter(v => v.expected === "review" && v.actual === "not_affected").reduce((n, v) => n + v.qty, 0),
    coverageDisputes,
    coverage: result.exposure.coverage.map(c => ({ item_id: c.item_id, decision: c.decision, expected: scenario.coveredItems.includes(c.item_id) ? "covered" : "not_covered", disputed: c.disputed, reason: c.reason })),
    criticAdjudications: rounds.flatMap(r => [...[...r.critic.coverageAdjudications].map(([item_id, a]) => ({ round: r.round, type: "coverage", item_id, ...a })), ...[...r.critic.substituteAdjudications].map(([item_id, a]) => ({ round: r.round, type: "substitute", item_id, ...a }))]),
    objections: rounds.flatMap(r => r.critic.objections.map(o => ({ round: r.round, ...o }))),
    overruledObjections: events.filter(e => e.agent === "orchestrator" && /overruled by evidence/.test(e.summary)).map(e => ({ summary: e.summary, objection: e.data?.objection })),
    escalations: result.critic.escalations,
    escalationsByRound: rounds.flatMap(r => r.critic.escalations.map(e => ({ round: r.round, ...e }))),
    audits: rounds.flatMap(r => r.critic.audits.map(a => ({ round: r.round, ...a }))),
    orders: result.supply.map(s => ({ item_id: s.item_id, ndc11: s.recommendation.ndc11, reason: s.recommendation.reason })),
    approved: result.critic.approved, rounds: result.rounds, revisions: result.revisions,
    modelCalls: { logicalResponses: receipts.length, httpAttempts: physical.length, sharedOrCached: receipts.filter(r => r.cached).length, providerLatencyMs: physical.reduce((n, r) => n + (r.latencyMs ?? 0), 0), httpWallMs: physical.reduce((n, r) => n + Number(r.elapsedMs), 0), missingProviderLatency: physical.filter(r => r.latencyMs === null).length },
    wallMs, receipts,
    fallbacks: events.filter(e => e.type === "fallback").map(e => ({ agent: e.agent, summary: e.summary })),
  };
}
export type ArmMetrics = ReturnType<typeof scoreCase>;
