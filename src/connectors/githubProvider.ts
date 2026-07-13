import { z } from "zod";

import { ApiError } from "../http/apiError.js";

import type { AppConfig } from "../config.js";
import type { ConnectorProvider, ConnectorTokens } from "./types.js";

const AUTHORIZATION_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_URL = "https://api.github.com";

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().default(""),
});

const accountResponse = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullable(),
  email: z.string().email().nullable(),
  avatar_url: z.url().nullable(),
});

export class GitHubProvider implements ConnectorProvider {
  readonly supportsPkce = true;
  readonly summary = {
    id: "github",
    name: "GitHub",
    capabilities: ["github"],
    executionMode: "provider_api",
    availability: "stable",
  } as const;

  constructor(
    private readonly config: NonNullable<
      NonNullable<AppConfig["connectors"]>["github"]
    >,
    private readonly httpTimeoutMs: number,
  ) {}

  getAuthorizationUrl(state: string, codeChallenge?: string) {
    const parameters = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      state,
      ...(codeChallenge
        ? { code_challenge: codeChallenge, code_challenge_method: "S256" }
        : {}),
    });
    return `${AUTHORIZATION_URL}?${parameters}`;
  }

  async exchangeAuthorizationCode(code: string, codeVerifier?: string) {
    const response = await this.tokenRequest({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: this.config.redirectUri,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    });
    const account = await this.fetchAccount(response.access_token);
    return {
      account: {
        id: String(account.id),
        name: account.name || account.login,
        email: account.email,
        avatarUrl: account.avatar_url,
      },
      tokens: this.toTokens(response),
      capabilities: ["github"] as const,
    };
  }

  async refresh(tokens: ConnectorTokens) {
    if (!tokens.refreshToken) {
      return tokens;
    }
    return this.toTokens(
      await this.tokenRequest({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }),
    );
  }

  async revoke(tokens: ConnectorTokens) {
    const response = await fetch(
      `${API_URL}/applications/${encodeURIComponent(this.config.clientId)}/token`,
      {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Basic ${Buffer.from(
            `${this.config.clientId}:${this.config.clientSecret}`,
          ).toString("base64")}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ access_token: tokens.accessToken }),
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new ApiError(
        502,
        "connector_revoke_failed",
        "GitHub access could not be revoked.",
      );
    }
  }

  private async tokenRequest(body: Record<string, string>) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!response.ok) {
      throw new ApiError(
        502,
        "connector_oauth_failed",
        "GitHub authorization failed.",
      );
    }
    const result = tokenResponse.safeParse(await response.json());
    if (!result.success) {
      throw new ApiError(
        502,
        "connector_oauth_invalid_response",
        "GitHub returned an invalid authorization response.",
      );
    }
    return result.data;
  }

  private async fetchAccount(accessToken: string) {
    const response = await fetch(`${API_URL}/user`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!response.ok) {
      throw new ApiError(
        502,
        "connector_account_failed",
        "GitHub account details could not be loaded.",
      );
    }
    const result = accountResponse.safeParse(await response.json());
    if (!result.success) {
      throw new ApiError(
        502,
        "connector_account_invalid_response",
        "GitHub returned invalid account details.",
      );
    }
    return result.data;
  }

  private toTokens(response: z.infer<typeof tokenResponse>): ConnectorTokens {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token || null,
      expiresAt: response.expires_in
        ? Date.now() + response.expires_in * 1000
        : null,
      scopes: response.scope.split(/[ ,]+/).filter(Boolean),
    };
  }
}
