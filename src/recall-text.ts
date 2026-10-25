// Deterministic readers for FDA recall text. They are the fallback when no model is
// available and the cross-check when one is: the model's reading must agree with what is
// literally in the text, and anything the model adds that is not in the text is dropped.

export type Expiry = { year: number; month: number; day?: number; text: string };
export type LotConstraint = { lot: string; expiry: Expiry | null };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parses the expiry formats seen in openFDA code_info. Month precision is what recalls use. */
export function parseExpiry(text: string): Expiry | null {
  const t = text.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/\b(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?\b/))) return mk(+m[1]!, +m[2]!, m[3] ? +m[3] : undefined, m[0]!);
  if ((m = t.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/))) return mk(+m[3]!, +m[1]!, +m[2]!, m[0]!);
  if ((m = t.match(/\b(\d{1,2})[/-](\d{4})\b/))) return mk(+m[2]!, +m[1]!, undefined, m[0]!);
  if ((m = t.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/))) {
    const mon = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    if (mon >= 0) return mk(+m[3]!, mon + 1, +m[2]!, m[0]!);
  }
  if ((m = t.match(/\b([A-Za-z]{3,9})\.?\s+(\d{4})\b/))) {
    const mon = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    if (mon >= 0) return mk(+m[2]!, mon + 1, undefined, m[0]!);
  }
  return null;
}

function mk(year: number, month: number, day: number | undefined, text: string): Expiry | null {
  if (month < 1 || month > 12 || year < 1990 || year > 2100) return null;
  return { year, month, ...(day ? { day } : {}), text };
}

export const sameMonth = (a: Expiry | null, isoDate: string) => !!a && isoDate.slice(0, 7) === `${a.year}-${String(a.month).padStart(2, "0")}`;
export const expiryLabel = (e: Expiry | null) => (e ? `${e.year}-${String(e.month).padStart(2, "0")}${e.day ? `-${String(e.day).padStart(2, "0")}` : ""}` : null);

const DATE_LIKE = /^\d{1,4}([/-]\d{1,4}){1,2}$/;
const NOT_LOT = /^(lot|lots|exp|expiry|expiration|date|bud|ndc|and|use|by|the|of)$/i;

/**
 * Fallback lot reader. Splits code_info into segments at ";", reads lot-like tokens
 * (letters and digits, at least 5 characters, at least one digit) and attaches the
 * expiry that follows them in the same segment, or the last expiry seen.
 */
export function readLots(codeInfo: string | null | undefined): LotConstraint[] {
  if (!codeInfo) return [];
  const out: LotConstraint[] = [];
  for (const segment of codeInfo.split(/;|\n/)) {
    const expIdx = segment.search(/\b(exp|expir|bud\b|use by)/i);
    const lotPart = expIdx >= 0 ? segment.slice(0, expIdx) : segment;
    const expiry = expIdx >= 0 ? parseExpiry(segment.slice(expIdx)) : null;
    const tokens = (lotPart.match(/[A-Za-z0-9@-]{5,}/g) ?? []).filter(tok => /\d/.test(tok) && !DATE_LIKE.test(tok) && !NOT_LOT.test(tok) && !/^\d{4,5}-\d{3,4}-\d{1,2}$/.test(tok));
    for (const lot of tokens) out.push({ lot, expiry });
  }
  // Lots listed before a shared "Exp" inherit it ("AS1240145A, AS1240146A, Exp Date 06/2026").
  return out;
}

/** True when the lot string appears in the recall text as a whole token. */
export function lotInText(lot: string, codeInfo: string | null | undefined): boolean {
  if (!codeInfo || !lot) return false;
  const esc = lot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, "i").test(codeInfo);
}

/** Levenshtein distance, for "near miss" lots (6133436 vs 6133437). */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/**
 * Checks "<dose> mg per <volume> mL (<conc> mg/mL)" statements for arithmetic consistency.
 * FDA's own text is sometimes wrong (D-0815-2026 says "900 mg per 50 mL (12 mg/mL)").
 */
export function strengthInconsistencies(text: string): { statement: string; computed: number; stated: number }[] {
  const out: { statement: string; computed: number; stated: number }[] = [];
  const re = /(\d+(?:\.\d+)?)\s*mg\s*(?:per|\/|in)\s*(\d+(?:\.\d+)?)\s*mL\s*\((\d+(?:\.\d+)?)\s*mg\s*(?:per|\/)\s*mL\)/gi;
  for (const m of text.matchAll(re)) {
    const computed = +m[1]! / +m[2]!, stated = +m[3]!;
    if (Math.abs(computed - stated) > 0.05 * stated) out.push({ statement: m[0]!, computed: Math.round(computed * 100) / 100, stated });
  }
  return out;
}

/** Firm names reduced to a comparable core ("Baxter Healthcare Corporation" -> "baxter"). */
export function firmCore(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/[,.]/g, " ").replace(/\b(inc|llc|ltd|limited|corp|corporation|company|co|usa|us|healthcare|pharmaceuticals?|pharma|private|labs?|laboratories|a|pfizer|the|of)\b/g, " ").replace(/\s+/g, " ").trim().split(" ")[0] ?? "";
}

/** Labelers that repackage other manufacturers' product; their stock may come from a recalled source. */
export const REPACKAGER = /repack|prepack|medication solutions|purchasing solutions|proficient rx|quality care|nucare|direct_rx|direct rx|asclemed|henry schein|cardinal|mckesson|medline|preferred pharmaceuticals|lake erie|aphena|stat rx|unit dose services|healthfirst|hf acquisition|propharma/i;
