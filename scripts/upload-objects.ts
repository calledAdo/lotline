// Uploads the file-based sources to the S3-compatible store Zetaris reads from. Each table
// gets its own prefix, because Zetaris registers a filestore table over a path. Zetaris reads
// JSON files as one multi-line document, so JSON Lines are uploaded as a top-level array,
// which Spark then reads as one row per element.
import { readFileSync } from "node:fs";
import path from "node:path";
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ROOT, env, need } from "../src/env.ts";

const bucket = env.LOTLINE_BUCKET ?? "lotline";
const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: need("S3_ACCESS_KEY"), secretAccessKey: need("S3_SECRET_KEY") },
});

export const OBJECTS: { file: string; key: string; type: string }[] = [
  { file: "data/snapshot/fda_recalls.jsonl", key: "fda/recalls/fda_recalls.json", type: "application/json" },
  { file: "data/snapshot/fda_shortages.jsonl", key: "fda/shortages/fda_shortages.json", type: "application/json" },
  { file: "data/snapshot/fda_ndc_packages.jsonl", key: "fda/ndc_packages/fda_ndc_packages.json", type: "application/json" },
  { file: "data/sources/wholesaler_catalog.csv", key: "wholesaler/catalog/wholesaler_catalog.csv", type: "text/csv" },
  { file: "data/drills/recall_updates.baseline.jsonl", key: "fda/recall_updates/recall_updates.json", type: "application/json" },
];

try { await s3.send(new HeadBucketCommand({ Bucket: bucket })); } catch { await s3.send(new CreateBucketCommand({ Bucket: bucket })); }
for (const o of OBJECTS) {
  const raw = readFileSync(path.join(ROOT, o.file), "utf8");
  const body = o.file.endsWith(".jsonl") ? "[\n" + raw.trim().split("\n").join(",\n") + "\n]\n" : raw;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: o.key, Body: body, ContentType: o.type }));
  console.log(`s3://${bucket}/${o.key}  (${body.length} bytes)`);
}
