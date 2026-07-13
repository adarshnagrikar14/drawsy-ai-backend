import { randomUUID } from "node:crypto";

import { ApiError } from "../http/apiError.js";
import { JiraCrypto } from "./crypto.js";

import type { AppConfig } from "../config.js";
import type {
  JiraConnectionStore,
  JiraService,
  JiraSite,
  JiraTokens,
  StoredJiraConnection,
} from "./types.js";

const AUTH_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const API_URL = "https://api.atlassian.com";
const SCOPES = [
  "offline_access",
  "read:jira-work",
  "read:jira-user",
  "write:jira-work",
  "read:board-scope:jira-software",
  "read:project:jira",
  "read:issue-details:jira",
  "read:sprint:jira-software",
  "write:sprint:jira-software",
  "read:servicedesk-request",
  "write:servicedesk-request",
];

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
};

export class AtlassianJiraService implements JiraService {
  private readonly config: NonNullable<AppConfig["jira"]>;
  private readonly crypto: JiraCrypto;
  private readonly refreshes = new Map<string, Promise<StoredJiraConnection>>();

  constructor(
    config: NonNullable<AppConfig["jira"]>,
    private readonly store: JiraConnectionStore,
  ) {
    this.config = config;
    this.crypto = new JiraCrypto(
      config.encryptionKeys,
      config.encryptionKeyVersion,
    );
  }

