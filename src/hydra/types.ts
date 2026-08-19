import type {
  ConnectorAiExecutionRequest,
  ConnectorAiExecutionResult,
  ConnectorCapability,
  ConnectorConnection,
  ConnectorService,
} from "../connectors/types.js";

export type HydraKnowledgeRecord = {
  id: string;
  title: string;
  type: string;
  url: string | null;
  timestamp: string | null;
  kind: "app";
  provider: string;
  external_id: string;
  fields: { body: string };
  metadata: Record<string, string | number | boolean | null>;
  additional_metadata: Record<string, string | number | boolean | null>;
  relations?: {
    ids: string[];
    properties?: Record<string, string | number | boolean | null>;
  };
};

export type HydraMemoryRecord = {
  id: string;
  text: string;
  infer: boolean;
  additional_metadata: Record<string, string | number | boolean | null>;
  relations?: Array<{
    type: "FROM_SOURCE" | "REFERENCES_CONTEXT";
    id: string;
    label?: string;
    properties?: Record<string, string | number | boolean | null>;
  }>;
};

export type HydraQueryInput = {
  query: string;
  maxResults?: number;
  additionalContext?: string;
};

export type HydraQueryResult = {
  context: string;
  chunks: unknown[];
  graphContext: unknown;
  availability?: {
    memory: boolean;
    connectorKnowledge: boolean;
  };
};

export type HydraTurnInput = {
  eventId: string;
  sessionId: string;
  turnId: string;
  conversationId: string | null;
  surfaceKind: string;
  surfaceId: string | null;
  userMessage: string;
  assistantMessage: string;
  connectorSources: Array<{
    connectionId: string;
    capability: ConnectorCapability;
    label?: string;
    accountLabel?: string;
  }>;
  contextReferences: Array<{
    id: string;
    elementIds: string[];
  }>;
};

export type HydraStatus = {
  enabled: boolean;
  available: boolean;
  provider: "hybrid" | "managed" | "oss";
  memoryAvailable: boolean;
  connectorKnowledgeAvailable: boolean;
  database: string | null;
  collection: string | null;
  lastSeenAt: number | null;
  lastSyncAt: number | null;
  nextSyncAt: number | null;
  syncInProgress: boolean;
  connectedSources: Array<{
    id: string;
    providerId: string;
    accountName: string;
    capabilities: ConnectorCapability[];
    status: HydraConnectionSyncStatus;
    currentCapability: ConnectorCapability | null;
    completedCapabilities: number;
    totalCapabilities: number;
    recordsSubmitted: number;
    lastSyncAt: number | null;
    lastError: string | null;
  }>;
};

export type HydraConnectionSyncStatus =
  "waiting" | "syncing" | "ready" | "error" | "unsupported";

export type HydraSyncResult = {
  connections: number;
  recordsSubmitted: number;
  skippedCapabilities: string[];
  errors: Array<{ connectionId: string; message: string }>;
};

export type HydraSyncState = {
  connectionId: string;
  status: HydraConnectionSyncStatus;
  currentCapability: ConnectorCapability | null;
  completedCapabilities: number;
  totalCapabilities: number;
  recordsSubmitted: number;
  lastSyncAt: number | null;
  cursorByCapability: Record<string, string | null>;
  lastError: string | null;
};

export type HydraUserState = {
  enabled: boolean;
  lastSeenAt: number;
  lastSyncAt: number | null;
  nextSyncAt: number | null;
  syncInProgress: boolean;
};

export interface HydraStateStore {
  ensureUser(userId: string, now: number): Promise<HydraUserState>;
  getUser(userId: string): Promise<HydraUserState | null>;
  listDueUsers(now: number, limit: number): Promise<string[]>;
  tryStartSync(userId: string, now: number, leaseMs: number): Promise<boolean>;
  finishSync(
    userId: string,
    input: { finishedAt: number; nextSyncAt: number; error?: string },
  ): Promise<void>;
  getConnectionState(
    userId: string,
    connectionId: string,
  ): Promise<HydraSyncState | null>;
  saveConnectionState(userId: string, state: HydraSyncState): Promise<void>;
}

export type ConnectorSyncExecutor = (
  userId: string,
  connection: ConnectorConnection,
  request: ConnectorAiExecutionRequest,
) => Promise<ConnectorAiExecutionResult>;

export type HydraDependencies = {
  connectorService?: ConnectorService;
  executeConnector?: ConnectorSyncExecutor;
};
