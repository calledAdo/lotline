// The handful of SQL expressions that differ between Zetaris (Spark SQL) and the local
// DuckDB backend. Agents choose transforms by name; they never write dialect SQL, which
// also means a model can never inject arbitrary SQL into a query.
export type Dialect = "spark" | "duckdb";

/** Named NDC transforms the Source Cartographer can hypothesise. */
export const NDC_TRANSFORMS = ["identity", "strip_hyphens", "segments_to_11", "lpad_11", "strip_hyphens_lpad_11"] as const;
export type NdcTransform = (typeof NDC_TRANSFORMS)[number];

const part = (d: Dialect, col: string, i: number) =>
  d === "spark" ? `split(${col}, '-')[${i}]` : `split_part(${col}, '-', ${i + 1})`;
const str = (d: Dialect, col: string) => (d === "spark" ? `cast(${col} as string)` : `cast(${col} as varchar)`);

export function ndcExpr(d: Dialect, col: string, t: NdcTransform): string {
  switch (t) {
    case "identity": return str(d, col);
    case "strip_hyphens": return `replace(${str(d, col)}, '-', '')`;
    case "segments_to_11": return `concat(lpad(${part(d, col, 0)}, 5, '0'), lpad(${part(d, col, 1)}, 4, '0'), lpad(${part(d, col, 2)}, 2, '0'))`;
    case "lpad_11": return `lpad(${str(d, col)}, 11, '0')`;
    case "strip_hyphens_lpad_11": return `lpad(replace(${str(d, col)}, '-', ''), 11, '0')`;
  }
}

/** Single-quoted SQL string literal. */
export const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;

/** A safe identifier (table.column); rejects anything that is not a plain name. */
export function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,2}$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}

/** A column as text in either dialect (dates come back as YYYY-MM-DD). */
export const asText = (d: Dialect, col: string) => (d === "spark" ? `cast(${col} as string)` : `cast(${col} as varchar)`);

/** SQL IN-list of string literals. */
export const inList = (values: string[]) => (values.length ? values.map(lit).join(", ") : "NULL");
