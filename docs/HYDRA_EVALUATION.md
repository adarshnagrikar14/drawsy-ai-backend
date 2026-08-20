# Hydra memory evaluation

Drawsy uses two Hydra paths deliberately:

- hosted HydraDB stores connector knowledge;
- the local HydraDB OSS graph stores signed-in users' private conversation memory.

The evaluation command below exercises the second path through the same
`HydraOssClient` used by the backend. It creates a disposable collection, writes
three realistic Drawsy planning sessions plus a retry probe, queries the graph,
checks the result, and deletes only those evaluation records.

## Run it locally

Start the local HydraDB OSS graph-node, then from
`drawsy-ai-backend/` run:

```bash
npm run eval:hydra-memory
```

The command reads the local settings already used by the backend:

```text
HYDRA_MEMORY_AUTH_TOKEN
HYDRA_MEMORY_BASE_URL      (default: http://127.0.0.1:18443)
HYDRA_MEMORY_NAMESPACE    (default: local)
HYDRA_MEMORY_GRAPH_ID     (default: default)
HYDRA_MEMORY_CELL_ID      (default: cell-0)
```

Optional: set `HYDRA_EVAL_MAX_QUERY_MS` to change the per-query latency gate.
The default is 10 seconds. `HYDRA_EVAL_MAX_RETRIES` can be set when you want to
exercise retry behavior; it defaults to zero so a broken local writer is
reported immediately. No Firebase token or hosted Hydra key is needed for this
local evaluation.

## What it proves

The suite is intentionally small enough to run during development and specific
enough to catch regressions in the product path:

1. **Cross-session synthesis** — evidence from three Drawsy planning sessions is
   returned together.
2. **Knowledge history** — the earlier problem and the later delivery change
   remain available; a later write does not erase the history.
3. **Chronology evidence** — the architecture decision is tied to its own
   session metadata and returned as a memory source.
4. **Abstention** — a question that is not in the history returns no memory
   result instead of being treated as a fact.
5. **Idempotency** — retrying the same event key does not create duplicate
   record IDs in retrieval.
6. **User isolation** — one evaluation collection cannot read another
   collection's private record.
7. **Latency** — the command prints p95 query latency and fails a case above the
   configured gate.

A passing run is an acceptance gate for the local memory integration. It is a
development smoke test, not a claim about benchmark performance. The official
evaluators below use released benchmark data and the same production
`HydraOssClient`; they do not manufacture conversations or questions.

## Official released-data evaluation

