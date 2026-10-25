// One bounded, sequential paired experiment. Both arms read the same committed snapshot;
// workers call Nightshift live once per request and share those replies across the pair.
// Only the treatment adds live Ultra reviews and the existing revision loop. Sharing
// worker replies removes model sampling noise from the comparison and is reported below.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorldModel, sha256Hex } from "../engines/world-model/src/index.ts";
import { ROOT, need, sampleMode } from "../src/env.ts";
import { LocalBackend } from "../src/data/local.ts";
import { makeContext } from "../src/context.ts";
import { Trace } from "../src/trace.ts";
import { discoverCrosswalk } from "../src/agents/cartographer.ts";
import { loadItems } from "../src/agents/exposure.ts";
import { runCase, type RoundResult } from "../src/orchestrator.ts";
import { withModelRuntime, DEFAULT_MODELS, modelFor, type ChatResponse } from "../src/llm.ts";
import { assertNoSecrets } from "../src/secrets.ts";
import { ABLATION_SCENARIOS } from "./ablation-scenarios.ts";
import { scoreCase, type ArmMetrics } from "./ablation-metrics.ts";

process.env.LOTLINE_QUIET = "true";
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
type Arm = { arm: "without_critic" | "with_critic"; status: "complete"; runId: string; metrics: ArmMetrics };
type Case = { recall: string; title: string; kind: string; status: string; arms: Arm[]; error?: string };
const publicWrite = (file: string, value: unknown) => { const text = JSON.stringify(value, null, 2) + "\n"; assertNoSecrets(text); writeFileSync(file, text); };

async function oneCase(recall: string, file: string) {
  const scenario = ABLATION_SCENARIOS.find(s => s.recall === recall);
  if (!scenario) throw new Error("Unknown labelled scenario");
  const result: Case = { recall, title: scenario.title, kind: scenario.kind, status: "running", arms: [] };
  publicWrite(file, result);
  const fastCache = new Map<string, ChatResponse>();
  for (const critic of [false, true]) {
    const arm = critic ? "with_critic" : "without_critic";
    const runId = `ablation-${Date.now()}-${recall}-${arm}`;
    const trace = new Trace(runId), backend = new LocalBackend();
    const ctx = makeContext({ runId, runDir: trace.dir, today: "2026-10-24", backend, world: new WorldModel({ storage: "memory", namespace: runId }), trace });
    const started = Date.now(), rounds: RoundResult[] = [];
    trace.emit("run-start", "ablation", `${recall} ${arm}: frozen DuckDB snapshot, live Nightshift models; paired worker replies shared`);
    try {
      await withModelRuntime({ mode: "live", fastCache }, async () => {
        const crosswalk = await discoverCrosswalk(ctx), items = await loadItems(ctx, crosswalk);
        const worked = await runCase(ctx, recall, items, crosswalk, { critic, onRound: r => rounds.push(r) });
        if (!worked) throw new Error("Recall missing");
        trace.emit("run-end", "ablation", `${recall} ${arm} complete`);
        result.arms.push({ arm, status: "complete", runId, metrics: scoreCase(scenario, worked, rounds, trace.events, Date.now() - started) });
        publicWrite(file, result);
      });
    } finally { await backend.close(); }
  }
  result.status = "complete";
  publicWrite(file, result);
}

