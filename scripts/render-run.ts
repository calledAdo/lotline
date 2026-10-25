// Regenerate HTML from existing packet, trace and watch metadata without querying data
// or calling models. Useful for viewing recordings created before the HTML renderer.
import path from "node:path";
import { ROOT } from "../src/env.ts";
import { renderRun } from "../src/render.ts";
const id = process.argv[2];
if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("usage: render-run.ts <runId>");
const dir = path.join(ROOT, "runs", id);
for (const file of renderRun(dir)) console.log(file);
console.log(path.join(dir, "index.html"));
