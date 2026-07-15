import { z } from "zod";

import { ApiError } from "../http/apiError.js";
import { RemoteMcpClient } from "./remoteMcpClient.js";

import type { AppConfig } from "../config.js";
import type {
  ConnectorAuthorizationResult,
  ConnectorProvider,
  ConnectorProviderDefinition,
  ConnectorTokens,
} from "./types.js";

type RemoteMcpConfig = {
  clientId: string;
  redirectUri: string;
};

type RemoteMcpProviderOptions = {
  summary: ConnectorProviderDefinition;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  serverUrl: string;
  scopes: readonly string[];
  userInfoEndpoint?: string;
  profileTool?: string;
  accountFallback?: {
    id: string;
    name: string;
  };
};

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
});

const userInfoSchema = z
  .object({
    sub: z.string().min(1),
    email: z.string().email().optional(),
    name: z.string().min(1).optional(),
    picture: z.string().url().optional(),
  })
  .passthrough();

const isTextContent = (
  value: unknown,
): value is { type: "text"; text: string } => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.type === "text" && typeof candidate.text === "string";
};

abstract class RemoteMcpOAuthProvider implements ConnectorProvider {
  readonly supportsPkce = true;
  readonly summary: ConnectorProviderDefinition;

  protected constructor(
    private readonly config: RemoteMcpConfig,
    private readonly httpTimeoutMs: number,
    private readonly options: RemoteMcpProviderOptions,
  ) {
    this.summary = options.summary;
  }

  getAuthorizationUrl(state: string, codeChallenge?: string) {
    if (!codeChallenge) {
      throw new Error("Remote MCP OAuth requires PKCE");
    }
    const parameters = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: this.options.scopes.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      resource: this.options.serverUrl,
    });
    return `${this.options.authorizationEndpoint}?${parameters}`;
  }

  async exchangeAuthorizationCode(code: string, codeVerifier?: string) {
    if (!codeVerifier) {
      throw new ApiError(
        400,
        "connector_oauth_pkce_missing",
        "OAuth verification data is missing or expired.",
      );
    }
    const tokens = await this.tokenRequest({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.config.redirectUri,
      resource: this.options.serverUrl,
    });
    return {
      account: await this.account(tokens.accessToken),
      tokens,
      capabilities: this.summary.capabilities,
    } satisfies ConnectorAuthorizationResult;
  }

  async refresh(tokens: ConnectorTokens) {
    if (!tokens.refreshToken) {
      throw new ApiError(
        401,
        "connector_reauthorization_required",
        `${this.summary.name} must be connected again.`,
      );
    }
    return this.tokenRequest({
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      refresh_token: tokens.refreshToken,
      resource: this.options.serverUrl,
    });
  }

  async revoke(tokens: ConnectorTokens) {
    const response = await fetch(this.options.revocationEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        token: tokens.refreshToken || tokens.accessToken,
      }),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!response.ok) {
      throw new ApiError(
        502,
        "connector_revoke_failed",
        `${this.summary.name} access could not be revoked.`,
      );
    }
  }

  private async tokenRequest(body: Record<string, string>) {
    const response = await fetch(this.options.tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    const result = tokenResponseSchema.safeParse(await response.json());
    if (!response.ok || !result.success) {
      throw new ApiError(
        502,
        "connector_oauth_failed",
        `${this.summary.name} authorization failed.`,
      );
    }
    return {
      accessToken: result.data.access_token,
      refreshToken: result.data.refresh_token || null,
      expiresAt: result.data.expires_in
        ? Date.now() + result.data.expires_in * 1000
        : null,
      scopes: (result.data.scope || this.options.scopes.join(" "))
        .split(/[ ,]+/)
        .filter(Boolean),
    } satisfies ConnectorTokens;
  }

  private async account(accessToken: string) {
    if (this.options.userInfoEndpoint) {
      const response = await fetch(this.options.userInfoEndpoint, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      });
      const result = userInfoSchema.safeParse(await response.json());
      if (!response.ok || !result.success) {
        throw new ApiError(
          502,
          "connector_account_failed",
          `${this.summary.name} account details could not be loaded.`,
        );
      }
      return {
        id: result.data.sub,
        name: result.data.name || result.data.email || this.summary.name,
        email: result.data.email || null,
        avatarUrl: result.data.picture || null,
      };
    }
    return this.remoteMcpAccount(accessToken);
  }

  private async remoteMcpAccount(accessToken: string) {
    const providerId = this.summary.id;
    if (providerId !== "fireflies" || !this.options.profileTool) {
      throw new Error("Remote MCP profile resolution is not configured");
    }
    let result;
    try {
      result = await new RemoteMcpClient(
        this.httpTimeoutMs,
        64 * 1024,
      ).callReadOnlyTool(providerId, accessToken, this.options.profileTool, {});
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "connector_mcp_unavailable" &&
        this.options.accountFallback
      ) {
        return {
          ...this.options.accountFallback,
          email: null,
          avatarUrl: null,
        };
      }
      throw error;
    }
    const profile = this.profileObject(
      result.structuredContent || result.content,
    );
    const email = this.profileValue(profile, ["email"]);
    const id = this.profileValue(profile, ["user_id", "userId", "id"]) || email;
    if (!id) {
      throw new ApiError(
        502,
        "connector_account_failed",
        `${this.summary.name} account details could not be loaded.`,
      );
    }
    return {
      id,
      name:
        this.profileValue(profile, ["name", "display_name", "displayName"]) ||
        email ||
        this.summary.name,
      email,
      avatarUrl: this.profileValue(profile, [
        "avatar",
        "avatar_url",
        "picture",
      ]),
    };
  }

  private profileObject(value: unknown): unknown {
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) {
      const text = (value as unknown[]).find(isTextContent);
      return text ? this.profileObject(text.text) : value;
    }
    return value;
  }

  private profileValue(value: unknown, keys: string[]): string | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (keys.includes(key) && typeof entry === "string" && entry.trim()) {
        return entry.trim();
      }
      const nested = this.profileValue(entry, keys);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
}

