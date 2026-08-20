import type { HydraMemoryClient } from "./ossClient.js";
import type { HydraMemoryRecord, HydraQueryResult } from "./types.js";

export type HydraMemoryEvaluationCase = {
  id: string;
  label: string;
  query: string;
  expectedRecordIds?: string[];
  forbiddenRecordIds?: string[];
  requiredText?: string[];
  expectMemorySource?: boolean;
  expectNoResults?: boolean;
  expectUniqueRecordIds?: boolean;
  maxLatencyMs?: number;
};

export type HydraMemoryEvaluationResult = {
  id: string;
  label: string;
  passed: boolean;
  latencyMs: number;
  resultCount: number;
  matchedRecordIds: string[];
  reason: string;
};

export type HydraMemoryEvaluationSummary = {
  passed: boolean;
  passedCases: number;
  totalCases: number;
  p95LatencyMs: number;
  results: HydraMemoryEvaluationResult[];
};

const objectValue = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const chunkId = (value: unknown) => {
  const record = objectValue(value);
  return typeof record?.id === "string" ? record.id : "";
};

const resultText = (result: HydraQueryResult) => {
  const chunkText = (result.chunks || [])
    .map((chunk) => {
      const record = objectValue(chunk);
      return typeof record?.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
  return `${result.context}\n${chunkText}`.toLocaleLowerCase();
};

const percentile95 = (values: number[]) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.ceil(ordered.length * 0.95) - 1,
  );
  return ordered[index] || 0;
};

const evaluateResult = (
  evaluationCase: HydraMemoryEvaluationCase,
  result: HydraQueryResult,
  latencyMs: number,
): HydraMemoryEvaluationResult => {
  const matchedRecordIds = (result.chunks || []).map(chunkId).filter(Boolean);
  const uniqueRecordIds = new Set(matchedRecordIds);
  const context = resultText(result);
  const failures: string[] = [];
  const hasMemorySource = (result.sources || []).some((source) => {
    const record = objectValue(source);
    return record?.type === "memory";
  });

  for (const expectedId of evaluationCase.expectedRecordIds || []) {
    if (!matchedRecordIds.includes(expectedId)) {
      failures.push(`missing ${expectedId}`);
    }
  }
  for (const forbiddenId of evaluationCase.forbiddenRecordIds || []) {
    if (matchedRecordIds.includes(forbiddenId)) {
      failures.push(`returned forbidden ${forbiddenId}`);
    }
  }
  for (const requiredText of evaluationCase.requiredText || []) {
    if (!context.includes(requiredText.toLocaleLowerCase())) {
      failures.push(`missing evidence “${requiredText}”`);
    }
  }
  if (evaluationCase.expectMemorySource && !hasMemorySource) {
    failures.push("missing Hydra memory source provenance");
  }
  if (evaluationCase.expectNoResults && matchedRecordIds.length > 0) {
    failures.push("returned context for an unknown fact");
  }
  if (
    evaluationCase.expectUniqueRecordIds &&
    uniqueRecordIds.size !== matchedRecordIds.length
  ) {
    failures.push("duplicate record ids returned");
  }
  if (
    evaluationCase.maxLatencyMs !== undefined &&
    latencyMs > evaluationCase.maxLatencyMs
  ) {
    failures.push(
      `latency ${latencyMs}ms exceeded ${evaluationCase.maxLatencyMs}ms`,
    );
  }

  return {
    id: evaluationCase.id,
    label: evaluationCase.label,
    passed: failures.length === 0,
    latencyMs,
    resultCount: matchedRecordIds.length,
    matchedRecordIds: [...uniqueRecordIds],
    reason: failures.length ? failures.join("; ") : "ok",
  };
};

export const evaluateHydraMemory = async (
  client: Pick<HydraMemoryClient, "queryMemory">,
  collection: string,
  cases: HydraMemoryEvaluationCase[],
): Promise<HydraMemoryEvaluationSummary> => {
  const results: HydraMemoryEvaluationResult[] = [];

  for (const evaluationCase of cases) {
    const startedAt = Date.now();
    try {
      const response = await client.queryMemory(collection, {
        query: evaluationCase.query,
        maxResults: 20,
      });
      results.push(
        evaluateResult(evaluationCase, response, Date.now() - startedAt),
      );
    } catch (error) {
      results.push({
        id: evaluationCase.id,
        label: evaluationCase.label,
        passed: false,
        latencyMs: Date.now() - startedAt,
        resultCount: 0,
        matchedRecordIds: [],
        reason: error instanceof Error ? error.message : "query failed",
      });
    }
  }

  const passedCases = results.filter((result) => result.passed).length;
  return {
    passed: passedCases === cases.length,
    passedCases,
    totalCases: cases.length,
    p95LatencyMs: percentile95(results.map((result) => result.latencyMs)),
    results,
  };
};

