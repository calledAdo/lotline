// Real provider replies can mix reasoning and fenced JSON; parsing must preserve JSON
// string contents and choose the final complete response rather than a reasoning draft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../src/llm.ts";
test("extractJson handles reasoning, fences, nested objects, arrays and escaped braces", () => {
  assert.deepEqual(extractJson('<think>{"draft":true}</think>\n```json\n{"items":[{"reason":"a } and \\\"quote\\\"", "x":[1,2]}]}\n```'), {items:[{reason:'a } and "quote"',x:[1,2]}]});
  assert.deepEqual(extractJson('Draft {"a":1} Final [{"b":2}]'), [{b:2}]);
  assert.throws(()=>extractJson("No JSON here"),/no JSON/);
  assert.throws(()=>extractJson('{"a":'),/no JSON/);
});
test("extractJson preserves fence and think markers inside valid JSON strings", () => {
  assert.deepEqual(extractJson('{"text":"```json <think>literal</think>"}'), {text:"```json <think>literal</think>"});
});
