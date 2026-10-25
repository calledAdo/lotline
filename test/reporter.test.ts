// A number appearing elsewhere in a case does not make a generated assertion true.
// Summary selection must preserve exact fact sentences, including their subjects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSummary } from "../src/agents/reporter.ts";

test("reporter rejects invented prose even when its numbers occur in the case", () => {
  const sentences = ["Recall covers NDC 63323-0286-23.", "Order NDC 43066-0019-10.", "Quarantine 68 units."];
  assert.throws(() => selectSummary({ summary: "Recall covers NDC 43066-0019-10." }, sentences), /sentence/);
  assert.throws(() => selectSummary({ sentences: [0, 1, 9] }, sentences), /sentence/);
  assert.throws(() => selectSummary({ sentences: [1, 2] }, sentences), /sentence/);
  assert.equal(selectSummary({ sentences: [0, 2, 1] }, sentences), [sentences[0], sentences[2], sentences[1]].join(" "));
});
