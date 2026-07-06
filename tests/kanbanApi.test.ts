import request from "supertest";
import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest verifies interface mocks without invoking them. */

import { createApp } from "../src/app.js";

import type { TokenVerifier } from "../src/auth/types.js";
import type { AppConfig } from "../src/config.js";
import type { KanbanService } from "../src/kanban/types.js";
import type { WorkspaceService } from "../src/workspace/types.js";

const config: AppConfig = {
  env: "test",
  host: "127.0.0.1",
  port: 3004,
  allowedOrigins: new Set(["http://localhost:3001"]),
  sceneSizeLimitBytes: 1024 * 1024,
  firebaseProjectId: "drawsy-test",
  r2: {
    endpointUrl: "https://example.invalid",
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
    eventRetentionMs: 30 * 24 * 60 * 60 * 1000,
    operationRetentionMs: 30 * 24 * 60 * 60 * 1000,
    invitesPerHour: 20,
    recentAuthMs: 300_000,
  },
};

const tokenVerifier: TokenVerifier = {
  verify: (token) =>
    token === "valid-token"
      ? Promise.resolve({
          id: "user-0001",
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
  putProject: (_userId, input) =>
    Promise.resolve({ ...input, version: input.baseVersion + 1 }),
  deleteProject: () => Promise.resolve({ deletedCanvasIds: [] }),
  putCanvas: (_userId, input) =>
    Promise.resolve({
      ...input,
      version: input.baseVersion + 1,
      contentHash: null,
    }),
  patchCanvas: (_userId, input) =>
    Promise.resolve({
      ...input,
      version: input.baseVersion + 1,
      createdAt: 1,
      updatedAt: 1,
      contentHash: null,
    }),
  deleteCanvas: () => Promise.resolve(),
};

const createKanbanService = (): KanbanService => ({
  listBoards: vi.fn(() => Promise.resolve([])),
  createBoard: vi.fn(() => Promise.reject(new Error("unused"))),
  getSnapshot: vi.fn(() => Promise.reject(new Error("unused"))),
  getChanges: vi.fn(() => Promise.resolve({ changes: [], latestRevision: 0 })),
  applyCommands: vi.fn(() => Promise.resolve([])),
  listMembers: vi.fn(() => Promise.resolve([])),
  updateMemberRole: vi.fn(() => Promise.reject(new Error("unused"))),
  removeMember: vi.fn(() => Promise.resolve()),
  transferOwnership: vi.fn(() => Promise.reject(new Error("unused"))),
  createInvitation: vi.fn(() => Promise.reject(new Error("unused"))),
  inspectInvitation: vi.fn(() =>
    Promise.resolve({
      boardTitle: "Roadmap",
      role: "viewer" as const,
      expiresAt: 100,
    }),
  ),
  acceptInvitation: vi.fn(() => Promise.reject(new Error("unused"))),
  revokeInvitation: vi.fn(() => Promise.resolve()),
  getRealtimeState: vi.fn(() =>
    Promise.resolve({
      latestRevision: 1,
      member: {
        userId: "user-0001",
        role: "owner" as const,
        membershipVersion: 1,
        invitedBy: null,
        joinedAt: 1,
        updatedAt: 1,
      },
    }),
  ),
  subscribeToRealtime: vi.fn(() => () => undefined),
});

const createTestApp = (kanbanService: KanbanService) =>
  createApp({ config, tokenVerifier, workspaceService, kanbanService });

describe("Kanban API", () => {
  it("keeps board listing authenticated and scopes it to verified user", async () => {
    const service = createKanbanService();
    const unauthenticated = await request(createTestApp(service)).get(
      "/v1/kanban/boards",
    );
    expect(unauthenticated.status).toBe(401);

    const authenticated = await request(createTestApp(service))
      .get("/v1/kanban/boards")
      .set("authorization", "Bearer valid-token");
    expect(authenticated.status).toBe(200);
    expect(service.listBoards).toHaveBeenCalledWith("user-0001");
  });

  it("validates bounded strict command batches before calling the service", async () => {
    const service = createKanbanService();
    const response = await request(createTestApp(service))
      .post("/v1/kanban/boards/board-0001/commands")
      .set("authorization", "Bearer valid-token")
      .send({
        clientId: "client-0001",
        commands: [
          {
            operationId: "operation-0001",
            clientSequence: 1,
            knownBoardRevision: 0,
            type: "updateBoard",
            payload: { title: "Roadmap", unexpected: true },
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(service.applyCommands).not.toHaveBeenCalled();
  });

  it("allows token inspection without exposing a board API", async () => {
    const service = createKanbanService();
    const response = await request(createTestApp(service))
      .post("/v1/kanban/invitations/inspect")
      .send({ token: "x".repeat(43) });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      boardTitle: "Roadmap",
      role: "viewer",
      expiresAt: 100,
    });
    expect(service.inspectInvitation).toHaveBeenCalledWith("x".repeat(43));
  });

  it("passes the verified identity into invitation acceptance", async () => {
    const service = createKanbanService();
    vi.mocked(service.acceptInvitation).mockResolvedValue({
      id: "board-0001",
      title: "Roadmap",
      role: "viewer",
      revision: 2,
      status: "active",
      updatedAt: 2,
    });
    const response = await request(createTestApp(service))
      .post("/v1/kanban/invitations/accept")
      .set("authorization", "Bearer valid-token")
      .send({ token: "y".repeat(43) });

    expect(response.status).toBe(200);
    expect(service.acceptInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "user-0001",
        email: "user@example.com",
        emailVerified: true,
      }),
      "y".repeat(43),
    );
  });

  it("requires recent authentication before ownership transfer", async () => {
    const service = createKanbanService();
    const response = await request(createTestApp(service))
      .post("/v1/kanban/boards/board-0001/ownership-transfer")
      .set("authorization", "Bearer valid-token")
      .send({ targetUserId: "user-0002" });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: { code: "recent_authentication_required" },
    });
    expect(service.transferOwnership).not.toHaveBeenCalled();
  });
});
