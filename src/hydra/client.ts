import { HydraDBClient, HydraDBError } from "@hydradb/sdk";
import { buildString } from "@hydradb/sdk/helpers";

import type { AppConfig } from "../config.js";
import type {
  HydraKnowledgeRecord,
  HydraQueryInput,
  HydraQueryResult,
} from "./types.js";

export type HydraHostedSettings = NonNullable<
  NonNullable<AppConfig["hydra"]>["hosted"]
>;

export interface HydraKnowledgeClient {
  ensureReady(): Promise<void>;
  ingestKnowledge(
    collection: string,
    records: HydraKnowledgeRecord[],
  ): Promise<string[]>;
  checkIndexing(collection: string, ids: string[]): Promise<string[]>;
  queryKnowledge(
    collection: string,
    input: HydraQueryInput,
  ): Promise<HydraQueryResult>;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "HydraDB request failed.";

const responseData = <T>(response: { data?: T }) => {
  if (!response.data) {
    throw new Error("HydraDB returned an empty response.");
  }
  return response.data;
};

export class HydraDbClient implements HydraKnowledgeClient {
  private readonly client: HydraDBClient;
  private ready: Promise<void> | null = null;

  constructor(private readonly settings: HydraHostedSettings) {
    if (!settings.apiKey || !settings.database) {
      throw new Error(
        "Hosted HydraDB connector knowledge requires an API key and database.",
      );
    }
    this.client = new HydraDBClient({
      token: settings.apiKey,
      baseUrl: settings.baseUrl,
      apiVersion: "2",
      timeoutInSeconds: settings.timeoutSeconds,
      maxRetries: settings.maxRetries,
    });
  }

  async ensureReady() {
    this.ready ||= this.waitForDatabase();
    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  async ingestKnowledge(collection: string, records: HydraKnowledgeRecord[]) {
    if (!records.length) return [];
    await this.ensureReady();
    const response = await this.client.context.ingest({
      type: "knowledge",
      database: this.settings.database,
      collection,
      upsert: "true",
      appKnowledge: JSON.stringify(records),
    });
    return (responseData(response).results || [])
      .map((item) => item.id)
      .filter((id): id is string => Boolean(id));
  }

  async checkIndexing(collection: string, ids: string[]) {
    if (!ids.length) return [];
    await this.ensureReady();
    const pending = new Set(ids);
    const response = await this.client.context.status({
      database: this.settings.database,
      collection,
      ids: [...pending],
    });
    const statuses = responseData(response).statuses || [];
    for (const status of statuses) {
      if (!status.id) continue;
      if (status.indexingStatus === "completed") {
        pending.delete(status.id);
      } else if (
        status.indexingStatus === "failed" ||
        status.indexingStatus === "errored"
      ) {
        const failure = [status.errorCode, status.errorMessage]
          .filter((value): value is string => Boolean(value))
          .join(": ");
        throw new Error(failure || `HydraDB failed to index ${status.id}.`);
      }
    }
    // Hydra keeps sources in queued, processing, and graph_creation while
    // indexing continues. They are not failures and must be checked again
    // later instead of blocking connector synchronization.
    return [...pending];
  }

  async queryKnowledge(
    collection: string,
    input: HydraQueryInput,
  ): Promise<HydraQueryResult> {
    await this.ensureReady();
    const response = await this.client.query({
      database: this.settings.database,
      collection,
      query: input.query,
      additionalContext: input.additionalContext,
      type: "knowledge",
      queryBy: "hybrid",
      mode: "fast",
      queryApps: true,
      maxResults: input.maxResults || this.settings.queryMaxResults,
      graphContext: true,
      recencyBias: 0.2,
    });
    const data = responseData(response);
    return {
      context: buildString(response),
      chunks: data.chunks || [],
      sources: data.sources || [],
      graphContext: data.graphContext || null,
      availability: {
        memory: false,
        connectorKnowledge: true,
      },
    } satisfies HydraQueryResult;
  }

  private async waitForDatabase() {
    let created = false;
    const deadline = Date.now() + this.settings.timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      try {
        const response = await this.client.databases.status({
          database: this.settings.database,
        });
        const infra = responseData(response).infra;
        if (infra?.readyForIngestion === true) return;
      } catch (error) {
        if (!(error instanceof HydraDBError) || error.statusCode !== 404) {
          throw new Error(`HydraDB is unavailable: ${errorMessage(error)}`);
        }
        if (!created) {
          await this.client.databases.create({
            database: this.settings.database,
          });
          created = true;
        }
      }
      await sleep(1_000);
    }
    throw new Error("HydraDB database did not become ready in time.");
  }
}