export class ReadAiProvider extends RemoteMcpOAuthProvider {
  constructor(
    config: NonNullable<NonNullable<AppConfig["connectors"]>["readAi"]>,
    httpTimeoutMs: number,
  ) {
    super(config, httpTimeoutMs, {
      summary: {
        id: "read-ai",
        name: "Read AI",
        capabilities: ["read-ai"],
        executionMode: "remote_mcp",
        availability: "preview",
      },
      authorizationEndpoint: "https://authn.read.ai/oauth2/auth",
      tokenEndpoint: "https://authn.read.ai/oauth2/token",
      revocationEndpoint: "https://authn.read.ai/oauth2/revoke",
      userInfoEndpoint: "https://authn.read.ai/userinfo",
      serverUrl: "https://api.read.ai/mcp",
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "meeting:read",
        "mcp:execute",
      ],
    });
  }
}

export class FirefliesProvider extends RemoteMcpOAuthProvider {
  constructor(
    config: NonNullable<NonNullable<AppConfig["connectors"]>["fireflies"]>,
    httpTimeoutMs: number,
  ) {
    super(config, httpTimeoutMs, {
      summary: {
        id: "fireflies",
        name: "Fireflies",
        capabilities: ["fireflies"],
        executionMode: "remote_mcp",
        availability: "stable",
      },
      authorizationEndpoint: "https://api.fireflies.ai/authorize",
      tokenEndpoint: "https://api.fireflies.ai/token",
      revocationEndpoint: "https://api.fireflies.ai/revoke",
      serverUrl: "https://api.fireflies.ai/mcp",
      scopes: ["profile", "email"],
      profileTool: "fireflies_get_user",
      accountFallback: {
        id: "fireflies-account",
        name: "Fireflies",
      },
    });
  }
}
