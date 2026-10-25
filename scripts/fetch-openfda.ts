// Builds the openFDA snapshot Lotline runs on: drug recalls (enforcement), drug shortages and
// NDC directory packages for the molecules in scope. Output is flattened JSON Lines in
// data/snapshot/, small enough to commit, with every NDC kept exactly as FDA writes it.
// openFDA data is public domain (CC0); see https://open.fda.gov/license/.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/env.ts";

export const MOLECULES = ["ropivacaine", "dextrose", "ketorolac", "sodium bicarbonate", "furosemide", "clindamycin"];
const OUT = path.join(ROOT, "data", "snapshot");
const NDC_IN_TEXT = /\b\d{4,5}-\d{3,4}-\d{1,2}\b/g;

type Json = Record<string, any>;

async function getAll(endpoint: string, search: string, sort?: string): Promise<{ url: string; total: number; results: Json[] }> {
  const results: Json[] = [];
  let total = 0;
  let firstUrl = "";
  for (let skip = 0; skip < 1000; skip += 100) {
    const q = new URLSearchParams({ search, limit: "100", skip: String(skip) });
    if (sort) q.set("sort", sort);
    const url = `https://api.fda.gov/${endpoint}.json?${q.toString().replaceAll("%3A", ":").replaceAll("%2B", "+")}`;
    firstUrl ||= url;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) break; // openFDA answers "no matches" with 404
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    const body = (await res.json()) as Json;
    total = body.meta?.results?.total ?? 0;
    results.push(...(body.results ?? []));
    if (results.length >= total) break;
    await new Promise(r => setTimeout(r, 300)); // stay well under openFDA's 240 requests/minute
  }
  return { url: firstUrl, total, results };
}

const one = (v: unknown) => (Array.isArray(v) ? v.join("; ") : (v ?? null));

function recallRow(r: Json, molecule: string) {
  const f = r.openfda ?? {};
  const textNdcs = [...new Set(`${r.product_description ?? ""} ${r.code_info ?? ""}`.match(NDC_IN_TEXT) ?? [])];
  return {
    recall_number: r.recall_number,
    event_id: r.event_id ?? null,
    molecule_query: molecule,
    status: r.status,
    classification: r.classification,
    recalling_firm: r.recalling_firm,
    reason_for_recall: r.reason_for_recall,
    product_description: r.product_description,
    product_quantity: r.product_quantity ?? null,
    code_info: r.code_info ?? null,
    distribution_pattern: r.distribution_pattern ?? null,
    voluntary_mandated: r.voluntary_mandated ?? null,
    recall_initiation_date: r.recall_initiation_date ?? null,
    report_date: r.report_date,
    termination_date: r.termination_date ?? null,
    // Two NDC sources that often disagree: FDA's structured harmonisation, and the text itself.
    openfda_package_ndc: one(f.package_ndc),
    openfda_product_ndc: one(f.product_ndc),
    openfda_generic_name: one(f.generic_name),
    openfda_manufacturer_name: one(f.manufacturer_name),
    text_ndcs: textNdcs.join("; ") || null,
  };
}

function shortageRow(r: Json, molecule: string) {
  const f = r.openfda ?? {};
  return {
    package_ndc: r.package_ndc ?? null,
    molecule_query: molecule,
    generic_name: r.generic_name ?? null,
    presentation: r.presentation ?? null,
    company_name: r.company_name ?? null,
    availability: r.availability ?? null,
    status: r.status ?? null,
    shortage_reason: r.shortage_reason ?? null,
    related_info: r.related_info ?? null,
    dosage_form: r.dosage_form ?? null,
    therapeutic_category: one(r.therapeutic_category),
    initial_posting_date: r.initial_posting_date ?? null,
    update_date: r.update_date ?? null,
    update_type: r.update_type ?? null,
    openfda_route: one(f.route),
  };
}

function ndcPackageRows(p: Json, molecule: string) {
  const ingredients = (p.active_ingredients ?? []) as { name: string; strength: string }[];
  return ((p.packaging ?? []) as Json[]).map(pkg => ({
    package_ndc: pkg.package_ndc,
    product_ndc: p.product_ndc,
    molecule_query: molecule,
    generic_name: p.generic_name ?? null,
    brand_name: p.brand_name ?? null,
    labeler_name: p.labeler_name ?? null,
    dosage_form: p.dosage_form ?? null,
    route: one(p.route),
    active_ingredients: ingredients.map(i => `${i.name} ${i.strength}`).join("; ") || null,
    ingredient_count: ingredients.length,
    package_description: pkg.description ?? null,
    marketing_category: p.marketing_category ?? null,
    marketing_start_date: pkg.marketing_start_date ?? p.marketing_start_date ?? null,
    listing_expiration_date: p.listing_expiration_date ?? null,
    product_type: p.product_type ?? null,
  }));
}

const jsonl = (rows: object[]) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";

async function main() {
  mkdirSync(OUT, { recursive: true });
  const recalls = new Map<string, Json>();
  const shortages: Json[] = [];
  const packages = new Map<string, Json>();
  const queries: Json[] = [];

  for (const m of MOLECULES) {
    const term = m.replace(" ", "+");
    const enf = await getAll("drug/enforcement", `openfda.generic_name:"${term}"+product_description:"${term}"`, "report_date:desc");
    for (const r of enf.results) if (!recalls.has(r.recall_number)) recalls.set(r.recall_number, recallRow(r, m));
    const sh = await getAll("drug/shortages", `generic_name:"${term}"`);
    shortages.push(...sh.results.map(r => shortageRow(r, m)));
    const ndc = await getAll("drug/ndc", `generic_name:"${term}"+AND+finished:true`);
    for (const p of ndc.results) for (const row of ndcPackageRows(p, m)) packages.set(row.package_ndc, row);
    queries.push({ molecule: m, enforcement: { url: enf.url, total: enf.total }, shortages: { url: sh.url, total: sh.total }, ndc: { url: ndc.url, total: ndc.total } });
    console.log(`${m}: ${enf.results.length} recalls, ${sh.results.length} shortage rows, ${ndc.results.length} NDC products`);
  }

  writeFileSync(path.join(OUT, "fda_recalls.jsonl"), jsonl([...recalls.values()]));
  writeFileSync(path.join(OUT, "fda_shortages.jsonl"), jsonl(shortages));
  writeFileSync(path.join(OUT, "fda_ndc_packages.jsonl"), jsonl([...packages.values()]));
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({
    source: "openFDA (U.S. Food and Drug Administration)",
    license: "Public domain / CC0, https://open.fda.gov/license/",
    disclaimer: "openFDA data is unvalidated and must not be relied on for medical care decisions.",
    fetched_at: new Date().toISOString(),
    molecules: MOLECULES,
    counts: { recalls: recalls.size, shortage_rows: shortages.length, ndc_packages: packages.size },
    queries,
  }, null, 2) + "\n");
  console.log(`wrote ${recalls.size} recalls, ${shortages.length} shortage rows, ${packages.size} NDC packages to data/snapshot/`);
}

await main();
