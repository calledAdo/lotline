// National Drug Codes. FDA writes a 10-digit NDC in one of three hyphenated layouts
// (4-4-2, 5-3-2 or 5-4-1). Hospital, billing and wholesaler systems usually store the
// 11-digit 5-4-2 form with the short segment zero-padded and the hyphens removed, and a
// spreadsheet round trip often strips the leading zero as well. These helpers are the
// deterministic ground truth that the Source Cartographer's hypotheses are checked against.

export type NdcLayout = "4-4-2" | "5-3-2" | "5-4-1" | "5-4-2";

const LAYOUT: Record<string, NdcLayout> = { "4,4,2": "4-4-2", "5,3,2": "5-3-2", "5,4,1": "5-4-1", "5,4,2": "5-4-2" };

/** Layout of a hyphenated NDC, or null when it is not one. */
export function layoutOf(ndc: string): NdcLayout | null {
  const parts = ndc.trim().split("-");
  if (parts.length !== 3 || !parts.every(p => /^\d+$/.test(p))) return null;
  return LAYOUT[parts.map(p => p.length).join(",")] ?? null;
}

/** Converts a hyphenated FDA NDC (any layout) to the 11-digit 5-4-2 form without hyphens. */
export function toNdc11(ndc: string): string | null {
  const layout = layoutOf(ndc);
  if (!layout) return null;
  const [a, b, c] = ndc.trim().split("-") as [string, string, string];
  return a.padStart(5, "0") + b.padStart(4, "0") + c.padStart(2, "0");
}

/** Hyphenates an 11-digit NDC as 5-4-2. */
export function format11(ndc11: string): string {
  return `${ndc11.slice(0, 5)}-${ndc11.slice(5, 9)}-${ndc11.slice(9)}`;
}

/**
 * Normalises any NDC-like value seen in the wild to 11 digits: hyphenated FDA forms,
 * 11-digit strings, and numbers that lost their leading zero(s) in a CSV or spreadsheet.
 * Returns null when the value cannot be an NDC.
 */
export function normalize(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s.includes("-")) return toNdc11(s);
  // A spreadsheet can strip up to three leading zeros (labeler 00054 -> 54), leaving 8 digits.
  if (!/^\d+$/.test(s) || s.length > 11 || s.length < 8) return null;
  return s.padStart(11, "0");
}

/** The labeler (first segment) of a normalised NDC: who markets the product. */
export function labelerOf(ndc11: string): string {
  return ndc11.slice(0, 5);
}

/** The product (labeler + product code) of a normalised NDC, ignoring package size. */
export function productOf(ndc11: string): string {
  return ndc11.slice(0, 9);
}

/** Every hyphenated NDC that appears in free text (recall descriptions, code_info). */
export function ndcsInText(text: string | null | undefined): string[] {
  return [...new Set((text ?? "").match(/\b\d{4,5}-\d{3,4}-\d{1,2}\b/g) ?? [])].filter(n => layoutOf(n));
}
