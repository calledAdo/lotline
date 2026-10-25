// Labelled fixture drills, published to the same objects Zetaris reads in live mode.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ROOT, env, need, sampleMode, redact } from "../src/env.ts";

export const DRILLS: Record<string, { code_info: string; note: string }> = {
  "D-0727-2026": { code_info: "Lot #: 6133436, 6133437, Exp. Date 10/2028", note: "DRILL: recall expanded to adjacent lot 6133437 (simulated revision, not an FDA record)" },
  "D-0486-2026": { code_info: "Lots# H03125, H03225, H03325, H03425, Exp Date: 2027/08 and 2027/09", note: "DRILL: recall expanded to lot H03425 (simulated revision, not an FDA record)" },
};
const files = [
  { file: "data/drills/recall_updates.jsonl", baseline: "data/drills/recall_updates.baseline.jsonl", key: "fda/recall_updates/recall_updates.json" },
  { file: "data/sources/wholesaler_catalog.csv", baseline: "data/drills/wholesaler_catalog.baseline.csv", key: "wholesaler/catalog/wholesaler_catalog.csv" },
  { file: "data/snapshot/fda_shortages.jsonl", baseline: "data/drills/fda_shortages.baseline.jsonl", key: "fda/shortages/fda_shortages.json" },
];
export function wholesalerDrill(csv: string): string {
  const lines = csv.trimEnd().split("\n"), headers = lines[0].split(",");
  const ndc = headers.indexOf("ndc"), status = headers.indexOf("status");
  let changed = false;
  const result = lines.map((line, i) => {
    const values = line.split(",");
    if (i && values[ndc] === "43066001910") { values[status] = "Backorder"; changed = true; return values.join(","); }
    return line;
  }).join("\n") + "\n";
  if (!changed) throw new Error("DRILL target Baxter 43066-0019-10 not in catalog");
  return result;
}
export function shortageDrill(jsonl: string): string {
  let changed = false;
  const result = jsonl.trimEnd().split("\n").map(line => {
    const row = JSON.parse(line);
    if (row.package_ndc === "63323-286-23") { row.availability = "Unavailable"; row.status = "Current"; row.related_info = "DRILL: simulated shortage status, not an FDA announcement"; changed = true; }
    return JSON.stringify(row);
  }).join("\n") + "\n";
  if (!changed) throw new Error("DRILL target Naropin 63323-286-23 not in shortage snapshot");
  return result;
}
export async function applyDrill(cmd: string, recall?: string, root = ROOT, live = !sampleMode) {
  const changed: typeof files = [];
  if (cmd === "reset") {
    for (const f of files) { writeFileSync(path.join(root, f.file), readFileSync(path.join(root, f.baseline))); changed.push(f); }
  } else if (cmd === "wholesaler" || cmd === "shortage") {
    const f = files[cmd === "wholesaler" ? 1 : 2];
    writeFileSync(path.join(root, f.file), (cmd === "wholesaler" ? wholesalerDrill : shortageDrill)(readFileSync(path.join(root, f.file), "utf8"))); changed.push(f);
  } else if (cmd === "expand" && recall && DRILLS[recall]) {
    const base = readFileSync(path.join(root, "data/snapshot/fda_recalls.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find(r => r.recall_number === recall);
    const lines = readFileSync(path.join(root, files[0].file), "utf8").trim().split("\n").filter(Boolean);
    lines.push(JSON.stringify({ recall_number: recall, update_seq: lines.length, update_date: new Date().toISOString().slice(0, 10), update_kind: "expansion", product_description: base.product_description, code_info: DRILLS[recall].code_info, classification: base.classification, status: base.status, drill: true, note: DRILLS[recall].note }));
    writeFileSync(path.join(root, files[0].file), lines.join("\n") + "\n"); changed.push(files[0]);
  } else throw new Error(`usage: drill.ts expand <${Object.keys(DRILLS).join("|")}> | wholesaler | shortage | reset`);
  if (live) {
    const s3 = new S3Client({ endpoint: env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: need("S3_ACCESS_KEY"), secretAccessKey: need("S3_SECRET_KEY") } });
    for (const f of changed) {
      const data = readFileSync(path.join(root, f.file), "utf8"), csv = f.file.endsWith(".csv");
      await s3.send(new PutObjectCommand({ Bucket: env.LOTLINE_BUCKET ?? "lotline", Key: f.key, Body: csv ? data : JSON.stringify(data.trim().split("\n").map(l => JSON.parse(l))), ContentType: csv ? "text/csv" : "application/json" }));
    }
    s3.destroy();
  }
  console.log(`DRILL ${cmd}: ${changed.length} source(s) ${live ? "updated locally and in object storage" : "updated locally (SAMPLE_MODE)"}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) applyDrill(process.argv[2], process.argv[3]).catch(e => { console.error(redact(e.message)); process.exitCode = 1; });
