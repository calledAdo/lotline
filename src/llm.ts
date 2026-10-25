// Meterless Nightshift client: Lotline's only AI provider. Two lanes, each pinned to an
// NVIDIA Nemotron model by name (routing modes like meterless/fast may pick a local model):
//   fast = Nemotron 3.5 Lightning 30B (extraction, hypotheses), deep = Nemotron 3 Ultra 550B
// (critique). Every call returns parsed JSON plus the Nightshift compute receipt
// that proves which model answered. `reasoning: false` turns Nemotron's thinking off
// (chat_template_kwargs.enable_thinking) for mechanical extraction: measured on Lightning,
// 2.4 s / 188 tokens instead of 14 s / 1,280 for the same JSON. Judgement calls keep it on
// with a large budget, because a thinking model that runs out of tokens returns nothing.
// Replies are validated; one repair retry; transient
// provider errors get one retry; if a lane is down the caller gets LlmUnavailable and uses
// its deterministic fallback, which the trace labels.
import { env, need, sampleMode } from "./env.ts";
import { record, replay, SampleMissing } from "./cassette.ts";
import type { Trace } from "./trace.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { requestKey, type Recording } from "./cassette.ts";

export type Lane = "fast" | "deep";

export type Receipt = {
  receiptId: string | null;
  requestedModel: string;
  routedModel: string | null;
  provider: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  privacyPath: string | null;
  replayed: boolean;
  cached?: boolean;
  sharedPair?: boolean;
};

export class LlmUnavailable extends Error {}

export type ChatRequest = {
  model: string; temperature: number; max_tokens: number;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  chat_template_kwargs?: { enable_thinking: boolean };
};
export type ChatResponse = { status: number; body: any };

// A scoped runtime lets offline tests exercise real agents without contacting providers.
// Replay is also injectable, so a single live run can be checked without library collisions.
type ModelRuntime = { mode: "deterministic" | "replay" | "live"; recordings?: Map<string, Recording>; fastCache?: Map<string, ChatResponse>; onRequest?: (request: ChatRequest) => void };
const runtime = new AsyncLocalStorage<ModelRuntime>();
export const withModelRuntime = <T>(options: ModelRuntime, work: () => T): T => runtime.run(options, work);
const liveCaches = new WeakMap<Trace, Map<string, ChatResponse>>();

export const DEFAULT_MODELS = { fast: "nvidia/nemotron-3.5-lightning-30b-a3b", deep: "nvidia/nemotron-3-ultra-550b-a55b" };

export const modelFor = (lane: Lane) => (lane === "fast" ? env.METERLESS_FAST_MODE : env.METERLESS_DEEP_MODE) || DEFAULT_MODELS[lane];

