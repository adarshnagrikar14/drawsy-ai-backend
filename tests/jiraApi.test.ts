import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { JiraCrypto } from "../src/jira/crypto.js";

import type { TokenVerifier } from "../src/auth/types.js";
import type { AppConfig } from "../src/config.js";
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
};

const verifier: TokenVerifier = {
  verify: (token) => {
    if (token !== "valid") {
      return Promise.reject(new Error("invalid"));
    }
    return Promise.resolve({
      id: "user-1",
      email: "user@example.com",
      emailVerified: true,
      name: "User",
      picture: null,
    });
  },
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

const createService = () => {
  const getAuthorizationUrl = vi.fn().mockResolvedValue({
    authorizationUrl: "https://auth.atlassian.test",
    attemptId: "attempt-1",
  });
  const completeAuthorization = vi.fn().mockResolvedValue(undefined);
  const failAuthorization = vi.fn().mockResolvedValue(undefined);
  const getAuthorizationStatus = vi
    .fn()
    .mockResolvedValue({ status: "pending" as const });
  const requestFromJira = vi.fn().mockResolvedValue({ values: [] });
  const service: JiraService = {
    getAuthorizationUrl,
    completeAuthorization,
    failAuthorization,
    getAuthorizationStatus,
    listConnections: vi.fn().mockResolvedValue([]),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
    request: requestFromJira,
  };
  return {
    service,
    getAuthorizationUrl,
    completeAuthorization,
    getAuthorizationStatus,
    requestFromJira,
  };
};

const appFor = (jiraService: JiraService) =>
  createApp({ config, tokenVerifier: verifier, workspaceService, jiraService });

describe("Jira API", () => {
  it("starts OAuth only for an authenticated Drawsy user", async () => {
    const { service, getAuthorizationUrl } = createService();
    expect(
      (await request(appFor(service)).post("/v1/jira/oauth/start")).status,
    ).toBe(401);

    const response = await request(appFor(service))
      .post("/v1/jira/oauth/start")
      .set("authorization", "Bearer valid");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      authorizationUrl: "https://auth.atlassian.test",
      attemptId: "attempt-1",
    });
    expect(getAuthorizationUrl).toHaveBeenCalledWith("user-1");
  });

  it("reports the authenticated OAuth attempt status", async () => {
    const { service, getAuthorizationStatus } = createService();
    const response = await request(appFor(service))
      .get("/v1/jira/oauth/attempts/attempt-1")
      .set("authorization", "Bearer valid");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "pending" });
    expect(getAuthorizationStatus).toHaveBeenCalledWith("user-1", "attempt-1");
  });

  it("consumes the OAuth callback and redirects without exposing tokens", async () => {
    const { service, completeAuthorization } = createService();
    const response = await request(appFor(service)).get(
      "/v1/jira/oauth/callback?code=code&state=state",
    );

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(
      "http://localhost:3001/jira-oauth-complete.html?jira=connected",
    );
    expect(completeAuthorization).toHaveBeenCalledWith("code", "state");
  });

  it("forwards only explicit contributor resources", async () => {
    const { service, requestFromJira } = createService();
    const response = await request(appFor(service))
      .get("/v1/jira/connections/account/sites/cloud/projects")
      .set("authorization", "Bearer valid");

    expect(response.status).toBe(200);
    expect(requestFromJira).toHaveBeenCalledWith(
      "user-1",
      "account",
      "cloud",
      "/project/search?expand=description,lead,issueTypes&maxResults=100&orderBy=name",
    );
  });

  it("loads assignable contributors for the selected project", async () => {
    const { service, requestFromJira } = createService();
    const response = await request(appFor(service))
      .get(
        "/v1/jira/connections/account/sites/cloud/users/assignable?projectKey=KAN",
      )
      .set("authorization", "Bearer valid");

    expect(response.status).toBe(200);
    expect(requestFromJira).toHaveBeenCalledWith(
      "user-1",
      "account",
      "cloud",
      "/user/assignable/search?project=KAN&maxResults=100",
    );
  });

  it("starts and completes sprints through the Agile API", async () => {
    const { service, requestFromJira } = createService();
    const response = await request(appFor(service))
      .put("/v1/jira/connections/account/sites/cloud/sprints/12")
      .set("authorization", "Bearer valid")
      .send({ state: "active" });

    expect(response.status).toBe(200);
    expect(requestFromJira).toHaveBeenCalledWith(
      "user-1",
      "account",
      "cloud",
      "/sprint/12",
      { method: "PUT", body: JSON.stringify({ state: "active" }) },
      "software",
    );
  });

  it("encrypts token material with connection-bound authenticated encryption", () => {
    const crypto = new JiraCrypto(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    const payload = crypto.encrypt("user", "connection", {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 123,
      scope: "read:jira-work",
    });

    expect(payload.ciphertext).not.toContain("access");
    expect(crypto.decrypt("user", "connection", payload)).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 123,
      scope: "read:jira-work",
    });
    expect(() => crypto.decrypt("other-user", "connection", payload)).toThrow();
  });
});
