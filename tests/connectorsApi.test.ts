import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { ConnectorCrypto } from "../src/connectors/crypto.js";

import type { TokenVerifier } from "../src/auth/types.js";
import type { AppConfig } from "../src/config.js";
import type {
  ConnectorProviderId,
  ConnectorService,
} from "../src/connectors/types.js";
import type { JiraService } from "../src/jira/types.js";
import type { WorkspaceService } from "../src/workspace/types.js";

const config: AppConfig = {
  env: "test",
  host: "127.0.0.1",
  port: 3004,
  allowedOrigins: new Set(["http://localhost:3001"]),
  sceneSizeLimitBytes: 1024 * 1024,
  firebaseProjectId: "test",
  r2: {
    endpointUrl: "https://example.com",
    bucketName: "test",
    region: "auto",
    keyPrefix: "workspace/",
    accessKeyId: "test",
    secretAccessKey: "test",
    encryptionKey: Buffer.alloc(32, 1),
  },
  kanban: {
    encryptionKey: Buffer.alloc(32, 2),
    encryptionKeys: new Map([[1, Buffer.alloc(32, 2)]]),
    encryptionKeyVersion: 1,
    emailDigestKey: Buffer.alloc(32, 3),
    sseHeartbeatMs: 45_000,
    eventRetentionMs: 1,
    operationRetentionMs: 1,
    invitesPerHour: 20,
    recentAuthMs: 300_000,
  },
  jira: {
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://127.0.0.1:3004/v1/jira/oauth/callback",
    successUrl: "http://localhost:3001/jira-oauth-complete.html",
    encryptionKeys: new Map([[1, Buffer.alloc(32, 4)]]),
    encryptionKeyVersion: 1,
    stateTtlMs: 600_000,
    httpTimeoutMs: 15_000,
  },
  connectors: {
    googleWorkspace: {
      clientId: "client",
      clientSecret: "secret",
      redirectUri:
        "http://127.0.0.1:3004/v1/connectors/google-workspace/oauth/callback",
    },
    successUrl: "http://localhost:3001/connectors-oauth-complete.html",
    encryptionKeys: new Map([[1, Buffer.alloc(32, 4)]]),
    encryptionKeyVersion: 1,
    stateTtlMs: 600_000,
    httpTimeoutMs: 15_000,
    aiGrantTtlMs: 120_000,
    aiMaxOutputBytes: 256 * 1024,
  },
};

const verifier: TokenVerifier = {
  verify: (token) =>
    token === "valid"
      ? Promise.resolve({
          id: "user-1",
          email: "user@example.com",
          emailVerified: true,
          name: "User",
          picture: null,
        })
      : Promise.reject(new Error("invalid")),
};

const workspaceService: WorkspaceService = {
  getWorkspace: () => Promise.resolve({ projects: [], canvases: [] }),
  getCanvasScene: () => Promise.resolve({}),
  putProject: (_userId, value) => Promise.resolve({ ...value, version: 1 }),
  deleteProject: () => Promise.resolve({ deletedCanvasIds: [] }),
  putCanvas: (_userId, value) =>
    Promise.resolve({
      ...value,
      version: 1,
      contentHash: "a".repeat(64),
    }),
  patchCanvas: (_userId, value) =>
    Promise.resolve({
      ...value,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      contentHash: "a".repeat(64),
    }),
  deleteCanvas: () => Promise.resolve(),
};

const jiraService: JiraService = {
  getAuthorizationUrl: () =>
    Promise.resolve({
      authorizationUrl: "https://auth.atlassian.test",
      attemptId: "jira-attempt-1",
    }),
  completeAuthorization: () => Promise.resolve(),
  failAuthorization: () => Promise.resolve(),
  getAuthorizationStatus: () => Promise.resolve({ status: "pending" }),
  listConnections: () => Promise.resolve([]),
  deleteConnection: () => Promise.resolve(),
  request: <T>() => Promise.resolve({} as T),
};

const provider = {
  id: "google-workspace" as const,
  name: "Google Workspace",
  capabilities: ["mail", "calendar", "drive"] as const,
  executionMode: "provider_api" as const,
  availability: "stable" as const,
  configured: true,
};