function totals(cases: Case[], arm: Arm["arm"]) {
  const metrics = cases.flatMap(c => c.arms.filter(a => a.arm === arm).map(a => a.metrics));
  return {
    completedCases: metrics.length,
    correct: metrics.reduce((n, m) => n + m.lotVerdicts.correct, 0), total: metrics.reduce((n, m) => n + m.lotVerdicts.total, 0),
    anchorCorrect: metrics.reduce((n, m) => n + m.anchorKeyVerdicts.correct, 0), anchorTotal: metrics.reduce((n, m) => n + m.anchorKeyVerdicts.total, 0),
    wronglyQuarantinedUnits: metrics.reduce((n, m) => n + m.wronglyQuarantinedUnits, 0), missedRecalledUnits: metrics.reduce((n, m) => n + m.missedRecalledUnits, 0), missedHoldUnits: metrics.reduce((n, m) => n + m.missedHoldUnits, 0),
    coverageDisputes: metrics.reduce((n, m) => n + m.coverageDisputes.length, 0), adjudications: metrics.reduce((n, m) => n + m.criticAdjudications.length, 0), objections: metrics.reduce((n, m) => n + m.objections.length, 0), overruled: metrics.reduce((n, m) => n + m.overruledObjections.length, 0), escalations: metrics.reduce((n, m) => n + m.escalations.length, 0),
    logicalResponses: metrics.reduce((n, m) => n + m.modelCalls.logicalResponses, 0), httpAttempts: metrics.reduce((n, m) => n + m.modelCalls.httpAttempts, 0), modelLatencyMs: metrics.reduce((n, m) => n + m.modelCalls.httpWallMs, 0), wallMs: metrics.reduce((n, m) => n + m.wallMs, 0),
  };
}
function markdown(result: { startedAt: string; elapsedMs: number; methodology: string; cases: Case[]; totals: Record<Arm["arm"], ReturnType<typeof totals>> }) {
  const a = result.totals.without_critic, b = result.totals.with_critic;
  const lines = [`# Critic ablation — ${result.startedAt.slice(0, 10)}`, "", result.methodology, "", `Elapsed: ${(result.elapsedMs / 60_000).toFixed(2)} minutes. No prompt was tuned against the answer key for this experiment.`, "", "| Metric (raw counts) | Fast workers + code | Plus Ultra critic |", "|---|---:|---:|", `| Completed cases | ${a.completedCases} | ${b.completedCases} |`, `| Correct lot verdicts / all inventory-case pairs | ${a.correct}/${a.total} | ${b.correct}/${b.total} |`, `| Correct original anchor answer-key verdicts | ${a.anchorCorrect}/${a.anchorTotal} | ${b.anchorCorrect}/${b.anchorTotal} |`, ...(["wronglyQuarantinedUnits", "missedRecalledUnits", "missedHoldUnits", "coverageDisputes", "adjudications", "objections", "overruled", "escalations", "logicalResponses", "httpAttempts", "modelLatencyMs", "wallMs"] as const).map(key => `| ${key} | ${a[key]} | ${b[key]} |`), ""];
  const paired = result.cases.filter(c => c.arms.length === 2);
  const changed = paired.flatMap(c => { const [x, y] = c.arms; return y.metrics.verdicts.filter(v => x.metrics.verdicts.find(w => w.lot_row_id === v.lot_row_id)?.actual !== v.actual).map(v => ({ recall: c.recall, row: v.lot_row_id, before: x.metrics.verdicts.find(w => w.lot_row_id === v.lot_row_id)!.actual, after: v.actual, expected: v.expected })); });
  lines.push(changed.length ? `The critic changed ${changed.length} lot verdict(s). Changes: ${JSON.stringify(changed)}.` : "The critic changed no lot verdicts in the completed pairs. This run does not demonstrate improved lot-verdict accuracy from Ultra.", "", "The all-inventory denominator includes many true negatives. The original 21-row anchor key is shown separately. Coverage disputes are counted per round; a persistent dispute can appear more than once. Final escalations are counted per case, with all rounds retained in JSON. Source labels remain evaluator-only.", "", "## Cases, failures and decisions", "");
  for (const c of result.cases) {
    lines.push(`### ${c.recall} — ${c.title}`, "", `Status: ${c.status}${c.error ? ` (${c.error})` : ""}.`, "");
    for (const arm of c.arms) {
      const m = arm.metrics;
      lines.push(`**${arm.arm}:** ${m.lotVerdicts.correct}/${m.lotVerdicts.total} correct; wrongly quarantined ${m.wronglyQuarantinedUnits} units; missed recalled ${m.missedRecalledUnits} units; ${m.rounds} round(s); ${m.modelCalls.httpAttempts} HTTP attempts, ${m.modelCalls.logicalResponses} response uses, ${m.modelCalls.httpWallMs} ms model time, ${m.wallMs} ms elapsed. Trace: runs/${arm.runId}/trace.jsonl.`, "");
      for (const f of m.lotVerdicts.failures) lines.push(`- LOT FAILURE: row ${f.lot_row_id}, ${f.location} ${f.lot}, ${f.qty} units: expected ${f.expected}, got ${f.actual}. ${f.note}`);
      for (const f of m.coverage.filter(f => f.decision !== f.expected)) lines.push(`- COVERAGE FAILURE: ${f.item_id}: expected ${f.expected}, got ${f.decision}; ${f.reason}`);
      for (const d of m.coverageDisputes) lines.push(`- Coverage dispute, round ${d.round}, ${d.item_id}: code=${d.rule.decision}, worker=${d.model?.decision}, final=${d.final}, resolved=${d.resolved}.`);
      for (const d of m.criticAdjudications) lines.push(`- Adjudication: ${JSON.stringify(d)}`);
      for (const o of m.objections) lines.push(`- Objection: ${JSON.stringify(o)}`);
      for (const o of m.overruledObjections) lines.push(`- Overruled: ${o.summary}`);
      for (const e of m.escalations) lines.push(`- Escalation [${e.urgency}] ${e.to}: ${e.issue}`);
      for (const f of m.fallbacks) lines.push(`- Fallback (${f.agent}): ${f.summary}`);
      if (!m.lotVerdicts.failures.length) lines.push("- No lot-verdict failures.");
      lines.push("");
    }
  }
  lines.push("## Model receipts", "", "Repeated receipt IDs are shared worker inputs or cache reuse, not additional calls. Failed attempts without a receipt are explicitly listed. Provider-reported zero cost is not a pricing promise.", "", "| Recall / arm / agent | Receipt | Routed model | Provider | Latency ms | Input / output tokens | Cost USD | Source |", "|---|---|---|---|---:|---|---:|---|");
  for (const c of result.cases) for (const a of c.arms) for (const r of a.metrics.receipts) lines.push(`| ${c.recall} / ${a.arm} / ${r.agent} | ${r.receiptId ?? "not reported"} | ${r.routedModel ?? r.requestedModel} | ${r.provider ?? "not reported"} | ${r.latencyMs ?? "not reported"} | ${r.inputTokens ?? "?"} / ${r.outputTokens ?? "?"} | ${r.costUsd ?? "not reported"} | ${r.sharedPair ? "shared paired worker reply" : r.cached ? "cached" : r.replayed ? "replayed" : `live HTTP ${r.status}`} |`);
  return lines.join("\n") + "\n";
}

