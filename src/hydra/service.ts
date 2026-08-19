import { createHash, randomUUID } from "node:crypto";

import { ApiError } from "../http/apiError.js";

import type { AppConfig } from "../config.js";
import type {
  ConnectorAiExecutionRequest,
  ConnectorAiItem,
  ConnectorCapability,
  ConnectorConnection,
  ConnectorService,
} from "../connectors/types.js";
import type { HydraKnowledgeClient } from "./client.js";
import type { HydraMemoryClient } from "./ossClient.js";
import type {
  ConnectorSyncExecutor,
  HydraDependencies,
  HydraKnowledgeRecord,
  HydraMemoryRecord,
  HydraQueryInput,
  HydraQueryResult,
  HydraStatus,
  HydraSyncResult,
  HydraSyncState,
  HydraTurnInput,
  HydraStateStore,
} from "./types.js";

type HydraSettings = NonNullable<AppConfig["hydra"]>;

const MAX_TEXT_LENGTH = 80_000;
const SYNC_LEASE_MS = 10 * 60 * 1000;
const INITIAL_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAGES_PER_CAPABILITY = 3;

const hashId = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex");

const text = (value: unknown, fallback = "") =>
  typeof value === "string" ? value.trim() : fallback;

const boundedText = (value: string, limit = MAX_TEXT_LENGTH) =>
  value.length > limit ? value.slice(0, limit) : value;

const jsonText = (value: unknown) => {
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
};

const requestBase = (
  connectionId: string,
): Pick<
  Extract<ConnectorAiExecutionRequest, { operation: "list" }>,
  "sessionId" | "turnId" | "connectionId"
> => ({
  sessionId: "hydra-sync",
  turnId: randomUUID(),
  connectionId,
});

const itemText = (item: ConnectorAiItem) =>
  boundedText(
    [item.title, item.summary, item.content]
      .map((value) => text(value))
      .filter(Boolean)
      .join("\n\n"),
  );

const itemRecord = (
  connection: ConnectorConnection,
  capability: ConnectorCapability,
  item: ConnectorAiItem,
): HydraKnowledgeRecord | null => {
  const content = itemText(item);
  if (!content) return null;
  return {
    id: `drawsy_${hashId(connection.id, capability, item.id)}`,
    title: text(item.title, `${connection.providerId} ${item.type}`),
    type: `drawsy_${connection.providerId}_${item.type}`,
    url: item.url,
    timestamp: item.updatedAt || item.createdAt,
    kind: "app",
    provider: connection.providerId,
    external_id: item.id,
    fields: { body: content },
    metadata: {
      provider: connection.providerId,
      capability,
      connection: connection.id,
      account: connection.accountId,
    },
    additional_metadata: {
      ...item.metadata,
      providerId: connection.providerId,
      connectionId: connection.id,
      capability,
      externalId: item.id,
      accountId: connection.accountId,
    },
  };
};

const remoteResultText = (value: unknown) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return (value as unknown[])
      .map((entry) => {
        const record =
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)
            : null;
        if (typeof record?.text === "string") {
          return record.text;
        }
        return jsonText(entry);
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return jsonText(value);
};

const remoteRecord = (
  connection: ConnectorConnection,
  capability: ConnectorCapability,
  toolName: string,
  content: unknown,
) => {
  const value = boundedText(remoteResultText(content));
  if (!value) return null;
  return {
    id: `drawsy_${hashId(connection.id, capability, toolName, value)}`,
    title: `${connection.providerId}: ${toolName}`,
    type: `drawsy_${connection.providerId}_mcp`,
    url: null,
    timestamp: new Date().toISOString(),
    kind: "app" as const,
    provider: connection.providerId,
    external_id: `${toolName}:${hashId(value)}`,
    fields: { body: value },
    metadata: {
      provider: connection.providerId,
      capability,
      connection: connection.id,
      account: connection.accountId,
    },
    additional_metadata: {
      providerId: connection.providerId,
      connectionId: connection.id,
      capability,
      toolName,
      accountId: connection.accountId,
    },
  } satisfies HydraKnowledgeRecord;
};