const createService = () => {
  const getOverview = vi.fn().mockResolvedValue({
    providers: [provider],
    connections: [],
  });
  const getAuthorizationUrl = vi.fn().mockResolvedValue({
    authorizationUrl: "https://accounts.google.test/oauth",
    attemptId: "attempt-1",
  });
  const completeAuthorization = vi.fn().mockResolvedValue(undefined);
  const completeInstallation = vi.fn().mockResolvedValue(undefined);
  const failAuthorization = vi.fn().mockResolvedValue(undefined);
  const getAuthorizationStatus = vi
    .fn()
    .mockResolvedValue({ status: "pending" as const });
  const deleteConnection = vi.fn().mockResolvedValue(undefined);
  const getAuthorizedCredential = vi.fn();
  const createAiGrant = vi.fn().mockResolvedValue({
    grant: "signed-grant",
    expiresAt: 123,
    connectionId: "connection-1",
    capabilities: ["mail"],
  });
  const executeAiRequest = vi.fn().mockResolvedValue({
    operation: "search",
    capability: "mail",
    items: [],
    nextCursor: null,
  });
  const service: ConnectorService = {
    getOverview,
    getAuthorizationUrl,
    completeAuthorization,
    completeInstallation,
    failAuthorization,
    getAuthorizationStatus,
    deleteConnection,
    getAuthorizedCredential,
    createAiGrant,
    executeAiRequest,
  };
  return {
    service,
    getOverview,
    getAuthorizationUrl,
    completeAuthorization,
    completeInstallation,
    getAuthorizationStatus,
    deleteConnection,
    createAiGrant,
    executeAiRequest,
  };
};

const appFor = (connectorService: ConnectorService) =>
  createApp({
    config,
    tokenVerifier: verifier,
    workspaceService,
    jiraService,
    connectorService,
  });

