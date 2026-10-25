// Recall-change drills. FDA routinely revises ongoing recalls (openFDA has 139 drug and
// food recall records that mention an expanded recall); Lotline's change feed
// (fda_updates.recall_updates) is where such revisions land. This script writes clearly
// labelled DRILL revisions into that feed, locally and, in live mode, to object storage
// where Zetaris reads it.
//   tsx scripts/drill.ts expand D-0727-2026     add lot 6133437 to the Naropin recall
//   tsx scripts/drill.ts reset                  back to the baseline (no revisions)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ROOT, env, need, sampleMode } from "../src/env.ts";

const FEED = path.join(ROOT, "data", "drills", "recall_updates.jsonl");
const BASELINE = path.join(ROOT, "data", "drills", "recall_updates.baseline.jsonl");

export const DRILLS: Record<string, { code_info: string; note: string }> = {
  "D-0727-2026": { code_info: "Lot #: 6133436, 6133437, Exp. Date 10/2028", note: "DRILL: recall expanded to adjacent lot 6133437 (simulated revision, not an FDA record)" },
  "D-0486-2026": { code_info: "Lots# H03125, H03225, H03325, H03425, Exp Date: 2027/08 and 2027/09", note: "DRILL: recall expanded to lot H03425 (simulated revision, not an FDA record)" },
};

async function publish(lines: string[]) {
  writeFileSync(FEED, lines.join("\n") + "\n");
  if (sampleMode) { console.log("SAMPLE_MODE: change feed updated locally"); return; }
  const s3 = new S3Client({ endpoint: env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: need("S3_ACCESS_KEY"), secretAccessKey: need("S3_SECRET_KEY") } });
  await s3.send(new PutObjectCommand({ Bucket: env.LOTLINE_BUCKET ?? "lotline", Key: "fda/recall_updates/recall_updates.json", Body: "[\n" + lines.join(",\n") + "\n]\n", ContentType: "application/json" }));
  console.log("change feed published to s3://lotline/fda/recall_updates/ (Zetaris: fda_updates.recall_updates)");
}

const [cmd, recall] = process.argv.slice(2);
if (cmd === "reset") {
  await publish(readFileSync(BASELINE, "utf8").trim().split("\n"));
} else if (cmd === "expand" && recall && DRILLS[recall]) {
  const base = readFileSync(path.join(ROOT, "data", "snapshot", "fda_recalls.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find(r => r.recall_number === recall);
  const lines = readFileSync(FEED, "utf8").trim().split("\n").filter(Boolean);
  const seq = lines.length;
  lines.push(JSON.stringify({ recall_number: recall, update_seq: seq, update_date: new Date().toISOString().slice(0, 10), update_kind: "expansion", product_description: base.product_description, code_info: DRILLS[recall]!.code_info, classification: base.classification, status: base.status, drill: true, note: DRILLS[recall]!.note }));
  await publish(lines);
  console.log(`${recall}: ${DRILLS[recall]!.note}`);
} else {
  console.log(`usage: drill.ts expand <${Object.keys(DRILLS).join("|")}> | drill.ts reset`);
  process.exit(2);
}
