export type EncryptedJiraTokens = {
  version: 1;
  keyVersion: number;
  iv: string;
  authTag: string;
  ciphertext: string;
};

export type JiraTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
};

export type JiraSite = {
  id: string;
  name: string;
  url: string;
  avatarUrl?: string;
  scopes: string[];
};

export type JiraConnection = {
  id: string;
  accountId: string;
  accountName: string;
  accountEmail: string | null;
  accountAvatarUrl: string | null;
  sites: JiraSite[];
  createdAt: number;
  updatedAt: number;
};

export type StoredJiraConnection = JiraConnection & {
  tokens: EncryptedJiraTokens;
};

export type JiraOAuthAttemptStatus = {
  status: "pending" | "connected" | "failed";
  error?: string;
};

export interface JiraConnectionStore {
  createOAuthState(
    userId: string,
    expiresAt: number,
  ): Promise<{ state: string; attemptId: string }>;
  consumeOAuthState(
    state: string,
  ): Promise<{ userId: string; attemptId: string }>;
  setOAuthAttemptStatus(
    attemptId: string,
    status: JiraOAuthAttemptStatus,
  ): Promise<void>;
  getOAuthAttemptStatus(
    userId: string,
    attemptId: string,
  ): Promise<JiraOAuthAttemptStatus>;
  listConnections(userId: string): Promise<JiraConnection[]>;
  getConnection(
    userId: string,
    connectionId: string,
  ): Promise<StoredJiraConnection>;
  saveConnection(
    userId: string,
    connection: StoredJiraConnection,
  ): Promise<void>;
  deleteConnection(userId: string, connectionId: string): Promise<void>;
}

export interface JiraService {
  getAuthorizationUrl(
    userId: string,
  ): Promise<{ authorizationUrl: string; attemptId: string }>;
  completeAuthorization(code: string, state: string): Promise<void>;
  failAuthorization(state: string, error: string): Promise<void>;
  getAuthorizationStatus(
    userId: string,
    attemptId: string,
  ): Promise<JiraOAuthAttemptStatus>;
  listConnections(userId: string): Promise<JiraConnection[]>;
  deleteConnection(userId: string, connectionId: string): Promise<void>;
  request<T>(
    userId: string,
    connectionId: string,
    cloudId: string,
    path: string,
    init?: RequestInit,
    api?: "jira" | "software" | "servicedesk",
  ): Promise<T>;
}
