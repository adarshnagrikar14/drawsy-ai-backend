import { describe, expect, it, vi } from "vitest";

import { HydraService } from "../src/hydra/service.js";

import type { HydraKnowledgeClient } from "../src/hydra/client.js";
import type {
  ConnectorConnection,
  ConnectorService,
} from "../src/connectors/types.js";
import type {
  ConnectorSyncExecutor,
  HydraStateStore,
  HydraSyncState,
  HydraUserState,
} from "../src/hydra/types.js";

const userId = "user-1";

const connection: ConnectorConnection = {
  id: "connection-1",
  providerId: "notion",
  accountId: "account-1",
  accountName: "Notion",
  accountEmail: null,
  accountAvatarUrl: null,
  manageUrl: null,
  capabilities: ["notion"],
  scopes: [],
  createdAt: 10,
  updatedAt: 10,
};

const readyState = (overrides: Partial<HydraSyncState> = {}) =>
  ({
    connectionId: connection.id,
    status: "ready",
    currentCapability: null,
    completedCapabilities: 1,
    totalCapabilities: 1,
    recordsSubmitted: 1,
    lastSyncAt: 20,
    connectionUpdatedAt: 10,
    cursorByCapability: {},
    pendingIndexingIds: [],
    lastError: null,
    ...overrides,
  }) satisfies HydraSyncState;

const createState = (
  initialConnectionState: HydraSyncState | null,
  userOverrides: Partial<HydraUserState> = {},
) => {
  let user: HydraUserState = {
    enabled: true,
    lastSeenAt: 20,
    lastSyncAt: 20,
    nextSyncAt: Date.now() + 60_000,
    syncInProgress: false,
    ...userOverrides,
  };
  let connectionState = initialConnectionState;
  const finishSync = vi.fn(
    async (
      _userId: string,
      input: {
        finishedAt: number;
        nextSyncAt: number;
        error?: string;
      },
    ) => {
      user = {
        ...user,
        lastSyncAt: input.finishedAt,
        nextSyncAt: input.nextSyncAt,
        syncInProgress: false,
      };
    },
  );
  const state: HydraStateStore = {
    ensureUser: vi.fn(async () => user),
    getUser: vi.fn(async () => user),
    listDueUsers: vi.fn(async () => []),
    tryStartSync: vi.fn(async () => {
      if (user.syncInProgress) return false;
      user = { ...user, syncInProgress: true };
      return true;
    }),
    finishSync,
    getConnectionState: vi.fn(async () => connectionState),
    saveConnectionState: vi.fn(async (_userId, nextState) => {
      connectionState = nextState;
    }),
  };
  return { state, finishSync, getConnectionState: () => connectionState };
};

const knowledgeClient = (pendingIds: string[]): HydraKnowledgeClient => ({
  ensureReady: vi.fn().mockResolvedValue(undefined),
  ingestKnowledge: vi.fn().mockResolvedValue(["source-1"]),
  checkIndexing: vi.fn().mockResolvedValue(pendingIds),
  queryKnowledge: vi.fn(),
});

const connectorService = {
  getOverview: vi.fn().mockResolvedValue({
    providers: [],
    connections: [connection],
  }),
} as unknown as ConnectorService;

const executeConnector: ConnectorSyncExecutor = vi.fn().mockResolvedValue({
  operation: "list",
  capability: "notion",
  kind: "notion_content",
  items: [
    {
      id: "item-1",
      type: "notion_page",
      title: "A page",
      summary: null,
      content: "A page body",
      url: null,
      author: null,
      createdAt: null,
      updatedAt: null,
      metadata: {},
    },
  ],
  nextCursor: null,
});

const settings = {
  enabled: true as const,
  hosted: {
    apiKey: "key",
    database: "database",
    baseUrl: "https://api.hydradb.com",
    timeoutSeconds: 30,
    maxRetries: 0,
    queryMaxResults: 10,
  },
  timeoutSeconds: 30,
  maxRetries: 0,
  syncIntervalMs: 300_000,
  syncPageSize: 50,
  queryMaxResults: 10,
};