The official sources are [LongMemEval](https://github.com/xiaowu0162/LongMemEval),
[LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2), and
[BEAM](https://github.com/mohammadtavakoli78/BEAM). Keep their datasets in a
disposable directory outside this repository. The adapter writes each case to
a disposable, owner-scoped Hydra collection, queries it, and records metrics.
For a disposable graph-node, set `HYDRA_EVAL_CLEANUP=false` so benchmark-only
teardown writes do not distort the workload; destroy that disposable node
afterward. Checkpoints are written atomically after every completed group, and
`--resume` continues from the last checkpoint. It runs mutations in order
because the local OSS graph-node must not be used as a parallel-write stress
harness.

From `drawsy-ai-backend/`:

```bash
# LongMemEval S: all 500 released questions; exact answer-session evidence.
HYDRA_DB_TIMEOUT_SECONDS=120 HYDRA_EVAL_CLEANUP=false \
  npm run eval:hydra-official -- \
  --dataset longmemeval \
  --input /path/to/LongMemEval/data/longmemeval_s_cleaned.json \
  --limit 500 \
  --output /tmp/longmemeval-s-hydra.json

# LongMemEval-V2 small text tier: all 451 released questions.
HYDRA_DB_TIMEOUT_SECONDS=120 HYDRA_EVAL_CLEANUP=false \
  npm run eval:hydra-official -- \
  --dataset longmemeval-v2 \
  --questions /path/to/questions.jsonl \
  --haystacks /path/to/lme_v2_small.json \
  --trajectories /path/to/trajectories.jsonl \
  --limit 451 \
  --output /tmp/longmemeval-v2-hydra.json

# BEAM: convert the official parquet release, then run each released scale.
npm run eval:hydra-beam-export -- \
  --input /path/to/100K.parquet \
  --output /tmp/beam-100K.jsonl
npm run eval:hydra-official -- --dataset beam --input /tmp/beam-100K.jsonl \
  --limit 400 --output /tmp/beam-100K-hydra.json
```

Run the same two BEAM commands for `500K.parquet` (`700` cases) and
`1M.parquet` (`700` cases). The converter preserves the published parquet
content; it only normalizes the published nested values into the evaluator's
streaming JSONL format.

LongMemEval reports exact evidence recall, nDCG, abstention, and query
latency because its released questions identify the answer sessions. The V2
and BEAM public releases do not expose a common exact evidence ID for every
question, so this adapter reports Hydra retrieval latency and gold-answer token
support—not official end-to-end answer accuracy. V2 image questions are counted
and transparently marked; this local run is text-only. A model reader/judge is
required before claiming official QA accuracy, and no such model is silently
substituted here.

The implementation is in
[`scripts/hydra-official-eval.ts`](/Users/adarsh/Desktop/excal-ai/drawsy-ai-backend/scripts/hydra-official-eval.ts)
and
[`scripts/hydra-beam-export.py`](/Users/adarsh/Desktop/excal-ai/drawsy-ai-backend/scripts/hydra-beam-export.py).

The completed local runs on 2026-08-20 were:

- LongMemEval S: 500 questions and 23,867 records; exact evidence recall-any
  was 0.916 at 5 and 0.970 at 10; p50/p95/max query latency was
  106/191/362 ms.
- LongMemEval-V2 small: 451 questions over 200 trajectories; p50/p95/max was
  434/439/602 ms after the bounded token-frequency cache. Gold-answer token
  support was 0.671 mean and 0.761 at the 0.5 support threshold. The 29 image
  questions were counted but evaluated text-only.
- BEAM 100K/500K/1M: 400/700/700 questions; p50/p95/max was respectively
  25/29/40 ms, 47/53/74 ms, and 49/66/112 ms. Gold-answer token support was
  0.917/0.904/0.919 mean respectively.

These V2 and BEAM figures are retrieval and answer-support measurements, not
official QA accuracy. LongMemEval's 30 abstention cases also report whether
retrieval was empty; the retrieval layer does not make the final model's
answer/abstain decision.

The production client uses byte-aware write batches so a large connector or
conversation record cannot turn a fixed row count into an HTTP 413. It also
keeps a bounded versioned token-frequency cache for repeated retrieval over
the same records. The cache changes cost, not the returned ranking.

## Evaluation against the real connector corpus

This is separate from the memory benchmark. It reads the currently signed-in
user's Firestore sync state, selects only connector sources that are actually
`ready` with submitted records, and queries hosted Hydra's indexed connector
knowledge through the production `HydraDbClient`. It never calls the live
connectors during the test:

```bash
npm run eval:hydra-connectors
```

The result is a redacted provider-level report. A source that is still syncing,
rate-limited, or errored is excluded rather than counted as a false pass. That
keeps the result genuine: it measures what Hydra can retrieve now and leaves
the connector's operational failure visible in the connectors UI.

The final real-corpus run on 2026-08-20 passed 4/4 currently ready sources:
Read AI, AWS, GitHub, and Notion. Google Workspace had all 3 capabilities and
268 submitted records but one hosted indexing job was still pending; Fireflies
was rate-limited with zero records. Neither was falsely counted as ready.

## The useful canvas exercise

This is the product demo and the real reason to store memory—not a trivia test.

1. Open a blank canvas named **Hydra Memory Lab**.
2. Draw three simple sections:

   - **Problem:** “Drawsy needs continuity across chats. Connector context and
     private personal memory must stay separate. If a fact was never recorded,
     Drawsy should say it does not know.”
   - **Decision:** “Use local HydraDB OSS for personal memory and hosted HydraDB
     for connector knowledge. Query Hydra first; use live connectors only when
     information is missing, needs to be fresh, or requires an action.”
   - **Change:** “For the hackathon demo, prioritize memory continuity and
     visible Hydra sources. Keep connector sync idempotent and show each
     connector's progress. A degraded connector must not block memory.”

3. Ask Drawsy AI:

   > Turn this canvas into a three-session product plan. Remember the decisions
   > on this canvas. Do not call live connectors.

4. Start a new chat/session and ask:

   > What architecture decisions did I make for Hydra, and what changed later?

   The response should show a **Memory** Hydra source marker. Then ask:

   > What is my favorite programming language?

   It should abstain because that fact was never put on the canvas.

This demonstrates a real workflow: a product decision made visually becomes
available in a later planning conversation, while private memory stays separate
from connector retrieval and unknown facts are not invented.

## Submission/demo language

Use this concise explanation in the demo:

> Drawsy writes each signed-in user's conversation turn and canvas references as
> an idempotent graph record in HydraDB OSS. The graph keeps session,
> conversation, source, and ownership relationships. On a later question,
> Drawsy queries the user's memory and connector knowledge in parallel, uses
> Hydra context first, and shows the returned Hydra sources in the chat. A live
> connector is only used when Hydra lacks the needed context or an action/fresh
> read is required.
