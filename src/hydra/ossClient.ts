import { createHash } from "node:crypto";

import type { AppConfig } from "../config.js";
import type {
  HydraMemoryRecord,
  HydraQueryInput,
  HydraQueryResult,
} from "./types.js";

export type HydraMemorySettings = NonNullable<
  NonNullable<AppConfig["hydra"]>["memory"]
>;

export interface HydraMemoryClient {
  ensureReady(): Promise<void>;
  ingestMemory(
    collection: string,
    records: HydraMemoryRecord[],
  ): Promise<string[]>;
  queryMemory(
    collection: string,
    input: HydraQueryInput,
  ): Promise<HydraQueryResult>;
  deleteMemory(collection: string, ids?: string[]): Promise<void>;
}

type GraphValue = {
  type: string;
  value?: unknown;
};

type GraphQueryResponse = {
  columns?: string[];
  rows?: GraphValue[][];
  next_cursor?: number | null;
  bookmark?: string | null;
};

type GraphErrorResponse = {
  error?: {
    code?: string;
    message?: string;
  };
};

class HydraOssHttpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HydraOssHttpError";
  }
}

type ContextRecord = {
  id: string;
  kind: string;
  title: string;
  text: string;
  url: string;
  timestamp: string;
  metadata: string;
  updatedAt: string;
  sourceIds: string[];
};

const MAX_BATCH_SIZE = 100;
const MAX_QUERY_ROWS = 2_000;
const MAX_QUERY_PAGE_SIZE = 256;

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "HydraDB request failed.";

const boundedJson = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
};

const vertexId = (...parts: string[]) => {
  const digest = createHash("sha256")
    .update(parts.join("\u001f"), "utf8")
    .digest("hex");
  const value = Number.parseInt(digest.slice(0, 13), 16);
  return value || 1;
};

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const metadataText = (record: HydraMemoryRecord, key: string, fallback = "") =>
  text(record.additional_metadata[key]) || fallback;

const cellValue = (row: GraphValue[] | undefined, index: number) =>
  row?.[index]?.value ?? null;

const stringCell = (row: GraphValue[] | undefined, index: number) =>
  text(cellValue(row, index));

const queryTerms = (value: string) =>
  [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
    (term) => term.length >= 2,
  );

const occurrences = (value: string, term: string) => {
  let count = 0;
  let offset = 0;
  while (offset < value.length) {
    const found = value.indexOf(term, offset);
    if (found < 0) break;
    count += 1;
    offset = found + term.length;
  }
  return count;
};

const rowChunks = <T>(rows: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
};

export class HydraOssClient implements HydraMemoryClient {
  private ready: Promise<void> | null = null;

  constructor(private readonly settings: HydraMemorySettings) {}

