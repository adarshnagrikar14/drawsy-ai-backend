export const connectorProviderIds = [
  "google-workspace",
  "notion",
  "slack",
  "github",
] as const;

export type ConnectorProviderId = (typeof connectorProviderIds)[number];
export type ConnectorCapability =
  "mail" | "calendar" | "drive" | "notion" | "slack" | "github";

export type ConnectorProviderDefinition = {
  id: ConnectorProviderId;
  name: string;
  capabilities: readonly ConnectorCapability[];
  executionMode: "provider_api" | "remote_mcp";
  availability: "preview" | "stable";
};

export type ConnectorProviderSummary = ConnectorProviderDefinition & {
  configured: boolean;
};

export type ConnectorConnection = {
  id: string;
  providerId: ConnectorProviderId;
  accountId: string;
  accountName: string;
  accountEmail: string | null;
  accountAvatarUrl: string | null;
  capabilities: ConnectorCapability[];
  scopes: string[];
  createdAt: number;
  updatedAt: number;
};

export type ConnectorTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[];
};

export type EncryptedConnectorTokens = {
  version: 1;
  keyVersion: number;
  iv: string;
  authTag: string;
  ciphertext: string;
};

export type StoredConnectorConnection = ConnectorConnection & {
  tokens: EncryptedConnectorTokens;
};

export type ConnectorOAuthAttemptStatus = {
  status: "pending" | "connected" | "failed";
  error?: string;
};

export interface ConnectorConnectionStore {
  createOAuthState(
    userId: string,
    providerId: ConnectorProviderId,
    expiresAt: number,
    codeVerifier?: string,
  ): Promise<{ state: string; attemptId: string }>;
  consumeOAuthState(
    state: string,
    providerId: ConnectorProviderId,
  ): Promise<{ userId: string; attemptId: string; codeVerifier?: string }>;
  setOAuthAttemptStatus(
    attemptId: string,
    status: ConnectorOAuthAttemptStatus,
  ): Promise<void>;
  getOAuthAttemptStatus(
    userId: string,
    attemptId: string,
  ): Promise<ConnectorOAuthAttemptStatus>;
  listConnections(userId: string): Promise<ConnectorConnection[]>;
  getConnection(
    userId: string,
    connectionId: string,
  ): Promise<StoredConnectorConnection>;
  saveConnection(
    userId: string,
    connection: StoredConnectorConnection,
  ): Promise<void>;
  deleteConnection(userId: string, connectionId: string): Promise<void>;
}

export interface ConnectorProvider {
  readonly summary: ConnectorProviderDefinition;
  readonly supportsPkce: boolean;
  getAuthorizationUrl(state: string, codeChallenge?: string): string;
  exchangeAuthorizationCode(
    code: string,
    codeVerifier?: string,
  ): Promise<{
    account: {
      id: string;
      name: string;
      email: string | null;
      avatarUrl: string | null;
    };
    tokens: ConnectorTokens;
    capabilities: readonly ConnectorCapability[];
  }>;
  refresh(tokens: ConnectorTokens): Promise<ConnectorTokens>;
  revoke(tokens: ConnectorTokens): Promise<void>;
}

export interface ConnectorService {
  getOverview(userId: string): Promise<{
    providers: ConnectorProviderSummary[];
    connections: ConnectorConnection[];
  }>;
  getAuthorizationUrl(
    userId: string,
    providerId: ConnectorProviderId,
  ): Promise<{ authorizationUrl: string; attemptId: string }>;
  completeAuthorization(
    providerId: ConnectorProviderId,
    code: string,
    state: string,
  ): Promise<void>;
  failAuthorization(
    providerId: ConnectorProviderId,
    state: string,
    error: string,
  ): Promise<void>;
  getAuthorizationStatus(
    userId: string,
    attemptId: string,
  ): Promise<ConnectorOAuthAttemptStatus>;
  deleteConnection(userId: string, connectionId: string): Promise<void>;
  getAuthorizedCredential(
    userId: string,
    connectionId: string,
    capability: ConnectorCapability,
  ): Promise<{ providerId: ConnectorProviderId; accessToken: string }>;
}
