import { z } from "zod";

import { ApiError } from "../http/apiError.js";

import type { AppConfig } from "../config.js";
import type { ConnectorProvider, ConnectorTokens } from "./types.js";

const AUTHORIZATION_URL = "https://slack.com/oauth/v2/authorize";
const TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const REVOKE_URL = "https://slack.com/api/auth.revoke";
const USER_INFO_URL = "https://slack.com/api/users.info";
const USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "search:read",
  "users:read",
  "users:read.email",
];

const tokenResponse = z.object({
  ok: z.literal(true),
  team: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  authed_user: z.object({
    id: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
    scope: z.string().default(""),
  }),
});

const userInfoResponse = z.object({
  ok: z.literal(true),
  user: z.object({
    real_name: z.string().optional(),
    name: z.string().min(1),
    profile: z.object({
      email: z.string().email().optional(),
      image_72: z.url().optional(),
    }),
  }),
});

export class SlackProvider implements ConnectorProvider {
  readonly supportsPkce = false;
  readonly summary = {
    id: "slack",
    name: "Slack",
    capabilities: ["slack"],
    executionMode: "provider_api",
    availability: "stable",
  } as const;

  constructor(
    private readonly config: NonNullable<
      NonNullable<AppConfig["connectors"]>["slack"]
    >,
    private readonly httpTimeoutMs: number,
  ) {}

  getAuthorizationUrl(state: string) {
    const parameters = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      user_scope: USER_SCOPES.join(","),
      state,
    });
    return `${AUTHORIZATION_URL}?${parameters}`;
  }

  async exchangeAuthorizationCode(code: string) {
    const response = await this.tokenRequest({
      code,
      redirect_uri: this.config.redirectUri,
    });
    const account = await this.fetchUser(
      response.authed_user.access_token,
      response.authed_user.id,
    );
    return {
      account: {
        id: `${response.team.id}:${response.authed_user.id}`,
        name: `${response.team.name} · ${account.real_name || account.name}`,
        email: account.profile.email || null,
        avatarUrl: account.profile.image_72 || null,
      },
      tokens: this.toTokens(response),
      capabilities: ["slack"] as const,
    };
  }

  async refresh(tokens: ConnectorTokens) {
    if (!tokens.refreshToken) {
      return tokens;
    }
    return this.toTokens(
      await this.tokenRequest({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }),
    );
  }

  async revoke(tokens: ConnectorTokens) {
    const response = await fetch(REVOKE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${tokens.accessToken}`,
      },
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    const result = z
      .object({ ok: z.boolean(), revoked: z.boolean().optional() })
      .safeParse(await response.json());
    if (!response.ok || !result.success || !result.data.ok) {
      throw new ApiError(
        502,
        "connector_revoke_failed",
        "Slack access could not be revoked.",
      );
    }
  }

  private async tokenRequest(body: Record<string, string>) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(
          `${this.config.clientId}:${this.config.clientSecret}`,
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    const result = tokenResponse.safeParse(await response.json());
    if (!response.ok || !result.success) {
      throw new ApiError(
        502,
        "connector_oauth_failed",
        "Slack authorization failed.",
      );
    }
    return result.data;
  }

  private async fetchUser(accessToken: string, userId: string) {
    const target = new URL(USER_INFO_URL);
    target.searchParams.set("user", userId);
    const response = await fetch(target, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    const result = userInfoResponse.safeParse(await response.json());
    if (!response.ok || !result.success) {
      throw new ApiError(
        502,
        "connector_account_failed",
        "Slack account details could not be loaded.",
      );
    }
    return result.data.user;
  }

  private toTokens(response: z.infer<typeof tokenResponse>): ConnectorTokens {
    const user = response.authed_user;
    return {
      accessToken: user.access_token,
      refreshToken: user.refresh_token || null,
      expiresAt: user.expires_in ? Date.now() + user.expires_in * 1000 : null,
      scopes: user.scope.split(",").filter(Boolean),
    };
  }
}