export const HYDRA_MEMORY_EVAL_RECORDS: HydraMemoryRecord[] = [
  {
    id: "eval-session-1-problem",
    text: [
      "Session 1, 2026-08-12: On the Drawsy canvas I defined the real problem.",
      "Users need continuity across chat sessions while connector context remains separate from private personal memory.",
      "The memory should remember product decisions made on the canvas, but it must abstain when a fact was never recorded.",
    ].join("\n"),
    infer: true,
    additional_metadata: {
      source: "drawsy_hydra_evaluation",
      memoryType: "conversation_turn",
      observedAt: "2026-08-12T10:00:00.000Z",
      sessionId: "eval-session-1",
      turnId: "eval-turn-1",
      conversationId: "eval-conversation",
      surfaceKind: "canvas",
    },
    relations: [
      {
        type: "REFERENCES_CONTEXT",
        id: "canvas:hydra-memory-lab",
        label: "Hydra Memory Lab canvas",
        properties: { elementCount: 3 },
      },
    ],
  },
  {
    id: "eval-session-2-architecture",
    text: [
      "Session 2, 2026-08-15: I chose local HydraDB OSS for private personal memory and hosted HydraDB for connector knowledge.",
      "Hydra should be queried first when the user asks about connected context; live connector calls are only a fallback for missing, fresh, or action-required information.",
      "This architecture keeps signed-in users isolated and does not compel a connector call when memory already answers the question.",
    ].join("\n"),
    infer: true,
    additional_metadata: {
      source: "drawsy_hydra_evaluation",
      memoryType: "conversation_turn",
      observedAt: "2026-08-15T10:00:00.000Z",
      sessionId: "eval-session-2",
      turnId: "eval-turn-2",
      conversationId: "eval-conversation",
      surfaceKind: "chat",
    },
    relations: [
      {
        type: "REFERENCES_CONTEXT",
        id: "canvas:hydra-memory-lab",
        label: "Hydra Memory Lab canvas",
        properties: { elementCount: 3 },
      },
    ],
  },
  {
    id: "eval-session-3-change",
    text: [
      "Session 3, 2026-08-19: I changed the delivery priority for the hackathon demo.",
      "Memory continuity and visible Hydra source provenance come first; connector sync must be idempotent and show progress per connector.",
      "A degraded connector such as Fireflies can remain unavailable without blocking personal memory or the other connected sources.",
    ].join("\n"),
    infer: true,
    additional_metadata: {
      source: "drawsy_hydra_evaluation",
      memoryType: "conversation_turn",
      observedAt: "2026-08-19T10:00:00.000Z",
      sessionId: "eval-session-3",
      turnId: "eval-turn-3",
      conversationId: "eval-conversation",
      surfaceKind: "chat",
    },
    relations: [
      {
        type: "REFERENCES_CONTEXT",
        id: "canvas:hydra-memory-lab",
        label: "Hydra Memory Lab canvas",
        properties: { elementCount: 3 },
      },
    ],
  },
];

export const hydraMemoryEvaluationCases = (
  maxLatencyMs: number,
): HydraMemoryEvaluationCase[] => [
  {
    id: "cross-session-synthesis",
    label: "synthesizes the product problem across sessions",
    query:
      "How should Drawsy use Hydra across canvas planning, private memory, and connector context?",
    expectedRecordIds: [
      "eval-session-1-problem",
      "eval-session-2-architecture",
      "eval-session-3-change",
    ],
    requiredText: [
      "local HydraDB OSS",
      "hosted HydraDB",
      "live connector calls are only a fallback",
    ],
    expectMemorySource: true,
    maxLatencyMs,
  },
  {
    id: "knowledge-update-history",
    label: "keeps the earlier decision and the later change",
    query:
      "What was my earlier memory problem and what changed in my later hackathon priority?",
    expectedRecordIds: ["eval-session-1-problem", "eval-session-3-change"],
    requiredText: ["real problem", "changed the delivery priority"],
    maxLatencyMs,
  },
  {
    id: "chronology",
    label: "returns evidence from the architecture decision session",
    query:
      "What did I decide about local memory and hosted connector knowledge?",
    expectedRecordIds: ["eval-session-2-architecture"],
    requiredText: ["local HydraDB OSS", "hosted HydraDB"],
    maxLatencyMs,
  },
  {
    id: "abstention",
    label: "abstains when the history has no answer",
    query: "What is my favorite programming language?",
    expectNoResults: true,
    maxLatencyMs,
  },
];
