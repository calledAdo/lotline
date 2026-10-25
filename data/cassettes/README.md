# Recorded model replies

These JSONL files contain requests and replies from live Nightshift calls to NVIDIA Nemotron. They contain no SQL results or credentials. A sibling `.meta.json` identifies the source run, command, recall numbers, backend and fixed hospital date. Receipt IDs, routed models, provider latency, token counts and cost remain in the replies as provenance.

`npm run demo` queries the committed source data with DuckDB and executes the agents. It looks up a reply by the exact request hash; it does not load a precomputed packet. Missing requests use each agent's deterministic fallback and say so in `trace.jsonl`. An invalid recorded response still goes through validation and can fall back; replay does not bypass checks. Replayed receipts describe the original live computation, not new inference or new cost.

To add a recording after a bounded live run:

```sh
npx tsx scripts/promote-cassette.ts <runId>
SAMPLE_MODE=true npx tsx scripts/check-replay.ts <runId>
```

Promotion copies only model entries, validates request hashes, removes duplicate keys within the run and refuses suspected credentials or previously redacted content. Each run remains a separate bundle: two live runs can return different answers to the same request. `recordingsFor` gives the selected recall's baseline or watch bundle precedence so subsequent prompts use the same worker replies that produced its recorded critic review. Raw SQL recordings remain in ignored `runs/` directories.

The hospital, dispensing records, wholesaler availability and expansion drill are fictional. The recall, shortage and NDC directory data come from openFDA; see the parent data documentation and snapshot manifest.
