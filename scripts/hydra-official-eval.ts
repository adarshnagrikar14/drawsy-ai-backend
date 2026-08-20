import "dotenv/config";

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { HydraOssClient } from "../src/hydra/ossClient.js";
import type { HydraMemorySettings } from "../src/hydra/ossClient.js";
import type {
  HydraMemoryRecord,
  HydraQueryResult,
} from "../src/hydra/types.js";

type DatasetName = "longmemeval" | "longmemeval-v2" | "beam";

type BenchmarkRecord = {
  sourceId: string;
  text: string;
  observedAt: string;
};

type BenchmarkCase = {
  id: string;
  groupId: string;
  question: string;
  category: string;
  evidenceSourceIds: string[];
  answerText: string | null;
  abstention: boolean;
  imagePresent: boolean;
};

type BenchmarkGroup = {
  id: string;
  records: BenchmarkRecord[];
  cases: BenchmarkCase[];
};

type CaseResult = {
  id: string;
  category: string;
  groupId: string;
  evidenceCount: number;
  resultCount: number;
  latencyMs: number;
  recallAnyAt5: number | null;
  recallAllAt5: number | null;
  ndcgAnyAt5: number | null;
  recallAnyAt10: number | null;
  recallAllAt10: number | null;
  ndcgAnyAt10: number | null;
  abstentionEmpty: boolean | null;
  goldAnswerTokenSupport: number | null;
  goldAnswerSupported: boolean | null;
};

type BenchmarkSummary = {
  dataset: DatasetName;
  source: string;
  groups: number;
  records: number;
  cases: number;
  exactEvidenceCases: number;
  abstentionCases: number;
  imageQuestions: number;
  latencyMs: { p50: number; p95: number; max: number };
  retrieval: {
    recallAnyAt5: number | null;
    recallAllAt5: number | null;
    ndcgAnyAt5: number | null;
    recallAnyAt10: number | null;
    recallAllAt10: number | null;
    ndcgAnyAt10: number | null;
  };
  abstention: { emptyRate: number | null };
  goldAnswerSupport: {
    meanTokenFraction: number | null;
    supportedRate: number | null;
  };
  results: CaseResult[];
  complete?: boolean;
  processedGroups?: number;
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_QUERY_MAX_RESULTS = 10;
const BENCHMARK_SOURCE_PREFIX = "drawsy_hydra_official";
const EVAL_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "what",
  "where",
  "when",
  "does",
  "did",
  "how",
  "why",
  "was",
  "were",
  "are",
  "you",
  "your",
  "user",
]);

const option = (name: string, fallback?: string) => {
  const exact = process.argv.slice(2).find((value) => value === name);
  if (exact) {
    const index = process.argv.indexOf(exact);
    const next = process.argv[index + 1];
    return next && !next.startsWith("--") ? next : fallback;
  }
  const prefix = `${name}=`;
  const inline = process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
};

const requiredOption = (name: string) => {
  const value = option(name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};

const positiveInteger = (name: string, fallback: number) => {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
};

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const jsonObject = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const hash = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex");

const requiredEnv = (name: string, fallback?: string) => {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};

const settings = (): HydraMemorySettings => ({
  authToken: requiredEnv("HYDRA_MEMORY_AUTH_TOKEN"),
  baseUrl: requiredEnv(
    "HYDRA_MEMORY_BASE_URL",
    "http://127.0.0.1:18443",
  ).replace(/\/$/, ""),
  namespace: requiredEnv("HYDRA_MEMORY_NAMESPACE", "local"),
  graphId: requiredEnv("HYDRA_MEMORY_GRAPH_ID", "default"),
  cellId: requiredEnv("HYDRA_MEMORY_CELL_ID", "cell-0"),
  timeoutSeconds: positiveInteger(
    "--timeout-seconds",
    Number(process.env.HYDRA_DB_TIMEOUT_SECONDS || 30),
  ),
  maxRetries: Number(process.env.HYDRA_EVAL_MAX_RETRIES || 0),
  queryMaxResults: positiveInteger(
    "--query-max-results",
    Number(process.env.HYDRA_QUERY_MAX_RESULTS || DEFAULT_QUERY_MAX_RESULTS),
  ),
});

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const readJsonLines = async (path: string): Promise<JsonRecord[]> => {
  const rows: JsonRecord[] = [];
  const input = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of input) {
    const value = line.trim();
    if (value) rows.push(jsonObject(JSON.parse(value)));
  }
  return rows;
};

