import { createSign } from "node:crypto";

import { z } from "zod";

import { ApiError } from "../http/apiError.js";

import type { AppConfig } from "../config.js";
import type {
  ConnectorAuthorizationResult,
  ConnectorProvider,
  ConnectorTokens,
} from "./types.js";

const API_URL = "https://api.github.com";
const API_VERSION = "2026-03-10";
const REQUIRED_PERMISSIONS = [
  "contents",
  "issues",
  "metadata",
  "pull_requests",
] as const;

const installationResponse = z.object({
  id: z.number().int().positive(),
  app_slug: z.string().min(1),
  html_url: z.url(),
  suspended_at: z.string().nullable(),
  repository_selection: z.enum(["all", "selected"]),
  permissions: z.record(z.string(), z.enum(["read", "write"])),
  account: z.object({
    id: z.number().int().positive(),
    login: z.string().min(1),
    avatar_url: z.url().nullable(),
  }),
});

const installationTokenResponse = z.object({
  token: z.string().min(1),
  expires_at: z.iso.datetime(),
  permissions: z.record(z.string(), z.enum(["read", "write"])),
});

export class GitHubProvider implements ConnectorProvider {
  readonly supportsPkce = false;
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

  getAuthorizationUrl(state: string) {
    const target = new URL(
      `/apps/${encodeURIComponent(this.config.appSlug)}/installations/new`,
      "https://github.com",
    );
    target.searchParams.set("state", state);
    return target.toString();
  }

  async completeInstallation(
    installationId: number,
  ): Promise<ConnectorAuthorizationResult> {
    const appToken = this.createAppToken();
    const installation = await this.requestInstallation(
      installationId,
      appToken,
    );
    this.validateInstallation(installation);
    const tokens = await this.createInstallationToken(installationId, appToken);
    return {
      account: {
        id: String(installation.account.id),
        name: installation.account.login,
        email: null,
        avatarUrl: installation.account.avatar_url,
        manageUrl: installation.html_url,
      },
      tokens,
      capabilities: ["github"],
    };
  }

  async refresh(tokens: ConnectorTokens) {
    if (!tokens.installationId) {
      throw new ApiError(
        401,
        "connector_reauthorization_required",
        "The GitHub App installation must be connected again.",
      );
    }
    return this.createInstallationToken(
      tokens.installationId,
      this.createAppToken(),
    );
  }

  async revoke(tokens: ConnectorTokens) {
    const target = tokens.installationId
      ? `${API_URL}/app/installations/${tokens.installationId}`
      : `${API_URL}/installation/token`;
    const response = await fetch(target, {
      method: "DELETE",
      headers: this.githubHeaders(
        tokens.installationId ? this.createAppToken() : tokens.accessToken,
      ),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!response.ok && response.status !== 404 && response.status !== 401) {
      throw new ApiError(
        502,
        "connector_revoke_failed",
        "GitHub access could not be revoked.",
      );
    }
  }

  private createAppToken() {
    const issuedAt = Math.floor(Date.now() / 1000) - 60;
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iat: issuedAt,
        exp: issuedAt + 9 * 60,
        iss: String(this.config.appId),
      }),
    ).toString("base64url");
    const unsignedToken = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256")
      .update(unsignedToken)
      .end()
      .sign(this.config.privateKey, "base64url");
    return `${unsignedToken}.${signature}`;
  }

  private async requestInstallation(installationId: number, appToken: string) {
    const response = await fetch(
      `${API_URL}/app/installations/${installationId}`,
      {
        headers: this.githubHeaders(appToken),
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      },
    );
    if (!response.ok) {
      throw new ApiError(
        response.status === 404 ? 400 : 502,
        "connector_installation_invalid",
        "The GitHub App installation could not be verified.",
      );
    }
    const parsed = installationResponse.safeParse(await response.json());
    if (!parsed.success) {
      throw new ApiError(
        502,
        "connector_installation_invalid_response",
        "GitHub returned invalid installation details.",
      );
    }
    return parsed.data;
  }

  private validateInstallation(
    installation: z.infer<typeof installationResponse>,
  ) {
    if (
      installation.app_slug !== this.config.appSlug ||
      installation.suspended_at !== null
    ) {
      throw new ApiError(
        400,
        "connector_installation_invalid",
        "The GitHub App installation is invalid or suspended.",
      );
    }
    if (
      REQUIRED_PERMISSIONS.some(
        (permission) => installation.permissions[permission] !== "read",
      )
    ) {
      throw new ApiError(
        409,
        "connector_installation_permissions_invalid",
        "The GitHub App must have read-only access to metadata, contents, issues, and pull requests.",
      );
    }
  }

  private async createInstallationToken(
    installationId: number,
    appToken: string,
  ): Promise<ConnectorTokens> {
    const response = await fetch(
      `${API_URL}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          ...this.githubHeaders(appToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          permissions: Object.fromEntries(
            REQUIRED_PERMISSIONS.map((permission) => [permission, "read"]),
          ),
        }),
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      },
    );
    if (!response.ok) {
      throw new ApiError(
        502,
        "connector_installation_token_failed",
        "GitHub installation access could not be created.",
      );
    }
    const parsed = installationTokenResponse.safeParse(await response.json());
    if (!parsed.success) {
      throw new ApiError(
        502,
        "connector_installation_token_invalid_response",
        "GitHub returned an invalid installation token.",
      );
    }
    return {
      accessToken: parsed.data.token,
      refreshToken: null,
      expiresAt: Date.parse(parsed.data.expires_at),
      scopes: Object.entries(parsed.data.permissions).map(
        ([permission, access]) => `${permission}:${access}`,
      ),
      installationId,
    };
  }

  private githubHeaders(token: string) {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    };
  }
}
