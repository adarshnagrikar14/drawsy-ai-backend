import { afterEach, describe, expect, it, vi } from "vitest";

import { DefaultConnectorService } from "../src/connectors/connectorService.js";
import { ConnectorCrypto } from "../src/connectors/crypto.js";
import { GoogleWorkspaceProvider } from "../src/connectors/googleWorkspaceProvider.js";
import { ApiError } from "../src/http/apiError.js";

import type { AppConfig } from "../src/config.js";
import type {
  ConnectorConnectionStore,
  ConnectorProvider,
  ConnectorTokens,
  StoredConnectorConnection,
} from "../src/connectors/types.js";

const encryptionKey = Buffer.alloc(32, 8);
const config: NonNullable<AppConfig["connectors"]> = {
  successUrl: "http://localhost:3001",
  encryptionKeys: new Map([[1, encryptionKey]]),
  encryptionKeyVersion: 1,
  stateTtlMs: 600_000,
  httpTimeoutMs: 15_000,
  aiGrantTtlMs: 120_000,
  aiMaxOutputBytes: 256 * 1024,
};

const tokens = (overrides: Partial<ConnectorTokens> = {}): ConnectorTokens => ({
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 3_600_000,
  scopes: ["scope"],
  ...overrides,
});

const provider = (
  overrides: Partial<ConnectorProvider> = {},
): ConnectorProvider => ({
  supportsPkce: true,
  summary: {
    id: "google-workspace",
    name: "Google Workspace",
    capabilities: ["mail", "calendar", "drive"],
    executionMode: "provider_api",
    availability: "stable",
  },
  getAuthorizationUrl: vi.fn(() => "https://accounts.example/authorize"),
  exchangeAuthorizationCode: vi.fn().mockResolvedValue({
    account: {
      id: "account-1",
      name: "Account",
      email: "account@example.com",
      avatarUrl: null,
    },
    tokens: tokens(),
    capabilities: ["mail"],
  }),
  refresh: vi
    .fn<(value: ConnectorTokens) => Promise<ConnectorTokens>>()
    .mockImplementation((value) => Promise.resolve(value)),
  revoke: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const store = (
  overrides: Partial<ConnectorConnectionStore> = {},
): ConnectorConnectionStore => ({
  createOAuthState: vi.fn().mockResolvedValue({
    state: "state",
    attemptId: "attempt-1",
  }),
  consumeOAuthState: vi.fn().mockResolvedValue({
    userId: "user-1",
    attemptId: "attempt-1",
    codeVerifier: "verifier",
  }),
  setOAuthAttemptStatus: vi.fn().mockResolvedValue(undefined),
  getOAuthAttemptStatus: vi.fn().mockResolvedValue({ status: "pending" }),
  listConnections: vi.fn().mockResolvedValue([]),
  getConnection: vi
    .fn()
    .mockRejectedValue(
      new ApiError(404, "connector_connection_not_found", "Not found"),
    ),
  saveConnection: vi.fn().mockResolvedValue(undefined),
  deleteConnection: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const encryptedConnection = (
  value: ConnectorTokens,
  capabilities: StoredConnectorConnection["capabilities"] = ["mail"],
) => {
  const crypto = new ConnectorCrypto(new Map([[1, encryptionKey]]), 1);
  return {
    id: "connection-1",
    providerId: "google-workspace",
    accountId: "account-1",
    accountName: "Account",
    accountEmail: "account@example.com",
    accountAvatarUrl: null,
    manageUrl: null,
    capabilities,
    scopes: value.scopes,
    createdAt: 1,
    updatedAt: 1,
    tokens: crypto.encrypt("google-workspace", "user-1", "connection-1", value),
  } satisfies StoredConnectorConnection;
};

describe("DefaultConnectorService", () => {
  it("returns the complete catalog with configured provider state", async () => {
    const listConnections = vi.fn().mockResolvedValue([]);
    const connectionStore = store({ listConnections });
    const service = new DefaultConnectorService(
      config,
      [provider()],
      connectionStore,
    );

    const overview = await service.getOverview("user-1");

    expect(
      overview.providers.map(({ id, configured }) => ({ id, configured })),
    ).toEqual([
      { id: "google-workspace", configured: true },
      { id: "notion", configured: false },
      { id: "slack", configured: false },
      { id: "github", configured: false },
      { id: "read-ai", configured: false },
      { id: "fireflies", configured: false },
    ]);
    expect(listConnections).toHaveBeenCalledWith("user-1");
  });

  it("does not expose legacy GitHub OAuth connections", async () => {
    const listConnections = vi.fn().mockResolvedValue([
      {
        id: "legacy-github",
        providerId: "github",
        accountId: "account-1",
        accountName: "adarsh",
        accountEmail: null,
        accountAvatarUrl: null,
        manageUrl: null,
        capabilities: ["github"],
        scopes: ["repo"],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const service = new DefaultConnectorService(
      config,
      [provider()],
      store({ listConnections }),
    );

    expect((await service.getOverview("user-1")).connections).toEqual([]);
  });

  it("rejects OAuth start for an unconfigured catalog provider", async () => {
    const service = new DefaultConnectorService(config, [provider()], store());

    await expect(
      service.getAuthorizationUrl("user-1", "notion"),
    ).rejects.toMatchObject({
      status: 503,
      code: "connector_provider_unavailable",
    });
  });

  it("persists only capabilities and scopes actually granted", async () => {
    const grantedTokens = tokens({ scopes: ["drive.readonly"] });
    const exchangeAuthorizationCode = vi.fn().mockResolvedValue({
      account: {
        id: "account-1",
        name: "Account",
        email: "account@example.com",
        avatarUrl: null,
      },
      tokens: grantedTokens,
      capabilities: ["drive"],
    });
    const saveConnection = vi
      .fn<ConnectorConnectionStore["saveConnection"]>()
      .mockResolvedValue(undefined);
    const setOAuthAttemptStatus = vi.fn().mockResolvedValue(undefined);
    const connectionStore = store({ saveConnection, setOAuthAttemptStatus });
    const service = new DefaultConnectorService(
      config,
      [provider({ exchangeAuthorizationCode })],
      connectionStore,
    );

    await service.completeAuthorization("google-workspace", "code", "state");

    const saved = saveConnection.mock.calls[0]?.[1];
    expect(saved).toMatchObject({
      providerId: "google-workspace",
      capabilities: ["drive"],
      scopes: ["drive.readonly"],
    });
    expect(exchangeAuthorizationCode).toHaveBeenCalledWith("code", "verifier");
    expect(setOAuthAttemptStatus).toHaveBeenCalledWith("attempt-1", {
      status: "connected",
    });
  });

  it("persists a provider-managed installation", async () => {
    const completeInstallation = vi.fn().mockResolvedValue({
      account: {
        id: "account-1",
        name: "adarsh",
        email: null,
        avatarUrl: null,
        manageUrl: "https://github.com/settings/installations/42",
      },
      tokens: tokens({
        refreshToken: null,
        installationId: 42,
        scopes: ["contents:read"],
      }),
      capabilities: ["github"],
    });
    const saveConnection = vi
      .fn<ConnectorConnectionStore["saveConnection"]>()
      .mockResolvedValue(undefined);
    const connectionStore = store({ saveConnection });
    const service = new DefaultConnectorService(
      config,
      [
        provider({
          summary: {
            id: "github",
            name: "GitHub",
            capabilities: ["github"],
            executionMode: "provider_api",
            availability: "stable",
          },
          supportsPkce: false,
          exchangeAuthorizationCode: undefined,
          completeInstallation,
        }),
      ],
      connectionStore,
    );

    await service.completeInstallation("github", 42, "state");

    expect(completeInstallation).toHaveBeenCalledWith(42);
    expect(saveConnection.mock.calls[0]?.[1]).toMatchObject({
      providerId: "github",
      accountName: "adarsh",
      manageUrl: "https://github.com/settings/installations/42",
      capabilities: ["github"],
    });
  });

  it("deletes local credentials even when provider revocation fails", async () => {
    const connection = encryptedConnection(tokens());
    const deleteConnection = vi.fn().mockResolvedValue(undefined);
    const revoke = vi
      .fn()
      .mockRejectedValue(
        new ApiError(502, "connector_revoke_failed", "Revoke failed"),
      );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const service = new DefaultConnectorService(
      config,
      [provider({ revoke })],
      store({
        getConnection: vi.fn().mockResolvedValue(connection),
        deleteConnection,
      }),
    );

    await expect(
      service.deleteConnection("user-1", "connection-1"),
    ).resolves.toBeUndefined();
    expect(deleteConnection).toHaveBeenCalledWith("user-1", "connection-1");
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("enforces granted capability before releasing credentials", async () => {
    const refresh = vi.fn();
    const service = new DefaultConnectorService(
      config,
      [provider({ refresh })],
      store({
        getConnection: vi
          .fn()
          .mockResolvedValue(encryptedConnection(tokens(), ["mail"])),
      }),
    );

    await expect(
      service.getAuthorizedCredential("user-1", "connection-1", "drive"),
    ).rejects.toMatchObject({
      status: 403,
      code: "connector_capability_forbidden",
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes expiring credentials and persists the replacement", async () => {
    const current = tokens({ expiresAt: Date.now() + 30_000 });
    const refreshed = tokens({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["new-scope"],
    });
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const saveConnection = vi.fn().mockResolvedValue(undefined);
    const service = new DefaultConnectorService(
      config,
      [provider({ refresh })],
      store({
        getConnection: vi.fn().mockResolvedValue(encryptedConnection(current)),
        saveConnection,
      }),
    );

    await expect(
      service.getAuthorizedCredential("user-1", "connection-1", "mail"),
    ).resolves.toEqual({
      providerId: "google-workspace",
      accessToken: "new-access",
    });
    expect(refresh).toHaveBeenCalledWith(current);
    expect(saveConnection).toHaveBeenCalledOnce();
    expect(saveConnection.mock.calls[0]?.[1]).toMatchObject({
      scopes: ["new-scope"],
    });
  });

  it("issues AI grants only for capabilities on the authenticated user's connection", async () => {
    const service = new DefaultConnectorService(
      config,
      [provider()],
      store({
        getConnection: vi
          .fn()
          .mockResolvedValue(encryptedConnection(tokens(), ["mail"])),
      }),
    );

    await expect(
      service.createAiGrant("user-1", {
        sessionId: "session-1",
        turnId: "turn-1",
        connectionId: "connection-1",
        capabilities: ["drive"],
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "connector_capability_forbidden",
    });
  });

  it("binds AI execution to the exact session, turn, connection, and capability", async () => {
    const connectionStore = store({
      getConnection: vi
        .fn()
        .mockResolvedValue(encryptedConnection(tokens(), ["mail"])),
    });
    const service = new DefaultConnectorService(
      config,
      [provider()],
      connectionStore,
    );
    const issued = await service.createAiGrant("user-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      capabilities: ["mail"],
    });

    await expect(
      service.executeAiRequest(issued.grant, {
        sessionId: "session-1",
        turnId: "turn-2",
        connectionId: "connection-1",
        capability: "mail",
        operation: "search",
        query: "status",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "connector_ai_grant_scope_forbidden",
    });
    await expect(
      service.executeAiRequest(`${issued.grant.slice(0, -1)}x`, {
        sessionId: "session-1",
        turnId: "turn-1",
        connectionId: "connection-1",
        capability: "mail",
        operation: "search",
        query: "status",
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: "connector_ai_grant_invalid",
    });
  });

  it("executes a read-only provider request without returning provider credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = new DefaultConnectorService(
      config,
      [provider()],
      store({
        getConnection: vi
          .fn()
          .mockResolvedValue(encryptedConnection(tokens(), ["mail"])),
      }),
    );
    const issued = await service.createAiGrant("user-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      capabilities: ["mail"],
    });
    const result = await service.executeAiRequest(issued.grant, {
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      capability: "mail",
      operation: "search",
      query: "status",
    });

    expect(result).toEqual({
      operation: "search",
      capability: "mail",
      items: [],
      nextCursor: null,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBeInstanceOf(URL);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "https://gmail.googleapis.com/",
    );
    expect(JSON.stringify(result)).not.toContain("access");
    vi.unstubAllGlobals();
  });
});

describe("GoogleWorkspaceProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const googleProvider = () =>
    new GoogleWorkspaceProvider(
      {
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "http://localhost/callback",
      },
      15_000,
    );

  it("rejects malformed token responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      googleProvider().exchangeAuthorizationCode("code", "verifier"),
    ).rejects.toMatchObject({
      status: 502,
      code: "connector_oauth_invalid_response",
    });
  });

  it("derives capabilities only from the scopes Google granted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
            scope:
              "openid email https://www.googleapis.com/auth/drive.readonly",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sub: "account-1",
            name: "Account",
            email: "account@example.com",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await googleProvider().exchangeAuthorizationCode(
      "code",
      "verifier",
    );

    expect(result.capabilities).toEqual(["drive"]);
    expect(result.tokens.scopes).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/drive.readonly",
    ]);
  });
});