const flattenText = (value: unknown, key = ""): string[] => {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized || normalized.endsWith(".png")) return [];
    return [key ? `${key}: ${normalized}` : normalized];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenText(entry, key));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as JsonRecord).flatMap(
      ([childKey, childValue]) => flattenText(childValue, childKey),
    );
  }
  return [];
};

const truncate = (value: string, limit = 80_000) =>
  value.length > limit ? value.slice(0, limit) : value;

const recordFor = (
  dataset: DatasetName,
  groupId: string,
  source: BenchmarkRecord,
): HydraMemoryRecord => ({
  id: `${BENCHMARK_SOURCE_PREFIX}:${dataset}:${hash(groupId, source.sourceId)}`,
  text: truncate(source.text),
  infer: true,
  additional_metadata: {
    source: `${BENCHMARK_SOURCE_PREFIX}:${dataset}`,
    memoryType: "benchmark_history",
    observedAt: source.observedAt,
    sessionId: `${dataset}:${source.sourceId}`,
    conversationId: `${dataset}:${groupId}`,
    benchmarkGroupId: groupId,
    benchmarkSourceId: source.sourceId,
  },
});

const asTimestamp = (value: unknown, fallback: string) => {
  const candidate = text(value);
  return candidate || fallback;
};

const questionText = (value: unknown) => {
  if (typeof value === "string") return value.trim();
  const record = jsonObject(value);
  return text(record.text);
};

const longMemEvalGroups = async (
  path: string,
  limit: number,
): Promise<BenchmarkGroup[]> => {
  const payload = await readJson(path);
  if (!Array.isArray(payload))
    throw new Error("LongMemEval input must be a JSON array.");
  const groups: BenchmarkGroup[] = [];
  for (const raw of payload.slice(0, limit)) {
    const entry = jsonObject(raw);
    const questionId = text(entry.question_id);
    const question = text(entry.question);
    const sessionIds = Array.isArray(entry.haystack_session_ids)
      ? entry.haystack_session_ids.map(text)
      : [];
    const dates = Array.isArray(entry.haystack_dates)
      ? entry.haystack_dates
      : [];
    const sessions = Array.isArray(entry.haystack_sessions)
      ? entry.haystack_sessions
      : [];
    if (!questionId || !question || sessionIds.length !== sessions.length) {
      throw new Error(`Invalid LongMemEval case ${questionId || "unknown"}.`);
    }
    const groupId = `case:${questionId}`;
    const records = sessions.map((session, index) => {
      const turns = Array.isArray(session) ? session : [];
      const body = turns
        .map((turn) => {
          const item = jsonObject(turn);
          return `${text(item.role) || "turn"}: ${text(item.content)}`;
        })
        .filter((value) => value.endsWith(": ") === false)
        .join("\n\n");
      return {
        // The released S file contains a small number of repeated session IDs
        // inside one haystack. Keep every released occurrence, but make the
        // graph identity unique so Hydra's conflict detection is not bypassed
        // by overwriting one occurrence with another.
        sourceId: `${sessionIds[index] || `session-${index}`}#${index}`,
        text: body,
        observedAt: asTimestamp(dates[index], "2026-01-01T00:00:00.000Z"),
      } satisfies BenchmarkRecord;
    });
    const answers = Array.isArray(entry.answer_session_ids)
      ? entry.answer_session_ids.map(text).filter(Boolean)
      : [];
    const questionType = text(entry.question_type) || "unknown";
    groups.push({
      id: groupId,
      records,
      cases: [
        {
          id: questionId,
          groupId,
          question,
          category: questionType,
          evidenceSourceIds: answers,
          answerText: text(entry.answer) || null,
          abstention: questionId.endsWith("_abs"),
          imagePresent: false,
        },
      ],
    });
  }
  return groups;
};

const trajectoryText = (trajectory: JsonRecord) => {
  const header = [
    `Goal: ${text(trajectory.goal)}`,
    `Outcome: ${text(trajectory.outcome)}`,
    `Start URL: ${text(trajectory.start_url)}`,
  ].filter((value) => !value.endsWith(": "));
  const states = Array.isArray(trajectory.states)
    ? trajectory.states.flatMap((state) => flattenText(state))
    : [];
  return truncate([...header, ...states].join("\n"));
};