const isListResult = (
  value: Awaited<ReturnType<ConnectorSyncExecutor>>,
): value is Extract<
  Awaited<ReturnType<ConnectorSyncExecutor>>,
  { operation: "list" | "search" }
> => value.operation === "list" || value.operation === "search";

const isRemoteToolsResult = (
  value: Awaited<ReturnType<ConnectorSyncExecutor>>,
): value is Extract<
  Awaited<ReturnType<ConnectorSyncExecutor>>,
  { operation: "mcp_tools" }
> => value.operation === "mcp_tools";

const isRemoteCallResult = (
  value: Awaited<ReturnType<ConnectorSyncExecutor>>,
): value is Extract<
  Awaited<ReturnType<ConnectorSyncExecutor>>,
  { operation: "mcp_call" }
> => value.operation === "mcp_call";

const SYNCABLE_CAPABILITIES = new Set<ConnectorCapability>([
  "mail",
  "calendar",
  "drive",
  "notion",
  "slack",
  "github",
  "read-ai",
  "fireflies",
  "aws",
]);

export class HydraService {
  private readonly locks = new Set<string>();
  private scheduler: NodeJS.Timeout | null = null;

  constructor(
    private readonly settings: HydraSettings,
    private readonly knowledgeClient: HydraKnowledgeClient | null,
    private readonly memoryClient: HydraMemoryClient | null,
    private readonly state: HydraStateStore,
    private readonly dependencies: HydraDependencies = {},
  ) {}

  start() {
    if (this.scheduler) return;
    this.scheduler = setInterval(
      () => void this.syncDueUsers(),
      this.settings.syncIntervalMs,
    );
    this.scheduler.unref?.();
  }

  stop() {
    if (!this.scheduler) return;
    clearInterval(this.scheduler);
    this.scheduler = null;
  }

  async status(userId: string): Promise<HydraStatus> {
    const now = Date.now();
    const user = await this.state.ensureUser(userId, now);
    const [connectorKnowledgeAvailable, memoryAvailable] = await Promise.all([
      this.checkReady(this.knowledgeClient, userId, "connector_knowledge"),
      this.checkReady(this.memoryClient, userId, "personal_memory"),
    ]);
    const connections = this.dependencies.connectorService
      ? (await this.dependencies.connectorService.getOverview(userId))
          .connections
      : [];
    if (connectorKnowledgeAvailable) {
      void this.syncUser(userId).catch((error) =>
        this.log("hydra_status_sync_failed", { userId, error }),
      );
    }
    const hosted = this.settings.hosted;
    const memory = this.settings.memory;
    return {
      enabled: true,
      available: memoryAvailable,
      provider:
        connectorKnowledgeAvailable && memoryAvailable
          ? "hybrid"
          : connectorKnowledgeAvailable
            ? "managed"
            : "oss",
      memoryAvailable,
      connectorKnowledgeAvailable,
      database: hosted?.database || memory?.graphId || null,
      collection: userId,
      lastSeenAt: user.lastSeenAt,
      lastSyncAt: user.lastSyncAt,
      nextSyncAt: user.nextSyncAt,
      syncInProgress: user.syncInProgress,
      connectedSources: await Promise.all(
        connections.map(async (connection) => {
          const sync = await this.state.getConnectionState(
            userId,
            connection.id,
          );
          return {
            id: connection.id,
            providerId: connection.providerId,
            accountName: connection.accountName,
            capabilities: connection.capabilities,
            status:
              sync?.status ||
              (connection.capabilities.some((capability) =>
                SYNCABLE_CAPABILITIES.has(capability),
              )
                ? "waiting"
                : "unsupported"),
            currentCapability: sync?.currentCapability || null,
            completedCapabilities: sync?.completedCapabilities || 0,
            totalCapabilities:
              sync?.totalCapabilities ||
              connection.capabilities.filter((capability) =>
                SYNCABLE_CAPABILITIES.has(capability),
              ).length,
            recordsSubmitted: sync?.recordsSubmitted || 0,
            lastSyncAt: sync?.lastSyncAt || null,
            lastError: sync?.lastError || null,
          };
        }),
      ),
    };
  }

