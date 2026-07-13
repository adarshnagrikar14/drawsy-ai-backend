import { z } from "zod";

import { ApiError } from "../http/apiError.js";

import type { AppConfig } from "../config.js";
import type { ConnectorProvider, ConnectorTokens } from "./types.js";

const AUTHORIZATION_URL = "https://api.notion.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const REVOKE_URL = "https://api.notion.com/v1/oauth/revoke";
const NOTION_VERSION = "2026-03-11";

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullable(),
  bot_id: z.string().min(1),
  workspace_id: z.string().min(1),
  workspace_name: z.string().nullable(),
  workspace_icon: z.string().nullable(),
  owner: z
    .object({
      user: z
        .object({
          name: z.string().nullable().optional(),
          avatar_url: z.string().nullable().optional(),
          person: z.object({ email: z.string().email().optional() }).optional(),
        })
        .optional(),
    })
    .passthrough(),
});

export class NotionProvider implements ConnectorProvider {
  readonly supportsPkce = false;
  readonly summary = {
    id: "notion",
    name: "Notion",
    capabilities: ["notion"],
    executionMode: "provider_api",
    availability: "stable",
  } as const;

  constructor(
    private readonly config: NonNullable<
      NonNullable<AppConfig["connectors"]>["notion"]
    >,
    private readonly httpTimeoutMs: number,
  ) {}

  getAuthorizationUrl(state: string) {
    const parameters = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      owner: "user",
      state,
    });
    return `${AUTHORIZATION_URL}?${parameters}`;
  }

  async exchangeAuthorizationCode(code: string) {
    const response = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
    });
    const owner = response.owner.user;
    return {
      account: {
        id: response.bot_id,
        name: response.workspace_name || owner?.name || "Notion workspace",
        email: owner?.person?.email || null,
        avatarUrl: response.workspace_icon || owner?.avatar_url || null,
      },
      tokens: this.toTokens(response),
      capabilities: ["notion"] as const,
    };
  }

  async refresh(tokens: ConnectorTokens) {
    if (!tokens.refreshToken) {
      throw new ApiError(
        401,
        "connector_reauthorization_required",
        "Notion must be connected again.",
      );
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
      headers: this.headers(),
      body: JSON.stringify({ token: tokens.accessToken }),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!response.ok) {
      throw new ApiError(
        502,
        "connector_revoke_failed",
        "Notion access could not be revoked.",
      );
    }
  }

  private async tokenRequest(body: Record<string, string>) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!response.ok) {
      throw new ApiError(
        502,
        "connector_oauth_failed",
        "Notion authorization failed.",
      );
    }
    const result = tokenResponse.safeParse(await response.json());
    if (!result.success) {
      throw new ApiError(
        502,
        "connector_oauth_invalid_response",
        "Notion returned an invalid authorization response.",
      );
    }
    return result.data;
  }

  private headers() {
    return {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(
        `${this.config.clientId}:${this.config.clientSecret}`,
      ).toString("base64")}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    };
  }

  private toTokens(response: z.infer<typeof tokenResponse>): ConnectorTokens {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: null,
      scopes: [],
    };
  }
}