async function main() {
  if (sampleMode) throw new Error("Ablation requires live inference: set SAMPLE_MODE=false");
  need("METERLESS_RUNTIME_TOKEN"); need("METERLESS_BASE_URL");
  if (modelFor("fast") !== DEFAULT_MODELS.fast || modelFor("deep") !== DEFAULT_MODELS.deep) throw new Error("Ablation requires the pinned NVIDIA Nemotron models");
  if (opt("case")) { await oneCase(opt("case")!, opt("out")!); return; }
  const startedAt = new Date().toISOString(), started = Date.now(), deadline = started + 39 * 60_000;
  const dir = path.join(ROOT, "eval", "results"); mkdirSync(dir, { recursive: true });
  const stem = `ablation-${startedAt.slice(0, 10)}`;
  const file = path.join(dir, `${stem}.json`);
  if (existsSync(file)) throw new Error("Today's ablation already exists; refusing to rerun or overwrite the experiment");
  const scratch = path.join(ROOT, "runs", `${stem}-${Date.now()}`); mkdirSync(scratch, { recursive: true });
  const inputs = ["data/snapshot/fda_recalls.jsonl", "data/snapshot/fda_shortages.jsonl", "data/snapshot/fda_ndc_packages.jsonl", "data/sources/hospital_item_master.jsonl", "data/sources/hospital_inventory_lots.jsonl", "data/sources/hospital_dispensing_daily.jsonl", "data/sources/hospital_purchase_orders.jsonl", "data/sources/wholesaler_catalog.csv", "data/drills/recall_updates.jsonl"].map(file => ({ file, sha256: sha256Hex(readFileSync(path.join(ROOT, file), "utf8")) }));
  const methodology = "Ten preselected real recalls (six anchors and four different-product traps), each run without then with the critic. Both arms execute runCase on identical committed data via LocalBackend; all new inference uses Nightshift and pinned NVIDIA Nemotron. Lightning replies are generated live once and shared within each pair, including the cartographer, to control worker sampling noise. Ultra is called live only in the critic arm; changed revision inputs can cause new worker calls. The baseline retains deterministic audits but has no senior model approval. No reporter is included in the scored pipeline. Physical HTTP attempts, shared response uses, elapsed time and receipts are reported separately. Each pair is capped at six minutes; the experiment is capped at 39 minutes. No incomplete arm is scored.";
  const cases: Case[] = [];
  const flush = () => {
    const result = { schema: "lotline.ablation.v1", startedAt, elapsedMs: Date.now() - started, methodology, today: "2026-10-24", inputHashes: inputs, models: DEFAULT_MODELS, cases, totals: { without_critic: totals(cases, "without_critic"), with_critic: totals(cases, "with_critic") } };
    publicWrite(file, result);
    writeFileSync(path.join(dir, `${stem}.md`), markdown(result));
    return result;
  };
  flush();
  for (const scenario of ABLATION_SCENARIOS) {
    const out = path.join(scratch, `${scenario.recall}.json`);
    const remaining = deadline - Date.now();
    if (remaining < 30_000) { cases.push({ recall: scenario.recall, title: scenario.title, kind: scenario.kind, arms: [], status: "not run", error: "experiment time budget exhausted" }); flush(); continue; }
    let error: string | undefined;
    try {
      await promisify(execFile)(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--case", scenario.recall, "--out", out], { cwd: ROOT, timeout: Math.min(360_000, remaining), maxBuffer: 4_000_000, env: { ...process.env, SAMPLE_MODE: "false", LOTLINE_QUIET: "true", LLM_TIMEOUT_MS: "90000" } });
    } catch { error = "pair failed or exceeded its time limit; completed arms retained, incomplete arm unscored"; }
    const result: Case = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { recall: scenario.recall, title: scenario.title, kind: scenario.kind, arms: [], status: "failed" };
    if (error) { result.status = "incomplete"; result.error = error; }
    cases.push(result);
    flush();
    console.log(`${scenario.recall}: ${result.status}; ${result.arms.map(a => `${a.arm} ${a.metrics.lotVerdicts.correct}/${a.metrics.lotVerdicts.total}, wrong ${a.metrics.wronglyQuarantinedUnits} units, missed ${a.metrics.missedRecalledUnits} units`).join("; ")}`);
  }
  console.log(JSON.stringify(flush().totals, null, 2));
  console.log(`Results: ${path.relative(ROOT, file)} and ${stem}.md`);
}
main().catch(e => { console.error((e as Error).message); process.exitCode = 1; });