  async query(userId: string, input: HydraQueryInput) {
    if (!input.query.trim()) {
      throw new ApiError(400, "hydra_query_empty", "A query is required.");
    }
    const user = await this.state.ensureUser(userId, Date.now());
    if (
      this.knowledgeClient &&
      (user.nextSyncAt === null || user.nextSyncAt <= Date.now())
    ) {
      void this.syncUser(userId).catch((error) =>
        this.log("hydra_query_sync_failed", { userId, error }),
      );
    }
    const query = {
      ...input,
      query: boundedText(input.query, 20_000),
    };
    const [knowledge, memory] = await Promise.all([
      this.queryKnowledge(userId, query),
      this.queryMemory(userId, query),
    ]);
    if (!knowledge && !memory) {
      throw new ApiError(
        503,
        "hydra_unavailable",
        "Hydra context is not available right now.",
      );
    }
    return {
      context: [
        knowledge?.context ? `[Connector context]\n${knowledge.context}` : "",
        memory?.context ? `[Personal memory]\n${memory.context}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      chunks: [
        ...(knowledge?.chunks || []).map((chunk) => ({
          source: "connector",
          chunk,
        })),
        ...(memory?.chunks || []).map((chunk) => ({
          source: "memory",
          chunk,
        })),
      ],
      graphContext: {
        connector: knowledge?.graphContext || null,
        memory: memory?.graphContext || null,
      },
      availability: {
        memory: Boolean(memory),
        connectorKnowledge: Boolean(knowledge),
      },
    } satisfies HydraQueryResult;
  }

  async ingestTurn(userId: string, input: HydraTurnInput) {
    if (!input.eventId || !input.sessionId || !input.turnId) {
      throw new ApiError(
        400,
        "hydra_turn_identity_missing",
        "A session, turn, and event identity are required.",
      );
    }
    const userMessage = boundedText(input.userMessage.trim(), 20_000);
    const assistantMessage = boundedText(input.assistantMessage.trim(), 60_000);
    if (!userMessage && !assistantMessage) {
      return { accepted: true, sourceIds: [] };
    }
    await this.state.ensureUser(userId, Date.now());
    const connectorText = input.connectorSources.length
      ? `Connected sources used: ${input.connectorSources
          .map(
            (source) =>
              `${source.label || source.capability} (${source.accountLabel || source.connectionId})`,
          )
          .join(", ")}`
      : "";
    const contextText = input.contextReferences.length
      ? `Canvas context references: ${input.contextReferences
          .map(
            (context) =>
              `${context.id} [${context.elementIds.length} elements]`,
          )
          .join(", ")}`
      : "";
    const memory: HydraMemoryRecord = {
      id: `drawsy_turn_${hashId(userId, input.eventId)}`,
      text: boundedText(
        [
          `User: ${userMessage}`,
          assistantMessage ? `Assistant: ${assistantMessage}` : "",
          connectorText,
          contextText,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
      infer: true,
      additional_metadata: {
        source: "drawsy_chat",
        memoryType: "conversation_turn",
        observedAt: new Date().toISOString(),
        eventId: input.eventId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        conversationId: input.conversationId,
        surfaceKind: input.surfaceKind,
        surfaceId: input.surfaceId,
      },
      relations: [
        ...input.connectorSources.map((source) => ({
          type: "FROM_SOURCE" as const,
          id: `connector:${source.connectionId}`,
          label: source.label || source.capability,
          properties: {
            capability: source.capability,
            accountLabel: source.accountLabel || null,
          },
        })),
        ...input.contextReferences.map((context) => ({
          type: "REFERENCES_CONTEXT" as const,
          id: `canvas:${context.id}`,
          label: context.id,
          properties: { elementCount: context.elementIds.length },
        })),
      ],
    };
    if (!this.memoryClient) {
      return { accepted: true, sourceIds: [], memoryAvailable: false };
    }
    try {
      const ids = await this.memoryClient.ingestMemory(userId, [memory]);
      return { accepted: true, sourceIds: ids, memoryAvailable: true };
    } catch (error) {
      this.log("hydra_memory_write_failed", {
        userId,
        error: error instanceof Error ? error.message : error,
      });
      return { accepted: true, sourceIds: [], memoryAvailable: false };
    }
  }

  async deleteMemory(userId: string, ids?: string[]) {
    await this.state.ensureUser(userId, Date.now());
    if (this.memoryClient) {
      await this.memoryClient.deleteMemory(userId, ids);
    }
  }

  private async checkReady(
    client: { ensureReady(): Promise<void> } | null,
    userId: string,
    store: "connector_knowledge" | "personal_memory",
  ) {
    if (!client) return false;
    try {
      await client.ensureReady();
      return true;
    } catch (error) {
      this.log("hydra_store_unavailable", {
        userId,
        store,
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  private async queryKnowledge(userId: string, input: HydraQueryInput) {
    if (!this.knowledgeClient) return null;
    try {
      await this.knowledgeClient.ensureReady();
      return await this.knowledgeClient.queryKnowledge(userId, input);
    } catch (error) {
      this.log("hydra_connector_query_failed", {
        userId,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  private async queryMemory(userId: string, input: HydraQueryInput) {
    if (!this.memoryClient) return null;
    try {
      await this.memoryClient.ensureReady();
      return await this.memoryClient.queryMemory(userId, input);
    } catch (error) {
      this.log("hydra_memory_query_failed", {
        userId,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  async syncUser(userId: string): Promise<HydraSyncResult> {
    if (!this.knowledgeClient) {
      return {
        connections: 0,
        recordsSubmitted: 0,
        skippedCapabilities: [],
        errors: [],
      };
    }
    if (this.locks.has(userId)) {
      return {
        connections: 0,
        recordsSubmitted: 0,
        skippedCapabilities: [],
        errors: [],
      };
    }
    const started = await this.state.tryStartSync(
      userId,
      Date.now(),
      SYNC_LEASE_MS,
    );
    if (!started) {
      return {
        connections: 0,
        recordsSubmitted: 0,
        skippedCapabilities: [],
        errors: [],
      };
    }
    this.locks.add(userId);
    const result: HydraSyncResult = {
      connections: 0,
      recordsSubmitted: 0,
      skippedCapabilities: [],
      errors: [],
    };
    let fatalError: string | undefined;
    try {
      if (
        !this.dependencies.connectorService ||
        !this.dependencies.executeConnector
      ) {
        return result;
      }
      const connections = (
        await this.dependencies.connectorService.getOverview(userId)
      ).connections;
      result.connections = connections.length;
      for (const connection of connections) {
        try {
          const synced = await this.syncConnection(userId, connection);
          result.recordsSubmitted += synced.recordsSubmitted;
          result.skippedCapabilities.push(...synced.skippedCapabilities);
          result.errors.push(
            ...synced.errors.map((message) => ({
              connectionId: connection.id,
              message,
            })),
          );
        } catch (error) {
          result.errors.push({
            connectionId: connection.id,
            message: error instanceof Error ? error.message : "Sync failed.",
          });
        }
      }
      return result;
    } catch (error) {
      fatalError = error instanceof Error ? error.message : "Sync failed.";
      throw error;
    } finally {
      await this.state
        .finishSync(userId, {
          finishedAt: Date.now(),
          nextSyncAt: Date.now() + this.settings.syncIntervalMs,
          ...(fatalError
            ? { error: fatalError }
            : result.errors.length
              ? { error: `${result.errors.length} connection(s) failed.` }
              : {}),
        })
        .catch((error) =>
          this.log("hydra_sync_state_update_failed", {
            userId,
            error: error instanceof Error ? error.message : error,
          }),
        );
      this.locks.delete(userId);
    }
  }

  private async syncDueUsers() {
    try {
      const users = await this.state.listDueUsers(Date.now(), 4);
      await Promise.all(users.map((userId) => this.syncUser(userId)));
    } catch (error) {
      this.log("hydra_scheduler_failed", { error });
    }
  }

  private async syncConnection(
    userId: string,
    connection: ConnectorConnection,
  ) {
    const executor = this.dependencies.executeConnector;
    if (!executor) {
      return { recordsSubmitted: 0, skippedCapabilities: [], errors: [] };
    }
    const previous =
      (await this.state.getConnectionState(userId, connection.id)) ||
      ({
        connectionId: connection.id,
        status: "waiting",
        currentCapability: null,
        completedCapabilities: 0,
        totalCapabilities: 0,
        recordsSubmitted: 0,
        lastSyncAt: null,
        cursorByCapability: {},
        lastError: null,
      } satisfies HydraSyncState);
    const syncableCapabilities = connection.capabilities.filter((capability) =>
      SYNCABLE_CAPABILITIES.has(capability),
    );
    const nextState: HydraSyncState = {
      ...previous,
      cursorByCapability: { ...previous.cursorByCapability },
      status: syncableCapabilities.length ? "syncing" : "unsupported",
      currentCapability: null,
      completedCapabilities: 0,
      totalCapabilities: syncableCapabilities.length,
      recordsSubmitted: 0,
      lastError: null,
    };
    await this.state.saveConnectionState(userId, nextState);
    let recordsSubmitted = 0;
    const skippedCapabilities: string[] = [];
    const errors: string[] = [];
    for (const capability of connection.capabilities) {
      if (!SYNCABLE_CAPABILITIES.has(capability)) {
        skippedCapabilities.push(capability);
        continue;
      }
      nextState.currentCapability = capability;
      await this.state.saveConnectionState(userId, nextState);
      try {
        let cursor = nextState.cursorByCapability[capability] || null;
        let pages = 0;
        do {
          const page = await this.syncCapability(
            userId,
            connection,
            capability,
            previous.lastSyncAt,
            cursor,
            executor,
          );
          if (page.records.length) {
            const ids = await this.knowledgeClient!.ingestKnowledge(
              userId,
              page.records,
            );
            await this.knowledgeClient!.waitForIndexing(userId, ids);
            recordsSubmitted += page.records.length;
          }
          cursor = page.nextCursor;
          nextState.cursorByCapability[capability] = cursor;
          nextState.recordsSubmitted = recordsSubmitted;
          pages += 1;
          await this.state.saveConnectionState(userId, nextState);
        } while (cursor && pages < MAX_PAGES_PER_CAPABILITY);
        if (!cursor) {
          nextState.cursorByCapability[capability] = null;
        }
        nextState.completedCapabilities += 1;
        nextState.currentCapability = null;
        await this.state.saveConnectionState(userId, nextState);
      } catch (error) {
        errors.push(
          `${capability}: ${error instanceof Error ? error.message : "Sync failed."}`,
        );
        nextState.lastError = errors.join("; ");
        nextState.completedCapabilities += 1;
        nextState.currentCapability = null;
        await this.state.saveConnectionState(userId, nextState);
      }
    }
    nextState.lastSyncAt = errors.length ? previous.lastSyncAt : Date.now();
    nextState.status = errors.length
      ? "error"
      : syncableCapabilities.length
        ? "ready"
        : "unsupported";
    nextState.currentCapability = null;
    nextState.recordsSubmitted = recordsSubmitted;
    await this.state.saveConnectionState(userId, nextState);
    return { recordsSubmitted, skippedCapabilities, errors };
  }

  private async syncCapability(
    userId: string,
    connection: ConnectorConnection,
    capability: ConnectorCapability,
    lastSyncAt: number | null,
    cursor: string | null,
    executor: ConnectorSyncExecutor,
  ) {
    const after = new Date(
      lastSyncAt || Date.now() - INITIAL_HISTORY_MS,
    ).toISOString();
    if (capability === "read-ai" || capability === "fireflies") {
      return this.syncRemoteMcp(userId, connection, capability, executor);
    }
    if (capability === "slack") {
      return this.syncSlack(userId, connection, after, cursor, executor);
    }
    if (capability === "github") {
      return this.syncGitHub(userId, connection, cursor, executor);
    }
    if (capability === "aws") {
      return this.syncAws(userId, connection, cursor, executor);
    }
    const request = {
      ...requestBase(connection.id),
      operation: "list" as const,
      capability,
      cursor: cursor || undefined,
      limit: this.settings.syncPageSize,
      ...(capability === "mail"
        ? { kind: "mail_messages" as const, after }
        : capability === "calendar"
          ? {
              kind: "calendar_events" as const,
              startTime: after,
              endTime: new Date(
                Date.now() + 365 * 24 * 60 * 60 * 1000,
              ).toISOString(),
            }
          : capability === "drive"
            ? {
                kind: "drive_files" as const,
                orderBy: "modifiedTime desc" as const,
              }
            : {
                kind: "notion_content" as const,
                sortDirection: "descending" as const,
                object: "page" as const,
              }),
    } as ConnectorAiExecutionRequest;
    const result = await executor(userId, connection, request);
    if (!isListResult(result)) {
      throw new Error(
        `Connector ${connection.providerId} returned no list data.`,
      );
    }
    return {
      records: result.items
        .map((item) => itemRecord(connection, capability, item))
        .filter((item): item is HydraKnowledgeRecord => Boolean(item)),
      nextCursor: result.nextCursor,
    };
  }

  private async syncSlack(
    userId: string,
    connection: ConnectorConnection,
    after: string,
    cursor: string | null,
    executor: ConnectorSyncExecutor,
  ) {
    const channels = await executor(userId, connection, {
      ...requestBase(connection.id),
      operation: "list",
      capability: "slack",
      kind: "slack_channels",
      cursor: cursor || undefined,
      limit: this.settings.syncPageSize,
    });
    if (!isListResult(channels)) throw new Error("Slack returned no channels.");
    const records = channels.items
      .map((item) => itemRecord(connection, "slack", item))
      .filter((item): item is HydraKnowledgeRecord => Boolean(item));
    for (const channel of channels.items) {
      const channelId = text(channel.metadata.channelId || channel.id);
      if (!channelId) continue;
      const messages = await executor(userId, connection, {
        ...requestBase(connection.id),
        operation: "list",
        capability: "slack",
        kind: "slack_messages",
        channelId,
        startTime: after,
        limit: this.settings.syncPageSize,
      });
      if (isListResult(messages)) {
        records.push(
          ...messages.items
            .map((item) => itemRecord(connection, "slack", item))
            .filter((item): item is HydraKnowledgeRecord => Boolean(item)),
        );
      }
    }
    return { records, nextCursor: channels.nextCursor };
  }

  private async syncGitHub(
    userId: string,
    connection: ConnectorConnection,
    cursor: string | null,
    executor: ConnectorSyncExecutor,
  ) {
    const repositories = await executor(userId, connection, {
      ...requestBase(connection.id),
      operation: "list",
      capability: "github",
      kind: "github_repositories",
      visibility: "all",
      cursor: cursor || undefined,
      limit: this.settings.syncPageSize,
    });
    if (!isListResult(repositories)) {
      throw new Error("GitHub returned no repositories.");
    }
    const records = repositories.items
      .map((item) => itemRecord(connection, "github", item))
      .filter((item): item is HydraKnowledgeRecord => Boolean(item));
    for (const repository of repositories.items) {
      const name = text(repository.metadata.fullName || repository.title);
      if (!name) continue;
      const contents = await executor(userId, connection, {
        ...requestBase(connection.id),
        operation: "list",
        capability: "github",
        kind: "github_repository_contents",
        repository: name,
        limit: this.settings.syncPageSize,
      });
      if (isListResult(contents)) {
        records.push(
          ...contents.items
            .map((item) => itemRecord(connection, "github", item))
            .filter((item): item is HydraKnowledgeRecord => Boolean(item)),
        );
      }
      for (const kind of ["github_issues", "github_pull_requests"] as const) {
        const result = await executor(userId, connection, {
          ...requestBase(connection.id),
          operation: "list",
          capability: "github",
          kind,
          repository: name,
          state: "all",
          sort: "updated",
          direction: "desc",
          limit: Math.min(this.settings.syncPageSize, 30),
        });
        if (isListResult(result)) {
          records.push(
            ...result.items
              .map((item) => itemRecord(connection, "github", item))
              .filter((item): item is HydraKnowledgeRecord => Boolean(item)),
          );
        }
      }
    }
    return { records, nextCursor: repositories.nextCursor };
  }

  private async syncAws(
    userId: string,
    connection: ConnectorConnection,
    cursor: string | null,
    executor: ConnectorSyncExecutor,
  ) {
    const regions = await executor(userId, connection, {
      ...requestBase(connection.id),
      operation: "list",
      capability: "aws",
      kind: "aws_regions",
    });
    if (!isListResult(regions)) throw new Error("AWS returned no regions.");
    const records = regions.items
      .map((item) => itemRecord(connection, "aws", item))
      .filter((item): item is HydraKnowledgeRecord => Boolean(item));
    const selectedRegions = regions.items
      .map((item) => text(item.metadata.region || item.title))
      .filter(Boolean)
      .slice(0, 10);
    for (const region of selectedRegions) {
      const stacks = await executor(userId, connection, {
        ...requestBase(connection.id),
        operation: "list",
        capability: "aws",
        kind: "aws_cloudformation_stacks",
        region,
        cursor: cursor || undefined,
        limit: this.settings.syncPageSize,
      });
      if (isListResult(stacks)) {
        records.push(
          ...stacks.items
            .map((item) => itemRecord(connection, "aws", item))
            .filter((item): item is HydraKnowledgeRecord => Boolean(item)),
        );
      }
    }
    return { records, nextCursor: null };
  }

  private async syncRemoteMcp(
    userId: string,
    connection: ConnectorConnection,
    capability: "read-ai" | "fireflies",
    executor: ConnectorSyncExecutor,
  ) {
    const toolResult = await executor(userId, connection, {
      ...requestBase(connection.id),
      operation: "mcp_tools",
      capability,
    });
    if (!isRemoteToolsResult(toolResult)) {
      throw new Error(`${connection.providerId} returned no MCP tools.`);
    }
    const records: HydraKnowledgeRecord[] = [];
    for (const tool of toolResult.tools || []) {
      const required = tool.inputSchema.required;
      if (Array.isArray(required) && required.length) continue;
      if (!/(get|list|search|fetch|read|meeting|transcript)/i.test(tool.name)) {
        continue;
      }
      const result = await executor(userId, connection, {
        ...requestBase(connection.id),
        operation: "mcp_call",
        capability,
        toolName: tool.name,
        arguments: {},
      });
      if (!isRemoteCallResult(result)) continue;
      const record = remoteRecord(
        connection,
        capability,
        tool.name,
        result.structuredContent || result.content,
      );
      if (record) records.push(record);
    }
    return { records, nextCursor: null };
  }

  private log(message: string, fields: Record<string, unknown>) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message,
        ...fields,
      }),
    );
  }
}

export const createConnectorSyncExecutor = (
  connectorService: ConnectorService,
  timeoutMs: number,
  maxOutputBytes: number,
): ConnectorSyncExecutor => {
  return async (userId, connection, request) => {
    const credential = await connectorService.getAuthorizedCredential(
      userId,
      connection.id,
      request.capability,
    );
    const { ConnectorAiExecutor } = await import("../connectors/aiExecutor.js");
    return new ConnectorAiExecutor(timeoutMs, maxOutputBytes).execute(
      credential.providerId,
      credential.accessToken,
      request,
    );
  };
};
