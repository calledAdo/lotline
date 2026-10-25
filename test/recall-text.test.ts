import { test } from "node:test";
import assert from "node:assert/strict";
import { editDistance, expiryLabel, firmCore, lotInText, parseExpiry, readLots, sameMonth, strengthInconsistencies } from "../src/recall-text.ts";

test("expiry formats from real recalls", () => {
  assert.equal(expiryLabel(parseExpiry("Exp. Date 10/2028")), "2028-10");
  assert.equal(expiryLabel(parseExpiry("Exp. Date July 31, 2027")), "2027-07-31");
  assert.equal(expiryLabel(parseExpiry("Exp Date: 2/12/2027")), "2027-02-12");
  assert.equal(expiryLabel(parseExpiry("Exp Date: 2027/08")), "2027-08");
  assert.equal(expiryLabel(parseExpiry("Exp. 05/13/2027")), "2027-05-13");
  assert.equal(expiryLabel(parseExpiry("Exp Date 12/2027")), "2027-12");
  assert.equal(parseExpiry("Lot 6133436"), null);
  assert.equal(sameMonth(parseExpiry("10/2028"), "2028-10-31"), true);
  assert.equal(sameMonth(parseExpiry("10/2028"), "2027-10-31"), false);
});

test("fallback lot reader on real code_info", () => {
  const keto = readLots("Lot #: AS1240347A, Exp Date 09/2026; AS1240144A, Exp Date 05/2026; AS1240145A, AS1240146A, Exp Date 06/2026; AS1250295A, Exp Date 05/2027.");
  assert.deepEqual(keto.map(l => [l.lot, expiryLabel(l.expiry)]), [["AS1240347A", "2026-09"], ["AS1240144A", "2026-05"], ["AS1240145A", "2026-06"], ["AS1240146A", "2026-06"], ["AS1250295A", "2027-05"]]);
  assert.deepEqual(readLots("Lot #: 6133436, Exp. Date 10/2028").map(l => l.lot), ["6133436"]);
  assert.deepEqual(readLots("Lots# H03125, H03225, H03325, Exp Date: 2027/08").map(l => l.lot), ["H03125", "H03225", "H03325"]);
  assert.deepEqual(readLots("Lots: 10006417 and 10006418, Exp. 11/30/2026").map(l => l.lot), ["10006417", "10006418"]);
  assert.deepEqual(readLots("Lot # NC185424, Exp Date: 2/12/2027; Lot # NC185479, Exp Date: 2/13/2027").map(l => [l.lot, expiryLabel(l.expiry)]), [["NC185424", "2027-02-12"], ["NC185479", "2027-02-13"]]);
});

test("lots must appear verbatim as whole tokens", () => {
  assert.equal(lotInText("6133436", "Lot #: 6133436, Exp. Date 10/2028"), true);
  assert.equal(lotInText("613343", "Lot #: 6133436, Exp. Date 10/2028"), false);
  assert.equal(lotInText("6133437", "Lot #: 6133436, Exp. Date 10/2028"), false);
  assert.equal(editDistance("6133436", "6133437"), 1);
});

test("FDA's own strength arithmetic error is detected", () => {
  const bad = strengthInconsistencies("Clindamycin Injection USP in 5% Dextrose, 900 mg per 50 mL (12 mg/mL) in GALAXY");
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.computed, 18);
  assert.equal(strengthInconsistencies("Naropin 100 mg per 20 mL (5 mg per mL)").length, 0);
});

test("firm names compare on their core", () => {
  assert.equal(firmCore("Baxter Healthcare Corporation"), "baxter");
  assert.equal(firmCore("Baxter Healthcare Company"), "baxter");
  assert.equal(firmCore("Fresenius Kabi USA, LLC"), "fresenius");
  assert.equal(firmCore("Hospira, Inc., a Pfizer Company"), "hospira");
});
