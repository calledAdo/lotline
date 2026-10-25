import { test } from "node:test";
import assert from "node:assert/strict";
import { ingredientCore, parseStrength, sameStrength, unitPackage } from "../src/pharma.ts";

test("salts are removed from ingredient names, but not from sodium bicarbonate", () => {
  assert.equal(ingredientCore("CLINDAMYCIN PHOSPHATE"), "clindamycin");
  assert.equal(ingredientCore("ROPIVACAINE HYDROCHLORIDE"), "ropivacaine");
  assert.equal(ingredientCore("KETOROLAC TROMETHAMINE"), "ketorolac");
  assert.equal(ingredientCore("DEXTROSE MONOHYDRATE"), "dextrose");
  assert.equal(ingredientCore("SODIUM BICARBONATE"), "sodium bicarbonate");
});

test("concentrations compare across FDA's different spellings", () => {
  const baxter = parseStrength("900 mg/50mL"), hikma = parseStrength("18 mg/mL"), civica = parseStrength("12 mg/mL");
  assert.equal(baxter!.value, 18);
  assert.equal(sameStrength(baxter, hikma, "clindamycin"), true);
  assert.equal(sameStrength(baxter, civica, "clindamycin"), false);
  assert.equal(sameStrength(parseStrength("70 g/100mL"), parseStrength("700 mg/mL"), "dextrose"), true);
  assert.equal(sameStrength(parseStrength("84 mg/mL"), parseStrength("1 meq/mL"), "sodium bicarbonate"), true);
  assert.equal(parseStrength("80 mg/1")!.unit, "mg/unit");
});

test("unit container and volume come from the innermost package", () => {
  assert.deepEqual(unitPackage("25 VIAL, SINGLE-DOSE in 1 CARTON (63323-286-23)  / 20 mL in 1 VIAL, SINGLE-DOSE (63323-286-05)"), { container: "vial", volumeMl: 20, count: 25 });
  assert.deepEqual(unitPackage("2000 mL in 1 BAG (0338-0719-06)"), { container: "bag", volumeMl: 2000, count: null });
  assert.equal(unitPackage("10 CARTON in 1 PACKAGE (0409-6637-14)  / 1 SYRINGE in 1 CARTON / 50 mL in 1 SYRINGE (0409-6637-24)").container, "syringe");
  assert.equal(unitPackage("100 TABLET in 1 BOTTLE (69315-118-01)").container, "bottle");
});
