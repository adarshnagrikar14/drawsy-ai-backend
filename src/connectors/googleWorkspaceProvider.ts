import { ApiError } from "../http/apiError.js";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { ConnectorProvider, ConnectorTokens } from "./types.js";

const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USER_INFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];

const googleTokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().default(""),
});

const googleAccountResponse = z.object({
  sub: z.string().min(1),
  name: z.string().optional(),
  email: z.string().email(),
  picture: z.url().optional(),
});

export class GoogleWorkspaceProvider implements ConnectorProvider {
  readonly supportsPkce = true;
  readonly summary = {
    id: "google-workspace",
    name: "Google Workspace",
    capabilities: ["mail", "calendar", "drive"],
    executionMode: "provider_api",
    availability: "stable",
  } as const;

  constructor(
    private readonly config: NonNullable<
      NonNullable<AppConfig["connectors"]>["googleWorkspace"]
    >,
    private readonly httpTimeoutMs: number,
  ) {}

  getAuthorizationUrl(state: string, codeChallenge?: string) {
    const parameters = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      ...(codeChallenge
        ? { code_challenge: codeChallenge, code_challenge_method: "S256" }
        : {}),
    });
    return `${AUTHORIZATION_URL}?${parameters}`;
  }

  async exchangeAuthorizationCode(code: string, codeVerifier?: string) {
    const tokenResponse = await this.tokenRequest({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    });
    if (!tokenResponse.refresh_token) {
      throw new ApiError(
        502,
        "connector_refresh_token_missing",
        "Google did not grant durable connector access.",
      );
    }
    const account = await this.fetchAccount(tokenResponse.access_token);
    return {
      account: {
        id: account.sub,
        name: account.name || account.email,
        email: account.email || null,
        avatarUrl: account.picture || null,
      },
      tokens: this.toTokens(tokenResponse),
      capabilities: this.capabilitiesFor(tokenResponse.scope),
    };
  }

  async refresh(tokens: ConnectorTokens) {
    if (!tokens.refreshToken) {
      throw new ApiError(
        401,
        "connector_reauthorization_required",
        "Google Workspace must be connected again.",
      );
    }
    const response = await this.tokenRequest({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    });
    return {
      ...this.toTokens(response),
      refreshToken: response.refresh_token || tokens.refreshToken,
      scopes: response.scope
        ? response.scope.split(" ").filter(Boolean)
        : tokens.scopes,
    };
  }

  async revoke(tokens: ConnectorTokens) {
    const parameters = new URLSearchParams({
      token: tokens.refreshToken || tokens.accessToken,
    });
    const response = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: parameters,
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!response.ok) {
      throw new ApiError(
        502,
        "connector_revoke_failed",
        "Google Workspace access could not be revoked.",
      );
    }
  }

  private async tokenRequest(body: Record<string, string>) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!response.ok) {
      throw new ApiError(
        502,
        "connector_oauth_failed",
        "Google Workspace authorization failed.",
      );
    }
    const result = googleTokenResponse.safeParse(await response.json());
    if (!result.success) {
      throw new ApiError(
        502,
        "connector_oauth_invalid_response",
        "Google Workspace returned an invalid authorization response.",
      );
    }
    return result.data;
  }

  private async fetchAccount(accessToken: string) {
    const response = await fetch(USER_INFO_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!response.ok) {
      throw new ApiError(
        502,
        "connector_account_failed",
        "Google Workspace account details could not be loaded.",
      );
    }
    const result = googleAccountResponse.safeParse(await response.json());
    if (!result.success) {
      throw new ApiError(
        502,
        "connector_account_invalid_response",
        "Google Workspace returned invalid account details.",
      );
    }
    return result.data;
  }

  private toTokens(
    response: z.infer<typeof googleTokenResponse>,
  ): ConnectorTokens {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token || null,
      expiresAt: Date.now() + response.expires_in * 1000,
      scopes: response.scope.split(" ").filter(Boolean),
    };
  }

  private capabilitiesFor(scope: string) {
    const scopes = new Set(scope.split(" ").filter(Boolean));
    return [
      ...(scopes.has("https://www.googleapis.com/auth/gmail.readonly")
        ? (["mail"] as const)
        : []),
      ...(scopes.has("https://www.googleapis.com/auth/calendar.events.readonly")
        ? (["calendar"] as const)
        : []),
      ...(scopes.has("https://www.googleapis.com/auth/drive.readonly")
        ? (["drive"] as const)
        : []),
    ];
  }
}