const longMemEvalV2Groups = async (
  questionsPath: string,
  haystackPath: string,
  trajectoriesPath: string,
  limit: number,
): Promise<BenchmarkGroup[]> => {
  const questionRows = await readJsonLines(questionsPath);
  const haystacks = jsonObject(await readJson(haystackPath));
  const selectedQuestions = questionRows.slice(0, limit);
  const neededIds = new Set<string>();
  for (const question of selectedQuestions) {
    const ids = Array.isArray(haystacks[text(question.id)])
      ? (haystacks[text(question.id)] as unknown[]).map(text).filter(Boolean)
      : [];
    ids.forEach((id) => neededIds.add(id));
  }
  if (!neededIds.size)
    throw new Error(
      "LongMemEval-V2 selected questions have no haystack trajectories.",
    );

  const trajectories = new Map<string, JsonRecord>();
  const input = createInterface({
    input: createReadStream(trajectoriesPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let scanned = 0;
  for await (const line of input) {
    const value = line.trim();
    if (!value) continue;
    scanned += 1;
    const row = jsonObject(JSON.parse(value));
    const id = text(row.id);
    if (id && neededIds.has(id)) trajectories.set(id, row);
  }
  if (trajectories.size !== neededIds.size) {
    throw new Error(
      `LongMemEval-V2 trajectory scan found ${trajectories.size}/${neededIds.size} referenced trajectories after ${scanned} lines.`,
    );
  }

  const groupsByKey = new Map<string, BenchmarkGroup>();
  for (const question of selectedQuestions) {
    const questionId = text(question.id);
    const domain = text(question.domain) || "unknown";
    const rawIds = Array.isArray(haystacks[questionId])
      ? (haystacks[questionId] as unknown[]).map(text).filter(Boolean)
      : [];
    const groupId = `${domain}:${hash(...rawIds)}`;
    const group = groupsByKey.get(groupId) || {
      id: groupId,
      records: [],
      cases: [],
    };
    if (!group.records.length) {
      group.records = rawIds.map((id) => ({
        sourceId: id,
        text: trajectoryText(trajectories.get(id) || {}),
        observedAt: "2026-01-01T00:00:00.000Z",
      }));
    }
    const answer = text(question.answer) || null;
    group.cases.push({
      id: questionId,
      groupId,
      question: questionText(question.question),
      category: text(question.question_type) || "unknown",
      // V2's public question file does not expose answer trajectory ids. Keep
      // this empty; V2 answer accuracy remains an official reader/evaluator
      // concern, while this run measures Hydra retrieval and answer support.
      evidenceSourceIds: [],
      answerText: answer,
      abstention: text(question.question_type).includes("-abs"),
      imagePresent: Boolean(text(question.image)),
    });
    groupsByKey.set(groupId, group);
  }
  return [...groupsByKey.values()];
};

const normalizedGroups = async (path: string, limit: number) => {
  const rows = await readJsonLines(path);
  const groups: BenchmarkGroup[] = [];
  let cases = 0;
  for (const row of rows) {
    const groupId = text(row.groupId);
    const recordsValue = Array.isArray(row.records) ? row.records : [];
    const casesValue = Array.isArray(row.cases) ? row.cases : [];
    if (!groupId || !recordsValue.length) continue;
    const groupCases: BenchmarkCase[] = casesValue
      .slice(0, Math.max(0, limit - cases))
      .map((value) => {
        const item = jsonObject(value);
        return {
          id: text(item.id),
          groupId,
          question: text(item.question),
          category: text(item.category) || "unknown",
          evidenceSourceIds: Array.isArray(item.evidenceSourceIds)
            ? item.evidenceSourceIds.map(text).filter(Boolean)
            : [],
          answerText: text(item.answerText) || null,
          abstention: item.abstention === true,
          imagePresent: item.imagePresent === true,
        };
      });
    if (!groupCases.length) break;
    cases += groupCases.length;
    groups.push({
      id: groupId,
      records: recordsValue.map((value) => {
        const item = jsonObject(value);
        return {
          sourceId: text(item.sourceId),
          text: text(item.text),
          observedAt: text(item.observedAt) || "2026-01-01T00:00:00.000Z",
        };
      }),
      cases: groupCases,
    });
    if (cases >= limit) break;
  }
  return groups;
};

const tokenize = (value: string) =>
  value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3)
    .filter((token) => !EVAL_STOP_WORDS.has(token));

const chunkId = (value: unknown) => {
  const record = jsonObject(value);
  return text(record.id);
};

const chunkText = (value: unknown) => {
  const record = jsonObject(value);
  return text(record.text);
};

const dcg = (relevances: number[], k: number) =>
  relevances
    .slice(0, k)
    .reduce(
      (total, relevance, index) =>
        total + (index === 0 ? relevance : relevance / Math.log2(index + 1)),
      0,
    );

const ndcgAny = (
  rankedIds: string[],
  allIds: string[],
  evidence: Set<string>,
  k: number,
) => {
  if (!evidence.size) return null;
  const relevance = allIds.map((id) => (evidence.has(id) ? 1 : 0));
  const rankedRelevance = rankedIds.map((id) => (evidence.has(id) ? 1 : 0));
  const ideal = dcg(
    [...relevance].sort((left, right) => right - left),
    k,
  );
  return ideal ? dcg(rankedRelevance, k) / ideal : 0;
};

const mean = (values: Array<number | null>) => {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length
    ? usable.reduce((sum, value) => sum + value, 0) / usable.length
    : null;
};

const percentile = (values: number[], fraction: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1,
  );
  return sorted[index] || 0;
};

const summarize = (
  dataset: DatasetName,
  groups: BenchmarkGroup[],
  results: CaseResult[],
  processedGroups: number,
  complete: boolean,
): BenchmarkSummary => {
  const records = groups.reduce(
    (total, group) => total + group.records.length,
    0,
  );
  const latencies = results.map((result) => result.latencyMs);
  const abstentions = results.filter(
    (result) => result.abstentionEmpty !== null,
  );
  const supported = results.filter(
    (result) => result.goldAnswerSupported !== null,
  );
  return {
    dataset,
    source: BENCHMARK_SOURCE_PREFIX,
    groups: groups.length,
    records,
    cases: results.length,
    exactEvidenceCases: results.filter((result) => result.evidenceCount > 0)
      .length,
    abstentionCases: abstentions.length,
    imageQuestions: groups
      .flatMap((group) => group.cases)
      .filter((item) => item.imagePresent).length,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: Math.max(0, ...latencies),
    },
    retrieval: {
      recallAnyAt5: mean(results.map((result) => result.recallAnyAt5)),
      recallAllAt5: mean(results.map((result) => result.recallAllAt5)),
      ndcgAnyAt5: mean(results.map((result) => result.ndcgAnyAt5)),
      recallAnyAt10: mean(results.map((result) => result.recallAnyAt10)),
      recallAllAt10: mean(results.map((result) => result.recallAllAt10)),
      ndcgAnyAt10: mean(results.map((result) => result.ndcgAnyAt10)),
    },
    abstention: {
      emptyRate: abstentions.length
        ? abstentions.filter((result) => result.abstentionEmpty).length /
          abstentions.length
        : null,
    },
    goldAnswerSupport: {
      meanTokenFraction: mean(
        results.map((result) => result.goldAnswerTokenSupport),
      ),
      supportedRate: supported.length
        ? supported.filter((result) => result.goldAnswerSupported).length /
          supported.length
        : null,
    },
    results,
    complete,
    processedGroups,
  };
};

