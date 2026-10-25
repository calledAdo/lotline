// Screen the real snapshot and then make the model reject an exact NDC match. The
// deterministic planner guard must retain it and preserve Class I urgency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withHospital } from "./helpers.ts";
import { triage } from "../src/agents/planner.ts";
import { withModelRuntime, type ChatRequest } from "../src/llm.ts";
import { requestKey } from "../src/cassette.ts";
test("deterministic planner screens exact codes, retains name-only traps and prioritizes Class I", async () => {
  await withHospital(async(ctx,_crosswalk,items)=>{
    let request: ChatRequest | undefined;
    const screened=await withModelRuntime({mode:"deterministic",onRequest:r=>{request=r;}},()=>triage(ctx,items));
    const anchor=screened.find(c=>c.recall_number==="D-0850-2026")!;
    assert.equal(anchor.match,"exact-ndc");assert.equal(anchor.relevant,"yes");assert.equal(anchor.urgency,"now");
    const trap=screened.find(c=>c.recall_number==="D-0113-2026")!;
    assert.equal(trap.match,"name-only");assert.equal(trap.relevant,"maybe");
    const req=request!, key=requestKey("llm",req);
    const recordings=new Map([[key,{kind:"llm" as const,key,request:req,recordedAt:"test",response:{status:200,body:{choices:[{message:{content:JSON.stringify({recalls:[{recall_number:"D-0850-2026",relevant:"no",urgency:"this week",why:"model mistake"}]})}}]}}}]]);
    const guarded=await withModelRuntime({mode:"replay",recordings},()=>triage(ctx,items));
    assert.equal(guarded.find(c=>c.recall_number==="D-0850-2026")!.relevant,"maybe");
    assert.equal(guarded.find(c=>c.recall_number==="D-0850-2026")!.urgency,"now");
  });
});