  async getAuthorizationUrl(userId: string) {
    const { state, attemptId } = await this.store.createOAuthState(
      userId,
      Date.now() + this.config.stateTtlMs,
    );
    const parameters = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: this.config.clientId,
      scope: SCOPES.join(" "),
      redirect_uri: this.config.redirectUri,
      state,
      response_type: "code",
      prompt: "consent",
    });
    return { authorizationUrl: `${AUTH_URL}?${parameters}`, attemptId };
  }

  async completeAuthorization(code: string, state: string) {
    const { userId, attemptId } = await this.store.consumeOAuthState(state);
    try {
      const tokenResponse = await this.tokenRequest({
        grant_type: "authorization_code",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.redirectUri,
      });
      const sites = await this.fetchJson<JiraSite[]>(
        `${API_URL}/oauth/token/accessible-resources`,
        tokenResponse.access_token,
      );
      if (!sites.length) {
        throw new ApiError(
          400,
          "jira_site_unavailable",
          "No accessible Jira site was granted.",
        );
      }
      const primarySite = sites[0]!;
      const account = await this.fetchJson<{
        accountId: string;
        displayName: string;
        emailAddress?: string;
        avatarUrls?: Record<string, string>;
      }>(
        `${API_URL}/ex/jira/${encodeURIComponent(primarySite.id)}/rest/api/3/myself`,
        tokenResponse.access_token,
      );
      const now = Date.now();
      const connectionId = account.accountId || randomUUID();
      const tokens: JiraTokens = {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt: now + tokenResponse.expires_in * 1000,
        scope: tokenResponse.scope,
      };
      await this.store.saveConnection(userId, {
        id: connectionId,
        accountId: account.accountId,
        accountName: account.displayName,
        accountEmail: account.emailAddress || null,
        accountAvatarUrl:
          account.avatarUrls?.["48x48"] ||
          account.avatarUrls?.["32x32"] ||
          null,
        sites,
        createdAt: now,
        updatedAt: now,
        tokens: this.crypto.encrypt(userId, connectionId, tokens),
      });
      await this.store.setOAuthAttemptStatus(attemptId, {
        status: "connected",
      });
    } catch (error) {
      await this.store.setOAuthAttemptStatus(attemptId, {
        status: "failed",
        error:
          error instanceof Error && "code" in error
            ? String(error.code)
            : "authorization_failed",
      });
      throw error;
    }
  }

  async failAuthorization(state: string, error: string) {
    const { attemptId } = await this.store.consumeOAuthState(state);
    await this.store.setOAuthAttemptStatus(attemptId, {
      status: "failed",
      error,
    });
  }

  getAuthorizationStatus(userId: string, attemptId: string) {
    return this.store.getOAuthAttemptStatus(userId, attemptId);
  }

  listConnections(userId: string) {
    return this.store.listConnections(userId);
  }

  deleteConnection(userId: string, connectionId: string) {
    return this.store.deleteConnection(userId, connectionId);
  }

  async request<T>(
    userId: string,
    connectionId: string,
    cloudId: string,
    path: string,
    init: RequestInit = {},
    api: "jira" | "software" | "servicedesk" = "jira",
  ) {
    if (!path.startsWith("/") || path.includes("..")) {
      throw new ApiError(
        400,
        "invalid_jira_path",
        "Jira request path is invalid.",
      );
    }
    let connection = await this.store.getConnection(userId, connectionId);
    if (!connection.sites.some((site) => site.id === cloudId)) {
      throw new ApiError(
        403,
        "jira_site_forbidden",
        "This Jira site is not part of the connection.",
      );
    }
    connection = await this.refreshIfNeeded(userId, connection);
    let tokens = this.crypto.decrypt(userId, connection.id, connection.tokens);
    let response = await this.jiraFetch(
      cloudId,
      api,
      path,
      tokens.accessToken,
      init,
    );
    if (response.status === 401) {
      connection = await this.refresh(userId, connection, true);
      tokens = this.crypto.decrypt(userId, connection.id, connection.tokens);
      response = await this.jiraFetch(
        cloudId,
        api,
        path,
        tokens.accessToken,
        init,
      );
    }
    if (!response.ok) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "jira_upstream_request_failed",
          status: response.status,
          api,
          path,
        }),
      );
      throw await this.toApiError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async refreshIfNeeded(
    userId: string,
    connection: StoredJiraConnection,
  ) {
    const tokens = this.crypto.decrypt(
      userId,
      connection.id,
      connection.tokens,
    );
    return tokens.expiresAt - Date.now() <= 60_000
      ? this.refresh(userId, connection)
      : connection;
  }

  private refresh(
    userId: string,
    connection: StoredJiraConnection,
    force = false,
  ) {
    const key = `${userId}:${connection.id}`;
    const existing = this.refreshes.get(key);
    if (existing) {
      return existing;
    }
    const promise = this.performRefresh(userId, connection, force).finally(
      () => {
        this.refreshes.delete(key);
      },
    );
    this.refreshes.set(key, promise);
    return promise;
  }

  private async performRefresh(
    userId: string,
    connection: StoredJiraConnection,
    force: boolean,
  ) {
    const latest = await this.store.getConnection(userId, connection.id);
    const current = this.crypto.decrypt(userId, latest.id, latest.tokens);
    if (!force && current.expiresAt - Date.now() > 60_000) {
      return latest;
    }
    const refreshed = await this.tokenRequest({
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: current.refreshToken,
    });
    const updated: StoredJiraConnection = {
      ...latest,
      updatedAt: Date.now(),
      tokens: this.crypto.encrypt(userId, latest.id, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: Date.now() + refreshed.expires_in * 1000,
        scope: refreshed.scope,
      }),
    };
    await this.store.saveConnection(userId, updated);
    return updated;
  }

  private async tokenRequest(body: Record<string, string>) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.httpTimeoutMs),
    });
    if (!response.ok) {
      throw new ApiError(
        502,
        "jira_oauth_failed",
        "Atlassian authorization failed.",
      );
    }
    return (await response.json()) as TokenResponse;
  }

  private fetchJson<T>(url: string, accessToken: string) {
    return fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(this.config.httpTimeoutMs),
    }).then(async (response) => {
      if (!response.ok) {
        throw await this.toApiError(response);
      }
      return (await response.json()) as T;
    });
  }

  private jiraFetch(
    cloudId: string,
    api: "jira" | "software" | "servicedesk",
    path: string,
    accessToken: string,
    init: RequestInit,
  ) {
    const base =
      api === "software"
        ? "rest/agile/1.0"
        : api === "servicedesk"
          ? "rest/servicedeskapi"
          : "rest/api/3";
    return fetch(
      `${API_URL}/ex/jira/${encodeURIComponent(cloudId)}/${base}${path}`,
      {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
      },
    );
  }

  private async toApiError(response: Response) {
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 429) {
      return new ApiError(
        429,
        "jira_rate_limited",
        retryAfter
          ? `Jira rate limit reached. Retry in ${retryAfter} seconds.`
          : "Jira rate limit reached. Try again shortly.",
      );
    }
    if (response.status === 401) {
      return new ApiError(
        401,
        "jira_reauthorization_required",
        "Reconnect Jira to continue.",
      );
    }
    if (response.status === 403) {
      return new ApiError(
        403,
        "jira_permission_denied",
        "Jira denied this action for your account.",
      );
    }
    if (response.status === 404) {
      return new ApiError(
        404,
        "jira_resource_not_found",
        "The Jira resource was not found.",
      );
    }
    const detail = (await response.json().catch(() => null)) as {
      errorMessages?: string[];
      message?: string;
    } | null;
    return new ApiError(
      response.status >= 500 ? 502 : 400,
      "jira_request_failed",
      detail?.errorMessages?.[0] ||
        detail?.message ||
        "Jira could not complete the request.",
    );
  }
}
