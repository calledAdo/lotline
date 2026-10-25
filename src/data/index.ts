import { env, sampleMode } from "../env.ts";
import { LocalBackend } from "./local.ts";
import { ZetarisBackend } from "./zetaris.ts";
import type { DataBackend } from "./backend.ts";

export * from "./backend.ts";
export * from "./dialect.ts";

/** Zetaris in live mode; DuckDB over the committed files in SAMPLE_MODE (or DATA_BACKEND=duckdb). */
export function openBackend(runDir?: string): DataBackend {
  if (sampleMode || env.DATA_BACKEND === "duckdb") return new LocalBackend();
  return new ZetarisBackend(runDir);
}