describe("HydraService sync lifecycle", () => {
  it("keeps accepted records syncing while Hydra indexes asynchronously", async () => {
    const state = createState(null, { nextSyncAt: null });
    const service = new HydraService(
      settings,
      knowledgeClient(["source-1"]),
      null,
      state.state,
      { connectorService, executeConnector },
    );

    const result = await service.syncUser(userId);
    const saved = state.getConnectionState();

    expect(result.errors).toEqual([]);
    expect(result.recordsSubmitted).toBe(1);
    expect(saved?.status).toBe("syncing");
    expect(saved?.pendingIndexingIds).toEqual(["source-1"]);
    expect(state.finishSync).toHaveBeenCalledOnce();
    const finish = state.finishSync.mock.calls[0]![1];
    expect(finish.nextSyncAt - finish.finishedAt).toBe(30_000);
  });

  it("does not start a full sync on every status poll", async () => {
    const state = createState(readyState());
    const service = new HydraService(
      settings,
      knowledgeClient([]),
      null,
      state.state,
      { connectorService, executeConnector },
    );

    const status = await service.status(userId);

    expect(status.connectorKnowledgeAvailable).toBe(true);
    expect(state.state.tryStartSync).not.toHaveBeenCalled();
  });

  it("does not report ready when a stored state has zero completed capabilities", async () => {
    const state = createState(
      readyState({ completedCapabilities: 0, recordsSubmitted: 252 }),
    );
    const service = new HydraService(
      settings,
      knowledgeClient([]),
      null,
      state.state,
      { connectorService, executeConnector },
    );

    const status = await service.status(userId);

    expect(status.connectedSources[0]).toMatchObject({
      status: "waiting",
      completedCapabilities: 0,
      totalCapabilities: 1,
      recordsSubmitted: 252,
    });
    expect(state.state.tryStartSync).toHaveBeenCalledOnce();
  });

  it("normalizes a completed syncing state to ready", async () => {
    const state = createState(
      readyState({ status: "syncing", completedCapabilities: 1 }),
    );
    const service = new HydraService(
      settings,
      knowledgeClient([]),
      null,
      state.state,
      { connectorService, executeConnector },
    );

    const status = await service.status(userId);

    expect(status.connectedSources[0]?.status).toBe("ready");
    expect(state.state.tryStartSync).not.toHaveBeenCalled();
  });

  it("retries one Hydra indexing timeout with the same upserted records", async () => {
    const state = createState(null, { nextSyncAt: null });
    const ingestKnowledge = vi.fn().mockResolvedValue(["source-1"]);
    const checkIndexing = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce([]);
    const client: HydraKnowledgeClient = {
      ensureReady: vi.fn().mockResolvedValue(undefined),
      ingestKnowledge,
      checkIndexing,
      queryKnowledge: vi.fn(),
    };
    const service = new HydraService(settings, client, null, state.state, {
      connectorService,
      executeConnector,
    });

    const result = await service.syncUser(userId);

    expect(result.errors).toEqual([]);
    expect(ingestKnowledge).toHaveBeenCalledTimes(2);
    expect(ingestKnowledge.mock.calls[0]?.[1]).toEqual(
      ingestKnowledge.mock.calls[1]?.[1],
    );
    expect(checkIndexing).toHaveBeenCalledTimes(2);
    expect(state.getConnectionState()?.status).toBe("ready");
  });

  it("replays a connection after a previous terminal indexing timeout", async () => {
    const state = createState(
      readyState({
        status: "error",
        lastError: 'indexing: "timeout"',
        cursorByCapability: { notion: "stale-cursor" },
      }),
      { nextSyncAt: null },
    );
    const client = knowledgeClient([]);
    const service = new HydraService(settings, client, null, state.state, {
      connectorService,
      executeConnector,
    });

    const result = await service.syncUser(userId);

    expect(result.errors).toEqual([]);
    expect(client.ingestKnowledge).toHaveBeenCalledOnce();
    expect(executeConnector).toHaveBeenCalledWith(
      userId,
      connection,
      expect.objectContaining({ cursor: undefined }),
    );
    expect(state.getConnectionState()?.status).toBe("ready");
  });

  it("reuses a recent status snapshot instead of rereading Firestore", async () => {
    const state = createState(readyState());
    const service = new HydraService(
      settings,
      knowledgeClient([]),
      null,
      state.state,
      { connectorService, executeConnector },
    );

    await service.status(userId);
    await service.status(userId);

    expect(state.state.ensureUser).toHaveBeenCalledOnce();
    expect(connectorService.getOverview).toHaveBeenCalled();
  });
});
