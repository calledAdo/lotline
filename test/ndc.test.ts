import { test } from "node:test";
import assert from "node:assert/strict";
import { format11, labelerOf, layoutOf, ndcsInText, normalize, productOf, toNdc11 } from "../src/ndc.ts";

test("layouts are recognised", () => {
  assert.equal(layoutOf("0409-6637-24"), "4-4-2");
  assert.equal(layoutOf("63323-286-05"), "5-3-2");
  assert.equal(layoutOf("50090-2713-0"), "5-4-1");
  assert.equal(layoutOf("00338-0719-06"), "5-4-2");
  assert.equal(layoutOf("6133436"), null);
  assert.equal(layoutOf("12-34-56"), null);
});

test("each FDA layout converts to the same 11-digit form hospitals store", () => {
  assert.equal(toNdc11("0409-6637-24"), "00409663724");   // Hospira sodium bicarbonate, 4-4-2
  assert.equal(toNdc11("63323-286-23"), "63323028623");   // Naropin 0.5% tray, 5-3-2
  assert.equal(toNdc11("50090-2713-0"), "50090271300");   // A-S Medication, 5-4-1
  assert.equal(toNdc11("00338-0719-06"), "00338071906");  // Baxter dextrose written 5-4-2
  assert.equal(toNdc11("0338-0719-06"), "00338071906");   // ...and the same product written 4-4-2
});

test("normalize repairs values that lost leading zeros in a CSV", () => {
  assert.equal(normalize(338071906), "00338071906");
  assert.equal(normalize("409663724"), "00409663724");
  assert.equal(normalize("63323028623"), "63323028623");
  assert.equal(normalize("54430125"), "00054430125");    // Hikma 0054-4301-25 after Excel
  assert.equal(normalize("12345"), null);
  assert.equal(normalize(null), null);
});

test("segments and formatting", () => {
  assert.equal(format11("63323028623"), "63323-0286-23");
  assert.equal(labelerOf("63323028623"), "63323");
  assert.equal(productOf("63323028623"), "633230286");
});

test("NDCs are found in recall text", () => {
  const desc = "Naropin ... NDC Tray: 63323-286-23; NDC Vial:  63323-286-05 ... Case NDC: 00409-6637-14.";
  assert.deepEqual(ndcsInText(desc), ["63323-286-23", "63323-286-05", "00409-6637-14"]);
  assert.deepEqual(ndcsInText("Lot #: 6133436, Exp. Date 10/2028"), []);
});