describe("Connectors API", () => {
  it("requires authentication for connector management", async () => {
    const app = appFor(createService().service);

    expect((await request(app).get("/v1/connectors")).status).toBe(401);
    expect(
      (await request(app).post("/v1/connectors/google-workspace/oauth/start"))
        .status,
    ).toBe(401);
    expect(
      (await request(app).delete("/v1/connectors/connections/connection-1"))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/v1/connectors/ai/grants")
          .send({
            sessionId: "session-1",
            turnId: "turn-1",
            connectionId: "connection-1",
            capabilities: ["mail"],
          })
      ).status,
    ).toBe(401);
  });

  it("returns the authenticated user's connector overview", async () => {
    const { service, getOverview } = createService();
    const response = await request(appFor(service))
      .get("/v1/connectors")
      .set("authorization", "Bearer valid");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ providers: [provider], connections: [] });
    expect(getOverview).toHaveBeenCalledWith("user-1");
  });

  it("starts OAuth for a supported provider", async () => {
    const { service, getAuthorizationUrl } = createService();
    const response = await request(appFor(service))
      .post("/v1/connectors/google-workspace/oauth/start")
      .set("authorization", "Bearer valid");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      authorizationUrl: "https://accounts.google.test/oauth",
      attemptId: "attempt-1",
    });
    expect(getAuthorizationUrl).toHaveBeenCalledWith(
      "user-1",
      "google-workspace",
    );
  });

  it("completes the public OAuth callback without exposing tokens", async () => {
    const { service, completeAuthorization } = createService();
    const response = await request(appFor(service)).get(
      "/v1/connectors/google-workspace/oauth/callback?code=code&state=state",
    );

    expect(response.status).toBe(303);
    expect(response.headers["cross-origin-opener-policy"]).toBe("unsafe-none");
    expect(response.headers.location).toBe(
      "http://localhost:3001/connectors-oauth-complete.html?connector=connected&provider=google-workspace",
    );
    expect(completeAuthorization).toHaveBeenCalledWith(
      "google-workspace",
      "code",
      "state",
    );
  });

  it("completes a public provider installation callback", async () => {
    const { service, completeInstallation } = createService();
    const response = await request(appFor(service)).get(
      "/v1/connectors/github/install/callback?installation_id=42&setup_action=install&state=state",
    );

    expect(response.status).toBe(303);
    expect(response.headers["cross-origin-opener-policy"]).toBe("unsafe-none");
    expect(response.headers.location).toBe(
      "http://localhost:3001/connectors-oauth-complete.html?connector=connected&provider=github",
    );
    expect(completeInstallation).toHaveBeenCalledWith("github", 42, "state");
  });

  it("returns OAuth attempt status only in authenticated user context", async () => {
    const { service, getAuthorizationStatus } = createService();
    const response = await request(appFor(service))
      .get("/v1/connectors/oauth/attempts/attempt-1")
      .set("authorization", "Bearer valid");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "pending" });
    expect(getAuthorizationStatus).toHaveBeenCalledWith("user-1", "attempt-1");
  });

  it("deletes only the authenticated user's selected connection", async () => {
    const { service, deleteConnection } = createService();
    const response = await request(appFor(service))
      .delete("/v1/connectors/connections/connection-1")
      .set("authorization", "Bearer valid");

    expect(response.status).toBe(204);
    expect(deleteConnection).toHaveBeenCalledWith("user-1", "connection-1");
  });

  it("issues an exact authenticated connector grant without exposing credentials", async () => {
    const { service, createAiGrant } = createService();
    const body = {
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      capabilities: ["mail"],
    };
    const response = await request(appFor(service))
      .post("/v1/connectors/ai/grants")
      .set("authorization", "Bearer valid")
      .send(body);

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      grant: "signed-grant",
      expiresAt: 123,
      connectionId: "connection-1",
      capabilities: ["mail"],
    });
    expect(createAiGrant).toHaveBeenCalledWith("user-1", body);
    expect(JSON.stringify(response.body)).not.toContain("accessToken");
  });

  it("executes with a signed grant instead of a Firebase identity token", async () => {
    const { service, executeAiRequest } = createService();
    const body = {
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      capability: "mail",
      operation: "search",
      query: "project update",
      limit: 5,
    };
    const grant = "g".repeat(32);
    const response = await request(appFor(service))
      .post("/v1/connectors/ai/execute")
      .set("authorization", `Bearer ${grant}`)
      .send(body);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      operation: "search",
      capability: "mail",
      items: [],
      nextCursor: null,
    });
    expect(executeAiRequest).toHaveBeenCalledWith(grant, body);
  });

  it("strictly validates grant execution input", async () => {
    const { service, executeAiRequest } = createService();
    const response = await request(appFor(service))
      .post("/v1/connectors/ai/execute")
      .set("authorization", `Bearer ${"g".repeat(32)}`)
      .send({
        sessionId: "session-1",
        turnId: "turn-1",
        connectionId: "connection-1",
        capability: "mail",
        operation: "search",
        query: "project update",
        unexpected: true,
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(executeAiRequest).not.toHaveBeenCalled();
  });

  it("rejects connector execution without a signed grant", async () => {
    const { service, executeAiRequest } = createService();
    const response = await request(appFor(service))
      .post("/v1/connectors/ai/execute")
      .send({});

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: { code: "connector_ai_grant_required" },
    });
    expect(executeAiRequest).not.toHaveBeenCalled();
  });

  it("treats malformed connector grants as authentication failures", async () => {
    const { service, executeAiRequest } = createService();
    const response = await request(appFor(service))
      .post("/v1/connectors/ai/execute")
      .set("authorization", "Bearer malformed")
      .send({});

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: { code: "connector_ai_grant_invalid" },
    });
    expect(executeAiRequest).not.toHaveBeenCalled();
  });
});

describe("ConnectorCrypto", () => {
  it("binds encrypted tokens to provider, user, and connection AAD", () => {
    const crypto = new ConnectorCrypto(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    const tokens = {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 123,
      scopes: ["scope"],
    };
    const encrypted = crypto.encrypt(
      "google-workspace",
      "user-1",
      "connection-1",
      tokens,
    );

    expect(encrypted.ciphertext).not.toContain("access");
    expect(
      crypto.decrypt("google-workspace", "user-1", "connection-1", encrypted),
    ).toEqual(tokens);
    expect(() =>
      crypto.decrypt("google-workspace", "user-2", "connection-1", encrypted),
    ).toThrow();
    expect(() =>
      crypto.decrypt("google-workspace", "user-1", "connection-2", encrypted),
    ).toThrow();
    expect(() =>
      crypto.decrypt(
        "github" as ConnectorProviderId,
        "user-1",
        "connection-1",
        encrypted,
      ),
    ).toThrow();
  });
});