  async ensureReady() {
    this.ready ||= this.checkHealth();
    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  async ingestMemory(collection: string, records: HydraMemoryRecord[]) {
    if (!records.length) return [];
    await this.ensureReady();
    await this.upsertUser(collection);

    const nodes = records.map((record) => ({
      vertex_id: vertexId("memory", collection, record.id),
      record_id: record.id,
      owner_id: collection,
      kind: "memory_turn",
      title: "Drawsy conversation memory",
      type: "drawsy_memory_turn",
      url: "",
      timestamp: metadataText(record, "observedAt", new Date().toISOString()),
      text: record.text,
      metadata: boundedJson(record.additional_metadata),
      infer: record.infer,
      session_id: metadataText(record, "sessionId"),
      conversation_id: metadataText(record, "conversationId"),
      surface_kind: metadataText(record, "surfaceKind", "unknown"),
      updated_at: new Date().toISOString(),
    }));

    const sessionRows = Array.from(
      new Map(
        nodes
          .filter((node) => node.session_id)
          .map((node) => [
            node.session_id,
            {
              session_vertex: vertexId(
                "memory-session",
                collection,
                node.session_id,
              ),
              session_id: node.session_id,
              owner_id: collection,
              surface_kind: node.surface_kind,
              updated_at: node.updated_at,
            },
          ]),
      ).values(),
    );
    const conversationRows = Array.from(
      new Map(
        nodes
          .filter((node) => node.conversation_id)
          .map((node) => [
            node.conversation_id,
            {
              conversation_vertex: vertexId(
                "memory-conversation",
                collection,
                node.conversation_id,
              ),
              conversation_id: node.conversation_id,
              owner_id: collection,
              updated_at: node.updated_at,
            },
          ]),
      ).values(),
    );

    const sourceRows = Array.from(
      new Map(
        records.flatMap((record) =>
          (record.relations || []).map((relation) => {
            const sourceVertex = vertexId(
              "memory-source",
              collection,
              relation.id,
            );
            return [
              `${relation.type}:${relation.id}`,
              {
                source_vertex: sourceVertex,
                source_id: relation.id,
                owner_id: collection,
                kind: relation.type === "FROM_SOURCE" ? "connector" : "canvas",
                label: relation.label || relation.id,
                metadata: boundedJson(relation.properties || {}),
                updated_at: new Date().toISOString(),
              },
            ] as const;
          }),
        ),
      ).values(),
    );

    for (const batch of rowChunks(nodes, MAX_BATCH_SIZE)) {
      await this.execute(
        `UNWIND $rows AS row
         MERGE (n {id: row.vertex_id})
         SET n:DrawsyContext,
             n.record_id = row.record_id,
             n.owner_id = row.owner_id,
             n.kind = row.kind,
             n.title = row.title,
             n.type = row.type,
             n.url = row.url,
             n.timestamp = row.timestamp,
             n.text = row.text,
             n.metadata = row.metadata,
             n.infer = row.infer,
             n.session_id = row.session_id,
             n.conversation_id = row.conversation_id,
             n.surface_kind = row.surface_kind,
             n.updated_at = row.updated_at`,
        { rows: batch },
      );
    }

    for (const batch of rowChunks(sessionRows, MAX_BATCH_SIZE)) {
      await this.execute(
        `UNWIND $rows AS row
         MERGE (s {id: row.session_vertex})
         SET s:DrawsySession,
             s.session_id = row.session_id,
             s.owner_id = row.owner_id,
             s.surface_kind = row.surface_kind,
             s.updated_at = row.updated_at`,
        { rows: batch },
      );
    }
    for (const batch of rowChunks(conversationRows, MAX_BATCH_SIZE)) {
      await this.execute(
        `UNWIND $rows AS row
         MERGE (c {id: row.conversation_vertex})
         SET c:DrawsyConversation,
             c.conversation_id = row.conversation_id,
             c.owner_id = row.owner_id,
             c.updated_at = row.updated_at`,
        { rows: batch },
      );
    }

    for (const batch of rowChunks(sourceRows, MAX_BATCH_SIZE)) {
      await this.execute(
        `UNWIND $rows AS row
         MERGE (s {id: row.source_vertex})
         SET s:DrawsySource,
             s.source_id = row.source_id,
             s.owner_id = row.owner_id,
             s.kind = row.kind,
             s.label = row.label,
             s.metadata = row.metadata,
             s.updated_at = row.updated_at`,
        { rows: batch },
      );
    }

    const userVertex = vertexId("user", collection, collection);
    const ownership = nodes.map((node) => ({
      record_vertex: node.vertex_id,
      user_vertex: userVertex,
      relationship_vertex: vertexId("belongs-to", collection, node.record_id),
    }));
    for (const batch of rowChunks(ownership, MAX_BATCH_SIZE)) {
      await this.execute(
        `UNWIND $rows AS row
         MATCH (n:DrawsyContext {id: row.record_vertex}),
               (u:DrawsyUser {id: row.user_vertex})
         MERGE (n)-[r:BELONGS_TO {id: row.relationship_vertex}]->(u)`,
        { rows: batch },
      );
    }

    const temporalRelations = nodes.flatMap((node) => [
      ...(node.session_id
        ? [
            {
              record_vertex: node.vertex_id,
              target_vertex: vertexId(
                "memory-session",
                collection,
                node.session_id,
              ),
              relationship_vertex: vertexId(
                "in-session",
                collection,
                node.record_id,
                node.session_id,
              ),
              type: "IN_SESSION" as const,
            },
          ]
        : []),
      ...(node.conversation_id
        ? [
            {
              record_vertex: node.vertex_id,
              target_vertex: vertexId(
                "memory-conversation",
                collection,
                node.conversation_id,
              ),
              relationship_vertex: vertexId(
                "in-conversation",
                collection,
                node.record_id,
                node.conversation_id,
              ),
              type: "IN_CONVERSATION" as const,
            },
          ]
        : []),
    ]);
    for (const type of ["IN_SESSION", "IN_CONVERSATION"] as const) {
      const rows = temporalRelations.filter(
        (relation) => relation.type === type,
      );
      const targetLabel =
        type === "IN_SESSION" ? "DrawsySession" : "DrawsyConversation";
      for (const batch of rowChunks(rows, MAX_BATCH_SIZE)) {
        await this.execute(
          `UNWIND $rows AS row
           MATCH (n:DrawsyContext {id: row.record_vertex}),
                 (target:${targetLabel} {id: row.target_vertex})
           MERGE (n)-[r:${type} {id: row.relationship_vertex}]->(target)`,
          { rows: batch },
        );
      }
    }

    const sourceRelations = records.flatMap((record) =>
      (record.relations || []).map((relation) => ({
        record_vertex: vertexId("memory", collection, record.id),
        source_vertex: vertexId("memory-source", collection, relation.id),
        relationship_vertex: vertexId(
          relation.type.toLowerCase(),
          collection,
          record.id,
          relation.id,
        ),
        source_id: relation.id,
        type: relation.type,
      })),
    );
    for (const type of ["FROM_SOURCE", "REFERENCES_CONTEXT"] as const) {
      const rows = sourceRelations.filter((relation) => relation.type === type);
      for (const batch of rowChunks(rows, MAX_BATCH_SIZE)) {
        await this.execute(
          `UNWIND $rows AS row
           MATCH (n:DrawsyContext {id: row.record_vertex}),
                 (s:DrawsySource {id: row.source_vertex})
           MERGE (n)-[r:${type} {id: row.relationship_vertex}]->(s)
           SET r.source_id = row.source_id`,
          { rows: batch },
        );
      }
    }

    return records.map((record) => record.id);
  }

  async queryMemory(collection: string, input: HydraQueryInput) {
    await this.ensureReady();
    const userVertex = vertexId("user", collection, collection);
    const records: ContextRecord[] = [];
    let cursor: number | undefined;

    do {
      const response = await this.execute(
        `MATCH (n:DrawsyContext)-[:BELONGS_TO]->(u:DrawsyUser {id: $user_vertex})
         OPTIONAL MATCH (n)-[:FROM_SOURCE]->(connector:DrawsySource)
         OPTIONAL MATCH (n)-[:REFERENCES_CONTEXT]->(canvas:DrawsySource)
         RETURN n.record_id AS record_id,
                n.kind AS kind,
                n.title AS title,
                n.text AS text,
                n.url AS url,
                n.timestamp AS timestamp,
                n.metadata AS metadata,
                n.updated_at AS updated_at,
                collect(connector.source_id) AS connector_source_ids,
                collect(canvas.source_id) AS canvas_source_ids
         ORDER BY timestamp DESC, updated_at DESC`,
        { user_vertex: userVertex },
        { cursor, consistency: "strong", pageSize: MAX_QUERY_PAGE_SIZE },
      );
      records.push(
        ...(response.rows || [])
          .map((row) => ({
            id: stringCell(row, 0),
            kind: stringCell(row, 1),
            title: stringCell(row, 2),
            text: stringCell(row, 3),
            url: stringCell(row, 4),
            timestamp: stringCell(row, 5),
            metadata: stringCell(row, 6),
            updatedAt: stringCell(row, 7),
            sourceIds: [cellValue(row, 8), cellValue(row, 9)]
              .flatMap((value) => (Array.isArray(value) ? value : []))
              .filter((value): value is string => typeof value === "string"),
          }))
          .filter((record) => record.id && record.text),
      );
      if (records.length >= MAX_QUERY_ROWS || response.next_cursor == null) {
        break;
      }
      cursor = response.next_cursor;
    } while (cursor !== undefined);

    const terms = queryTerms(
      [input.query, input.additionalContext || ""].filter(Boolean).join(" "),
    );
    const ranked = records
      .map((record) => {
        const haystack = `${record.title}\n${record.text}`.toLocaleLowerCase();
        const title = record.title.toLocaleLowerCase();
        const score = terms.reduce(
          (total, term) =>
            total + occurrences(haystack, term) + occurrences(title, term) * 2,
          0,
        );
        return { record, score };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.record.updatedAt.localeCompare(left.record.updatedAt),
      )
      .slice(0, input.maxResults || this.settings.queryMaxResults);

    const matches = terms.length
      ? ranked.filter(({ score }) => score > 0)
      : ranked;
    const selected = matches
      .slice(0, input.maxResults || this.settings.queryMaxResults)
      .map(({ record, score }) => ({
        id: record.id,
        kind: record.kind,
        title: record.title,
        text: record.text,
        url: record.url || null,
        timestamp: record.timestamp || null,
        score,
        metadata: record.metadata,
        sourceIds: record.sourceIds,
      }));

    return {
      context: selected
        .map(
          (record) =>
            `[${record.kind}] ${record.title}\n${record.text}${
              record.url ? `\nSource: ${record.url}` : ""
            }`,
        )
        .join("\n\n"),
      chunks: selected,
      sources: selected.map((record) => ({
        id: record.id,
        title: "Personal memory",
        type: "memory",
      })),
      graphContext: {
        provider: "hydradb-oss",
        graphId: this.settings.graphId,
        namespace: this.settings.namespace,
        nodes: selected.map((record) => ({
          id: record.id,
          kind: record.kind,
          title: record.title,
          sourceIds: record.sourceIds,
        })),
        relationships: [
          "BELONGS_TO",
          "IN_SESSION",
          "IN_CONVERSATION",
          "FROM_SOURCE",
          "REFERENCES_CONTEXT",
        ],
      },
      availability: {
        memory: true,
        connectorKnowledge: false,
      },
    } satisfies HydraQueryResult;
  }

  async deleteMemory(collection: string, ids?: string[]) {
    await this.ensureReady();
    const userVertex = vertexId("user", collection, collection);
    if (ids?.length) {
      for (const id of ids) {
        await this.execute(
          `MATCH (n:DrawsyContext {id: $vertex_id})-[:BELONGS_TO]->
                 (u:DrawsyUser {id: $user_vertex})
           WHERE n.kind = "memory" OR n.kind = "memory_turn"
           DETACH DELETE n`,
          {
            vertex_id: vertexId("memory", collection, id),
            user_vertex: userVertex,
          },
        );
      }
      return;
    }
    await this.execute(
      `MATCH (n)-[:BELONGS_TO]->
             (u:DrawsyUser {id: $user_vertex})
       WHERE n.kind = "memory" OR n.kind = "memory_turn"
       DETACH DELETE n`,
      { user_vertex: userVertex },
    );
  }

  private async upsertUser(collection: string) {
    await this.execute(
      `UNWIND $rows AS row
       MERGE (u {id: row.user_vertex})
       SET u:DrawsyUser, u.user_id = row.user_id, u.updated_at = row.updated_at`,
      {
        rows: [
          {
            user_vertex: vertexId("user", collection, collection),
            user_id: collection,
            updated_at: new Date().toISOString(),
          },
        ],
      },
    );
  }

  private async checkHealth() {
    const response = await this.request<{ status?: string }>(
      `${this.settings.baseUrl}/healthz`,
      { method: "GET" },
    );
    if (response.status !== "ok") {
      throw new Error("HydraDB OSS health check did not return ready.");
    }
    await this.execute(
      "MATCH (n:DrawsyContext) RETURN n.id AS id",
      {},
      { consistency: "strong", pageSize: 1 },
    );
  }

  private async execute(
    query: string,
    parameters: Record<string, unknown>,
    options: {
      cursor?: number;
      consistency?: "strong";
      pageSize?: number;
    } = {},
  ) {
    return this.request<GraphQueryResponse>(
      `${this.settings.baseUrl}/v1/graphs/${encodeURIComponent(
        this.settings.graphId,
      )}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          cell_id: this.settings.cellId,
          query,
          parameters,
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options.consistency ? { consistency: options.consistency } : {}),
          ...(options.pageSize ? { page_size: options.pageSize } : {}),
        }),
      },
    );
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.settings.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.settings.timeoutSeconds * 1000,
      );
      timeout.unref?.();
      try {
        const response = await fetch(url, {
          ...init,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.settings.authToken}`,
            "content-type": "application/json",
            "x-graph-namespace": this.settings.namespace,
            ...(init.headers || {}),
          },
          signal: controller.signal,
        });
        const bodyText = await response.text();
        let payload: unknown = {};
        if (bodyText) {
          try {
            payload = JSON.parse(bodyText);
          } catch {
            throw new Error("HydraDB OSS returned invalid JSON.");
          }
        }
        if (!response.ok) {
          const message =
            (payload as GraphErrorResponse).error?.message ||
            `HydraDB OSS request failed (${response.status}).`;
          const retryable =
            [408, 425, 429].includes(response.status) || response.status >= 500;
          if (attempt < this.settings.maxRetries && retryable) {
            lastError = new Error(message);
            await sleep(200 * (attempt + 1));
            continue;
          }
          throw new HydraOssHttpError(message, retryable);
        }
        return payload as T;
      } catch (error) {
        lastError = error;
        if (error instanceof HydraOssHttpError && !error.retryable) {
          throw error;
        }
        if (attempt >= this.settings.maxRetries) throw error;
        await sleep(200 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(errorMessage(lastError));
  }
}
