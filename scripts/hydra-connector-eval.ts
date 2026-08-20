import "dotenv/config";

import { getFirestore } from "firebase-admin/firestore";

import { getFirebaseAdminApp } from "../src/firebase.js";
import { HydraDbClient } from "../src/hydra/client.js";
import type { HydraHostedSettings } from "../src/hydra/client.js";
import type { HydraQueryResult } from "../src/hydra/types.js";

type ConnectorProbe = {
  providerId: string;
  capabilities: string[];
  query: string;
};

type ProbeResult = {
  providerId: string;
  query: string;
  passed: boolean;
  resultCount: number;
  providerHits: string[];
  latencyMs: number;
  reason: string;
};

type ExcludedConnector = {
  providerId: string;
  status: string;
  recordsSubmitted: number;
  completedCapabilities: number;
  totalCapabilities: number;
  pendingIndexingCount: number;
  reason: string;
};

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const objectValue = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const option = (name: string, fallback?: string) => {
  const args = process.argv.slice(2);
  const index = args.findIndex((value) => value === name);
  if (index >= 0) return args[index + 1] || fallback;
  const prefix = `${name}=`;
  const inline = args.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
};

const required = (name: string, fallback?: string) => {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};

const providerNamesIn = (value: unknown): string[] => {
  const found = new Set<string>();
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    const record = objectValue(current);
    if (!record) return;
    for (const key of ["provider", "providerId", "source", "sourceId", "app"]) {
      const candidate = text(record[key]);
      if (candidate) found.add(candidate.toLocaleLowerCase());
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...found];
};

const providerMatches = (providerId: string, values: string[]) => {
  const normalized = providerId.toLocaleLowerCase().replace(/[_.-]+/g, "");
  const aliases = new Set([normalized]);
  if (normalized === "googleworkspace") {
    aliases.add("google");
    aliases.add("gmail");
    aliases.add("calendar");
    aliases.add("drive");
  }
  return values.some((value) => {
    const canonical = value.toLocaleLowerCase().replace(/[_.-]+/g, "");
    return [...aliases].some((alias) => canonical.includes(alias));
  });
};

const queryFor = (providerId: string, capabilities: string[]) => {
  const capabilityText = capabilities.join(", ");
  if (providerId === "google-workspace") {
    return "What is pending this week across my connected mail, calendar, and drive?";
  }
  if (providerId === "notion") {
    return "In Notion, which tasks and work items are currently in progress or pending?";
  }
  if (providerId === "github") {
    return "What repositories and recent project work are available in my connected GitHub context?";
  }
  if (providerId === "read-ai") {
    return "In Read AI, what meeting transcript and action items are available?";
  }
  if (providerId === "aws") {
    return "What AWS account and infrastructure context is available in my connected sources?";
  }
  return `What useful information is available from my connected ${providerId} source (${capabilityText})?`;
};

const hostedSettings = (): HydraHostedSettings => ({
  apiKey: required("HYDRA_HOSTED_API_KEY"),
  database: required("HYDRA_HOSTED_DATABASE"),
  baseUrl: required("HYDRA_HOSTED_BASE_URL", "https://api.hydradb.com").replace(
    /\/$/,
    "",
  ),
  timeoutSeconds: Number(process.env.HYDRA_DB_TIMEOUT_SECONDS || 30),
  maxRetries: 0,
  queryMaxResults: Number(process.env.HYDRA_QUERY_MAX_RESULTS || 10),
});

const probe = async (
  client: HydraDbClient,
  userId: string,
  input: ConnectorProbe,
): Promise<ProbeResult> => {
  const startedAt = Date.now();
  try {
    const result: HydraQueryResult = await client.queryKnowledge(userId, {
      query: input.query,
      maxResults: 10,
    });
    const sourceValues = providerNamesIn({
      chunks: result.chunks,
      sources: result.sources,
    });
    const hits = sourceValues.filter((value) =>
      providerMatches(input.providerId, [value]),
    );
    const passed = result.chunks.length > 0 && hits.length > 0;
    return {
      providerId: input.providerId,
      query: input.query,
      passed,
      resultCount: result.chunks.length,
      providerHits: hits,
      latencyMs: Date.now() - startedAt,
      reason: passed
        ? "Hydra returned indexed connector evidence with provider provenance."
        : result.chunks.length
          ? "Hydra returned context, but the response did not expose the expected provider provenance."
          : "Hydra returned no indexed connector chunks for this query.",
    };
  } catch (error) {
    return {
      providerId: input.providerId,
      query: input.query,
      passed: false,
      resultCount: 0,
      providerHits: [],
      latencyMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : "Hydra query failed.",
    };
  }
};

