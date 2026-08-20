import "dotenv/config";

import { HydraOssClient } from "../src/hydra/ossClient.js";
import {
  evaluateHydraMemory,
  hydraMemoryEvaluationCases,
  HYDRA_MEMORY_EVAL_RECORDS,
} from "../src/hydra/evaluation.js";
import type { HydraMemorySettings } from "../src/hydra/ossClient.js";

const required = (name: string, fallback?: string) => {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`Missing ${name}. Start local HydraDB OSS first.`);
  }
  return value;
};

const positiveInteger = (name: string, fallback: number) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
};

const nonNegativeInteger = (name: string, fallback: number) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
};

const settings: HydraMemorySettings = {
  authToken: required("HYDRA_MEMORY_AUTH_TOKEN"),
  baseUrl: required("HYDRA_MEMORY_BASE_URL", "http://127.0.0.1:18443").replace(
    /\/$/,
    "",
  ),
  namespace: required("HYDRA_MEMORY_NAMESPACE", "local"),
  graphId: required("HYDRA_MEMORY_GRAPH_ID", "default"),
  cellId: required("HYDRA_MEMORY_CELL_ID", "cell-0"),
  timeoutSeconds: positiveInteger("HYDRA_DB_TIMEOUT_SECONDS", 30),
  maxRetries: nonNegativeInteger("HYDRA_EVAL_MAX_RETRIES", 0),
  queryMaxResults: positiveInteger("HYDRA_QUERY_MAX_RESULTS", 10),
};

const runId = `${Date.now()}-${process.pid}`;
const collection = `drawsy_eval_${runId}`;
const isolationCollection = `${collection}_other_user`;
const maxLatencyMs = positiveInteger("HYDRA_EVAL_MAX_QUERY_MS", 10_000);
const client = new HydraOssClient(settings);
let cleanupRequired = false;

const printResult = (
  result: Awaited<ReturnType<typeof evaluateHydraMemory>>["results"][number],
) => {
  const marker = result.passed ? "PASS" : "FAIL";
  const records = result.matchedRecordIds.length
    ? ` [${result.matchedRecordIds.join(", ")}]`
    : "";
  console.log(
    `${marker} ${result.label} — ${result.latencyMs}ms, ${result.resultCount} result(s)${records}`,
  );
  if (!result.passed) console.log(`     ${result.reason}`);
};

const main = async () => {
  console.log("HydraDB OSS · Drawsy memory evaluation");
  console.log(`Graph: ${settings.graphId} · collection: ${collection}`);
  console.log("Writes only a disposable evaluation collection.\n");

  await client.ingestMemory(collection, HYDRA_MEMORY_EVAL_RECORDS);
  cleanupRequired = true;
  await client.ingestMemory(collection, [
    {
      id: "eval-idempotency-probe",
      text: "Idempotency probe: this event key must exist exactly once after a retry.",
      infer: true,
      additional_metadata: {
        source: "drawsy_hydra_evaluation",
        observedAt: "2026-08-19T11:00:00.000Z",
        sessionId: "eval-session-3",
        turnId: "eval-turn-idempotency",
        surfaceKind: "chat",
      },
    },
  ]);
  await client.ingestMemory(collection, [
    {
      id: "eval-idempotency-probe",
      text: "Idempotency probe: this event key must exist exactly once after a retry.",
      infer: true,
      additional_metadata: {
        source: "drawsy_hydra_evaluation",
        observedAt: "2026-08-19T11:00:00.000Z",
        sessionId: "eval-session-3",
        turnId: "eval-turn-idempotency",
        surfaceKind: "chat",
      },
    },
  ]);

  await client.ingestMemory(isolationCollection, [
    {
      id: "other-user-private-record",
      text: "Sundial ember is another user's private note and must never cross the user boundary.",
      infer: true,
      additional_metadata: {
        source: "drawsy_hydra_evaluation",
        observedAt: "2026-08-19T12:00:00.000Z",
        sessionId: "other-user-session",
        turnId: "other-user-turn",
        surfaceKind: "chat",
      },
    },
  ]);

  const summary = await evaluateHydraMemory(
    client,
    collection,
    hydraMemoryEvaluationCases(maxLatencyMs),
  );
  for (const result of summary.results) printResult(result);

  const idempotency = await client.queryMemory(collection, {
    query: "idempotency event key retry",
    maxResults: 20,
  });
  const idempotencyIds = idempotency.chunks
    .map((chunk) =>
      chunk && typeof chunk === "object" && !Array.isArray(chunk)
        ? (chunk as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");
  const idempotencyPassed =
    idempotencyIds.filter((id) => id === "eval-idempotency-probe").length === 1;
  console.log(
    `${idempotencyPassed ? "PASS" : "FAIL"} duplicate event ingestion is idempotent — ${idempotencyIds.join(", ") || "no result"}`,
  );

  const isolation = await client.queryMemory(isolationCollection, {
    query: "sundial ember private note",
    maxResults: 20,
  });
  const isolationIds = isolation.chunks
    .map((chunk) =>
      chunk && typeof chunk === "object" && !Array.isArray(chunk)
        ? (chunk as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");
  const isolationPassed = isolationIds.includes("other-user-private-record");
  const crossBoundary = await client.queryMemory(collection, {
    query: "sundial ember",
    maxResults: 20,
  });
  const crossBoundaryIds = crossBoundary.chunks
    .map((chunk) =>
      chunk && typeof chunk === "object" && !Array.isArray(chunk)
        ? (chunk as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");
  const crossBoundaryPassed = !crossBoundaryIds.includes(
    "other-user-private-record",
  );
  console.log(
    `${isolationPassed && crossBoundaryPassed ? "PASS" : "FAIL"} user isolation — owner result: ${isolationIds.join(", ") || "none"}; other owner visible from first collection: ${crossBoundaryIds.join(", ") || "none"}`,
  );

  const allPassed =
    summary.passed &&
    idempotencyPassed &&
    isolationPassed &&
    crossBoundaryPassed;
  console.log(
    `\n${allPassed ? "PASS" : "FAIL"} ${summary.passedCases + Number(idempotencyPassed) + Number(isolationPassed && crossBoundaryPassed)}/${summary.totalCases + 2} acceptance checks · p95 query ${summary.p95LatencyMs}ms`,
  );
  if (!allPassed) process.exitCode = 1;
};

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(
    `\nFAIL evaluation: ${
      error instanceof Error ? error.message : "HydraDB OSS request failed."
    }`,
  );
  console.error(
    "The local graph-node is healthy only if it can accept a round-trip write; check its storage/writer state before rerunning.",
  );
} finally {
  if (cleanupRequired) {
    const cleanupResults = await Promise.allSettled([
      client.deleteMemory(collection, [
        ...HYDRA_MEMORY_EVAL_RECORDS.map((record) => record.id),
        "eval-idempotency-probe",
      ]),
      client.deleteMemory(isolationCollection, ["other-user-private-record"]),
    ]);
    if (cleanupResults.some((result) => result.status === "rejected")) {
      console.error(
        "Warning: evaluation cleanup could not complete; the disposable collection may contain records.",
      );
    }
  }
}
