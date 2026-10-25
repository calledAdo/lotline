// Replay hashes must tolerate storage differences without erasing identifier semantics;
// promotion must reject credential-shaped content before writing anything public.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stableRows } from "../src/data/rows.ts";
import { requestKey } from "../src/cassette.ts";
import { selectRecordings } from "../scripts/promote-cassette.ts";
import { assertNoSecrets } from "../src/secrets.ts";

test("row normalization gives byte-identical prompts across numeric, null and row/column order differences", () => {
  const live = [{ ndc11: "00409663724", qty_units: "10.0", lot_row_id: "2", eta: null }, { ndc11: "63323028623", qty_units: "4", lot_row_id: "1", eta: "2026-11-15" }];
  const local = [{ eta: "2026-11-15", lot_row_id: 1, qty_units: 4, ndc11: "63323028623" }, { eta: undefined, lot_row_id: 2, qty_units: 10, ndc11: "00409663724" }];
  const prompt = (rows: Record<string, unknown>[]) => ({ messages: [{ role: "user", content: JSON.stringify(stableRows(rows)) }] });
  assert.deepEqual(prompt(live), prompt(local));
  assert.equal(requestKey("llm", prompt(live)), requestKey("llm", prompt(local)));
  assert.ok(JSON.stringify(stableRows(live)).includes("00409663724"));
});

test("promotion keeps only deduplicated model recordings and verifies request integrity", () => {
  const request = { messages: [] }, r = { kind: "llm", key: requestKey("llm", request), request, response: { status: 200 }, recordedAt: "2026-10-25" };
  const lines = [r, { kind: "sql", request: { sql: "SELECT 1" } }, r].map(x => JSON.stringify(x)).join("\n");
  assert.equal(selectRecordings(lines).length, 1);
  assert.throws(() => selectRecordings(JSON.stringify({ ...r, key: "wrong" })), /hash/);
  const retry = [{ ...r, response: { status: 599 } }, r].map(x => JSON.stringify(x)).join("\n");
  assert.deepEqual(selectRecordings(retry)[0].response, { status: 200 });
});

test("public artifacts refuse credentials and masked credentials without echoing them", () => {
  for (const text of ['{"password":"test-only-placeholder"}', "Bearer " + "x".repeat(24), "sk-" + "x".repeat(24), "already *** masked"]) assert.throws(() => assertNoSecrets(text), /value withheld/);
  assert.doesNotThrow(() => assertNoSecrets('{"inputTokens":100,"outputTokens":30,"receiptId":"receipt-example","key":"llm_abcdef"}'));
});