const writeCheckpoint = async (path: string, summary: BenchmarkSummary) => {
  const temporaryPath = `${path}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, path);
};

const evaluateCase = (
  dataset: DatasetName,
  benchmarkCase: BenchmarkCase,
  groupRecords: BenchmarkRecord[],
  response: HydraQueryResult,
  latencyMs: number,
): CaseResult => {
  const rankedIds = (response.chunks || []).map(chunkId).filter(Boolean);
  const allIds = groupRecords
    .map((record) => record.sourceId)
    .map(
      (sourceId) =>
        `${BENCHMARK_SOURCE_PREFIX}:${dataset}:${hash(benchmarkCase.groupId, sourceId)}`,
    );
  const evidenceIds = new Set(
    groupRecords
      .filter((record) =>
        benchmarkCase.evidenceSourceIds.some(
          (sourceId) =>
            record.sourceId === sourceId ||
            record.sourceId.startsWith(`${sourceId}#`),
        ),
      )
      .map(
        (record) =>
          `${BENCHMARK_SOURCE_PREFIX}:${dataset}:${hash(benchmarkCase.groupId, record.sourceId)}`,
      ),
  );
  const top = (k: number) => rankedIds.slice(0, k);
  const any = (k: number) =>
    evidenceIds.size ? Number(top(k).some((id) => evidenceIds.has(id))) : null;
  const all = (k: number) =>
    evidenceIds.size
      ? Number([...evidenceIds].every((id) => top(k).includes(id)))
      : null;
  const context = [
    response.context,
    ...(response.chunks || []).map(chunkText),
  ].join("\n");
  const answerTerms = benchmarkCase.answerText
    ? [...new Set(tokenize(benchmarkCase.answerText))]
    : [];
  const contextTokens = new Set(tokenize(context));
  const supportedTerms = answerTerms.filter((term) => contextTokens.has(term));
  const tokenSupport = answerTerms.length
    ? supportedTerms.length / answerTerms.length
    : null;
  return {
    id: benchmarkCase.id,
    category: benchmarkCase.category,
    groupId: benchmarkCase.groupId,
    evidenceCount: evidenceIds.size,
    resultCount: rankedIds.length,
    latencyMs,
    recallAnyAt5: any(5),
    recallAllAt5: all(5),
    ndcgAnyAt5: ndcgAny(rankedIds, allIds, evidenceIds, 5),
    recallAnyAt10: any(10),
    recallAllAt10: all(10),
    ndcgAnyAt10: ndcgAny(rankedIds, allIds, evidenceIds, 10),
    abstentionEmpty: benchmarkCase.abstention ? rankedIds.length === 0 : null,
    goldAnswerTokenSupport: tokenSupport,
    goldAnswerSupported: tokenSupport === null ? null : tokenSupport >= 0.5,
  };
};