const main = async () => {
  const projectId = required("FIREBASE_PROJECT_ID");
  const app = getFirebaseAdminApp(projectId);
  const firestore = getFirestore(app);
  const requestedUserId =
    option("--user-id") || process.env.HYDRA_CONNECTOR_USER_ID;
  const users = requestedUserId
    ? [requestedUserId]
    : (await firestore.collection("hydraUsers").limit(2).get()).docs.map(
        (doc) => doc.id,
      );
  if (users.length !== 1) {
    throw new Error(
      users.length
        ? "More than one Hydra user exists. Pass --user-id for the signed-in account to evaluate."
        : "No Hydra user state exists. Sign in and complete connector sync first.",
    );
  }
  const userId = users[0]!;
  const userState =
    (await firestore.collection("hydraUsers").doc(userId).get()).data() || {};
  const connectionSnapshot = await firestore
    .collection("hydraUsers")
    .doc(userId)
    .collection("connections")
    .get();
  const connectorSnapshot = await firestore
    .collection("users")
    .doc(userId)
    .collection("connectorConnections")
    .get();
  const connectorById = new Map(
    connectorSnapshot.docs.map((document) => [document.id, document.data()]),
  );
  const allProbes = connectionSnapshot.docs.map((document) => {
    const state = document.data();
    const connection = connectorById.get(document.id);
    const providerId = text(connection?.providerId);
    const capabilities = Array.isArray(connection?.capabilities)
      ? connection.capabilities.map(text).filter(Boolean)
      : [];
    return {
      providerId,
      capabilities,
      query: queryFor(providerId, capabilities),
      state,
    };
  });
  const probes: ConnectorProbe[] = allProbes.filter(
    (probe): probe is ConnectorProbe & { state: Record<string, unknown> } =>
      Boolean(probe.providerId) &&
      probe.state.status === "ready" &&
      Number(probe.state.recordsSubmitted || 0) > 0,
  );
  const excluded: ExcludedConnector[] = allProbes
    .filter((probe) => !probes.includes(probe as (typeof probes)[number]))
    .map((probe) => {
      const status = text(probe.state.status) || "unknown";
      const recordsSubmitted = Number(probe.state.recordsSubmitted || 0);
      const completedCapabilities = Number(
        probe.state.completedCapabilities || 0,
      );
      const totalCapabilities = Number(probe.state.totalCapabilities || 0);
      const pendingIndexingCount = Array.isArray(probe.state.pendingIndexingIds)
        ? probe.state.pendingIndexingIds.length
        : 0;
      return {
        providerId: probe.providerId || "unknown",
        status,
        recordsSubmitted,
        completedCapabilities,
        totalCapabilities,
        pendingIndexingCount,
        reason:
          status !== "ready"
            ? `not-ready:${status}`
            : recordsSubmitted > 0
              ? "not-selected"
              : "no-indexed-records",
      };
    });

  if (!probes.length) {
    throw new Error(
      "No ready connector with indexed records is available for this signed-in user.",
    );
  }
  const client = new HydraDbClient(hostedSettings());
  const results: ProbeResult[] = [];
  for (const input of probes) {
    const result = await probe(client, userId, input);
    results.push(result);
    console.log(
      `${result.passed ? "PASS" : "FAIL"} ${result.providerId} — ${result.resultCount} chunk(s), ${result.latencyMs}ms — ${result.reason}`,
    );
  }
  const summary = {
    database: hostedSettings().database,
    collection: "signed-in user (redacted)",
    syncInProgress: userState.syncInProgress === true,
    lastSyncAt:
      typeof userState.lastSyncAt === "number" ? userState.lastSyncAt : null,
    nextSyncAt:
      typeof userState.nextSyncAt === "number" ? userState.nextSyncAt : null,
    readyConnectorCount: probes.length,
    excluded,
    passed: results.filter((result) => result.passed).length,
    total: results.length,
    results,
  };
  console.log(
    JSON.stringify(
      {
        ...summary,
        results: results.map(({ query: _query, ...result }) => result),
      },
      null,
      2,
    ),
  );
  const output = option("--output");
  if (output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  if (results.some((result) => !result.passed)) process.exitCode = 1;
};

await main();
