// Product comparison for alternatives. FDA's NDC directory describes the same product in
// different ways (Baxter "CLINDAMYCIN PHOSPHATE 900 mg/50mL", Hikma "CLINDAMYCIN 18 mg/mL",
// Civica "CLINDAMYCIN 12 mg/mL"), so equivalence needs the ingredient without its salt, the
// concentration in common units, and the unit container and volume from the package text.

const SALTS = /\b(hydrochloride|hcl|phosphate|tromethamine|monohydrate|anhydrous|sulfate|citrate|dihydrate|mesylate|maleate|acetate)\b/g;

export function ingredientCore(name: string): string {
  return name.toLowerCase().replace(SALTS, " ").replace(/\s+/g, " ").trim();
}

export type Strength = { value: number; unit: "mg/mL" | "mEq/mL" | "mg/unit" | "g/100mL"; text: string };

/** Parses the strength part of an active_ingredients entry into a comparable concentration. */
export function parseStrength(text: string): Strength | null {
  const t = text.replace(/\s+/g, " ");
  let m: RegExpMatchArray | null;
  if ((m = t.match(/(\d+(?:\.\d+)?) ?(mg|g|meq) ?\/ ?(\d+(?:\.\d+)?) ?ml/i))) {
    const amount = +m[1]! * (m[2]!.toLowerCase() === "g" ? 1000 : 1), vol = +m[3]!;
    return { value: round(amount / vol), unit: m[2]!.toLowerCase() === "meq" ? "mEq/mL" : "mg/mL", text: m[0]! };
  }
  if ((m = t.match(/(\d+(?:\.\d+)?) ?(mg|g|meq) ?\/ ?ml/i))) {
    return { value: round(+m[1]! * (m[2]!.toLowerCase() === "g" ? 1000 : 1)), unit: m[2]!.toLowerCase() === "meq" ? "mEq/mL" : "mg/mL", text: m[0]! };
  }
  if ((m = t.match(/(\d+(?:\.\d+)?) ?mg ?\/ ?1\b/i))) return { value: +m[1]!, unit: "mg/unit", text: m[0]! };
  return null;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Sodium bicarbonate 8.4% is 84 mg/mL = 1 mEq/mL; treat the two units as one scale for it. */
export function sameStrength(a: Strength | null, b: Strength | null, ingredient: string): boolean {
  if (!a || !b) return false;
  const norm = (s: Strength) => (ingredient.includes("bicarbonate") && s.unit === "mEq/mL" ? { v: s.value * 84, u: "mg/mL" } : { v: s.value, u: s.unit });
  const x = norm(a), y = norm(b);
  return x.u === y.u && Math.abs(x.v - y.v) <= 0.02 * Math.max(x.v, y.v);
}

export type UnitPackage = { container: string | null; volumeMl: number | null; count: number | null };

/** The innermost unit from an NDC directory package description: "25 VIAL ... / 20 mL in 1 VIAL" -> vial, 20 mL. */
export function unitPackage(description: string | null): UnitPackage {
  if (!description) return { container: null, volumeMl: null, count: null };
  const parts = description.split("/").map(s => s.trim());
  const inner = parts[parts.length - 1]!;
  const vol = inner.match(/(\d+(?:\.\d+)?) ?mL in 1 ([A-Z ,-]+?)(?: \(|$)/i);
  const outerMatch = parts[0]!.match(/^(\d+) ([A-Z ,-]+?) in 1/i);
  const outer = outerMatch && !/^m?l$/i.test(outerMatch[2]!.trim()) ? outerMatch : null; // "2000 mL in 1 BAG" is a volume, not a count
  const container = (vol?.[2] ?? inner.match(/in 1 ([A-Z ,-]+?)(?: \(|$)/i)?.[1] ?? outer?.[2] ?? "").split(",")[0]!.trim().toLowerCase() || null;
  return { container, volumeMl: vol ? +vol[1]! : null, count: outer ? +outer[1]! : null };
}