const runGroups = async (
  dataset: DatasetName,
  groups: BenchmarkGroup[],
  client: HydraOssClient,
  options: {
    output?: string;
    startGroup: number;
    initialResults: CaseResult[];
    cleanup: boolean;
  },
): Promise<BenchmarkSummary> => {
  const results: CaseResult[] = [...options.initialResults];
  const runId = `${Date.now()}-${process.pid}`;
  for (
    let groupIndex = options.startGroup;
    groupIndex < groups.length;
    groupIndex += 1
  ) {
    const group = groups[groupIndex]!;
    const collection = `${BENCHMARK_SOURCE_PREFIX}_${dataset}_${runId}_${hash(group.id).slice(0, 20)}`;
    const memoryRecords = group.records.map((record) =>
      recordFor(dataset, group.id, record),
    );
    let ingested = false;
    try {
      await client.ingestMemory(collection, memoryRecords);
      ingested = true;
      for (const benchmarkCase of group.cases) {
        const startedAt = Date.now();
        const response = await client.queryMemory(collection, {
          query: benchmarkCase.question,
          maxResults: 10,
        });
        results.push(
          evaluateCase(
            dataset,
            benchmarkCase,
            group.records,
            response,
            Date.now() - startedAt,
          ),
        );
      }
      if ((groupIndex + 1) % 10 === 0 || groupIndex + 1 === groups.length) {
        console.log(
          `processed ${groupIndex + 1}/${groups.length} groups (${results.length} cases)`,
        );
      }
    } finally {
      if (ingested && options.cleanup) await client.deleteMemory(collection);
    }
    if (options.output) {
      await writeCheckpoint(
        options.output,
        summarize(dataset, groups, results, groupIndex + 1, false),
      );
    }
  }
  return summarize(dataset, groups, results, groups.length, true);
};

const main = async () => {
  const dataset = requiredOption("--dataset") as DatasetName;
  if (!["longmemeval", "longmemeval-v2", "beam"].includes(dataset)) {
    throw new Error("--dataset must be longmemeval, longmemeval-v2, or beam.");
  }
  const limit = positiveInteger(
    "--limit",
    dataset === "longmemeval-v2" ? 451 : 500,
  );
  const groups =
    dataset === "longmemeval"
      ? await longMemEvalGroups(requiredOption("--input"), limit)
      : dataset === "longmemeval-v2"
        ? await longMemEvalV2Groups(
            requiredOption("--questions"),
            requiredOption("--haystacks"),
            requiredOption("--trajectories"),
            limit,
          )
        : await normalizedGroups(requiredOption("--input"), limit);
  const output = option("--output");
  const resume = process.argv.includes("--resume");
  const existing = resume && output ? jsonObject(await readJson(output)) : {};
  if (resume && (!output || existing.complete === true)) {
    throw new Error("--resume requires an incomplete --output checkpoint.");
  }
  if (resume && existing.dataset && existing.dataset !== dataset) {
    throw new Error("Checkpoint dataset does not match --dataset.");
  }
  const startGroup = resume ? Number(existing.processedGroups || 0) : 0;
  const initialResults =
    resume && Array.isArray(existing.results)
      ? (existing.results as CaseResult[])
      : [];
  if (
    !Number.isInteger(startGroup) ||
    startGroup < 0 ||
    startGroup > groups.length
  ) {
    throw new Error("Checkpoint processedGroups is invalid.");
  }
  const cleanup = process.env.HYDRA_EVAL_CLEANUP !== "false";
  const summary = await runGroups(
    dataset,
    groups,
    new HydraOssClient(settings()),
    {
      output,
      startGroup,
      initialResults,
      cleanup,
    },
  );
  if (output) await writeCheckpoint(output, summary);
  console.log(JSON.stringify({ ...summary, results: undefined }, null, 2));
  if (summary.cases !== limit) {
    throw new Error(`Expected ${limit} cases but evaluated ${summary.cases}.`);
  }
};

await main();