async function post(req: ChatRequest): Promise<ChatResponse> {
  const base = need("METERLESS_BASE_URL").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${need("METERLESS_RUNTIME_TOKEN")}`,
      "meterless-app": env.METERLESS_APP_ID ?? "lotline",
      "meterless-scope": "user",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(Number(env.LLM_TIMEOUT_MS ?? 180_000)),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function receiptOf(body: any, requestedModel: string, replayed: boolean): Receipt {
  const m = body?.meterless ?? {};
  return {
    receiptId: m.receipt_id ?? m.receipt?.receipt_id ?? null,
    requestedModel,
    routedModel: m.routed_model ?? m.winning_route?.model ?? body?.model ?? null,
    provider: m.winning_route?.provider ?? m.egress?.destination ?? null,
    latencyMs: m.usage?.latency_ms ?? null,
    inputTokens: m.usage?.input_tokens ?? null,
    outputTokens: m.usage?.output_tokens ?? null,
    costUsd: m.cost?.actual_usd ?? null,
    privacyPath: m.privacy?.path ?? null,
    replayed,
  };
}

/** Pulls the last complete JSON object (or array) out of a reply that may include reasoning. */
export function extractJson(text: string): unknown {
  // Strip only a leading reasoning block. Fences outside JSON need no cleanup, and
  // global replacements would silently change literal strings inside valid JSON.
  const cleaned = text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");
  const candidates: string[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const open = cleaned[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < cleaned.length; j++) {
      const ch = cleaned[j];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) { candidates.push(cleaned.slice(i, j + 1)); i = j; break; }
    }
  }
  for (let k = candidates.length - 1; k >= 0; k--) {
    try { return JSON.parse(candidates[k]!); } catch { /* try the previous block */ }
  }
  throw new Error("no JSON object found in model reply");
}

export type ChatJsonOptions<T> = {
  lane: Lane;
  agent: string;
  purpose: string;
  system: string;
  user: string;
  validate: (value: unknown) => T;
  /** Nemotron thinking on (default) for judgement; off for mechanical extraction. */
  reasoning?: boolean;
  maxTokens?: number;
  temperature?: number;
  trace: Trace;
  runDir?: string;
};

export async function chatJson<T>(o: ChatJsonOptions<T>): Promise<{ value: T; receipt: Receipt }> {
  const mode = runtime.getStore()?.mode ?? (sampleMode ? "replay" : "live");
  const model = modelFor(o.lane);
  const messages: ChatRequest["messages"] = [{ role: "system", content: o.system }, { role: "user", content: o.user }];
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reasoning = o.reasoning ?? true;
    const req: ChatRequest = { model, temperature: o.temperature ?? 0.2, max_tokens: o.maxTokens ?? (reasoning ? 8000 : 2000), messages: [...messages] };
    if (!reasoning) req.chat_template_kwargs = { enable_thinking: false };
    runtime.getStore()?.onRequest?.(req);
    if (mode === "deterministic") throw new LlmUnavailable(`deterministic mode for ${o.agent}/${o.purpose}`);
    let res: ChatResponse;
    let cached = false;
    if (mode === "replay") {
      try {
        const library = runtime.getStore()?.recordings;
        if (library) {
          const hit = library.get(requestKey("llm", req));
          if (!hit) throw new SampleMissing(requestKey("llm", req), "llm");
          res = hit.response as ChatResponse;
        } else res = replay<ChatResponse>("llm", req);
      }
      catch (e) {
        if (e instanceof SampleMissing) throw new LlmUnavailable(`no recording for ${o.agent}/${o.purpose}`);
        throw e;
      }
    } else {
      const ownCache = liveCaches.get(o.trace) ?? new Map<string, ChatResponse>();
      liveCaches.set(o.trace, ownCache);
      const cache = (o.lane === "fast" ? runtime.getStore()?.fastCache : undefined) ?? ownCache;
      const key = requestKey("llm", req);
      const hit = cache.get(key);
      cached = !!hit;
      res = hit ?? await callWithRetry(req, o);
      if (res.status === 200) cache.set(key, res);
    }
    const receipt = receiptOf(res.body, model, mode === "replay");
    if (cached) receipt.cached = true;
    if (cached && o.lane === "fast" && runtime.getStore()?.fastCache) receipt.sharedPair = true;
    const content = String(res.body?.choices?.[0]?.message?.content ?? "");
    // Every response, including rejected JSON and failed calls, keeps its compute receipt.
    // Live HTTP calls are traced in callWithRetry; replay/cache events are labelled here.
    if (mode === "replay" || cached) o.trace.emit("llm", o.agent, `${o.purpose} -> ${receipt.routedModel ?? model} (${cached ? "cached within run" : "replayed"})`, {
      lane: o.lane, purpose: o.purpose, reasoning, attempt, status: res.status, requestKey: requestKey("llm", req), receipt,
    });
    if (res.status !== 200) throw new LlmUnavailable(`Nightshift ${res.status} for ${model}`);
    try {
      const value = o.validate(extractJson(content));
      return { value, receipt };
    } catch (err) {
      lastError = (err as Error).message;
      o.trace.emit("revision", o.agent, `${o.purpose}: reply rejected (${lastError}); asking the model to repair it`, { lane: o.lane, attempt, receipt });
      messages.push({ role: "assistant", content: content.slice(-6000) }, { role: "user", content: `That reply was rejected: ${lastError}. Reply again with ONLY the JSON object in the required shape.` });
    }
  }
  throw new LlmUnavailable(`${o.agent}/${o.purpose}: no valid reply after repair (${lastError})`);
}

async function callWithRetry(req: ChatRequest, o: ChatJsonOptions<unknown>): Promise<ChatResponse> {
  let res: ChatResponse | undefined;
  for (let i = 0; i < 2; i++) {
    const started = Date.now();
    try {
      res = await post(req);
    } catch (err) {
      res = { status: 599, body: { error: { message: "Provider connection failed or timed out" } } };
    }
    if (o.runDir) record(o.runDir, "llm", req, res);
    const receipt = receiptOf(res.body, req.model, false);
    o.trace.emit("llm", o.agent, `${o.purpose} -> ${receipt.routedModel ?? req.model} (live, HTTP ${res.status}) ${receipt.latencyMs ?? "?"}ms`, {
      lane: o.lane, purpose: o.purpose, reasoning: o.reasoning ?? true, retry: i, status: res.status, elapsedMs: Date.now() - started, requestKey: requestKey("llm", req), receipt,
    });
    if (res.status === 200 || (res.status < 500 && res.status !== 429)) return res;
    o.trace.emit("fallback", o.agent, `Nightshift returned ${res.status} on ${req.model}; retrying once`, { status: res.status });
    await new Promise(r => setTimeout(r, 2000));
  }
  return res!;
}
