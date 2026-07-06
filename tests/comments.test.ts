import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";

import type { TokenVerifier } from "../src/auth/types.js";
import type { CommentService } from "../src/comments/types.js";
import type { AppConfig } from "../src/config.js";
import type { WorkspaceService } from "../src/workspace/types.js";

const config: AppConfig = {
  env: "test",
  host: "127.0.0.1",
  port: 3004,
  allowedOrigins: new Set(["http://localhost:3001"]),
  sceneSizeLimitBytes: 20 * 1024 * 1024,
  firebaseProjectId: "drawsy-ai-test",
  r2: {
    endpointUrl: "https://example.r2.cloudflarestorage.com",
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

const workspaceService: WorkspaceService = {
  getWorkspace: () => Promise.resolve({ projects: [], canvases: [] }),
  getCanvasScene: () => Promise.resolve({}),
  putProject: (_userId, { baseVersion, ...project }) =>
    Promise.resolve({ ...project, version: baseVersion + 1 }),
  deleteProject: () => Promise.resolve({ deletedCanvasIds: [] }),
  putCanvas: (_userId, { baseVersion, scene: _scene, ...canvas }) =>
    Promise.resolve({ ...canvas, version: baseVersion + 1, contentHash: null }),
  patchCanvas: (_userId, { baseVersion, ...canvas }) =>
    Promise.resolve({
      ...canvas,
      version: baseVersion + 1,
      createdAt: 1,
      updatedAt: 1,
      contentHash: null,
    }),
  deleteCanvas: () => Promise.resolve(),
};

const verifier: TokenVerifier = {
  verify: (token) =>
    token === "valid-token"
      ? Promise.resolve({
          id: "user-private",
          email: "user@example.com",
          emailVerified: true,
          name: "Private User",
          picture: null,
        })
      : Promise.reject(new Error("Invalid token")),
};

const canvasId = "canvas-0001";
const commentId = "comment-0001";
const messageId = "message-0001";
const comment = {
  id: commentId,
  canvasId,
  x: 12,
  y: 34,
  elementId: null,
  status: "open" as const,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  messages: [
    { id: messageId, body: "Private note", createdAt: 1, updatedAt: 1 },
  ],
};

const createCommentService = () => {
  const service: CommentService = {
    list: vi.fn(() => Promise.resolve([comment])),
    create: vi.fn(() => Promise.resolve(comment)),
    delete: vi.fn(() => Promise.resolve()),
    deleteAllForCanvas: vi.fn(() => Promise.resolve()),
  };
  return service;
};

const authenticated = (call: request.Test) =>
  call.set("authorization", "Bearer valid-token");

describe("private comments API", () => {
  it("requires login before comments can be read", async () => {
    const app = createApp({
      config,
      tokenVerifier: verifier,
      workspaceService,
      commentService: createCommentService(),
    });

    const response = await request(app).get(
      `/v1/canvases/${canvasId}/comments`,
    );

    expect(response.status).toBe(401);
  });

  it("uses the logged-in user instead of accepting an owner from the browser", async () => {
    const commentService = createCommentService();
    const app = createApp({
      config,
      tokenVerifier: verifier,
      workspaceService,
      commentService,
    });

    const response = await authenticated(
      request(app).post(`/v1/canvases/${canvasId}/comments`).send({
        id: commentId,
        messageId,
        x: 12,
        y: 34,
        elementId: null,
        body: "Private note",
        ownerId: "attacker-controlled",
      }),
    );

    expect(response.status).toBe(201);
    // The service contract is intentionally method-shaped; this assertion only checks its mock call.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(commentService.create).toHaveBeenCalledWith("user-private", {
      id: commentId,
      messageId,
      canvasId,
      x: 12,
      y: 34,
      elementId: null,
      body: "Private note",
    });
  });

  it("rejects blank and oversized comment text", async () => {
    const app = createApp({
      config,
      tokenVerifier: verifier,
      workspaceService,
      commentService: createCommentService(),
    });
    const makeCall = (body: string) =>
      authenticated(
        request(app).post(`/v1/canvases/${canvasId}/comments`).send({
          id: commentId,
          messageId,
          x: 1,
          y: 2,
          elementId: null,
          body,
        }),
      );

    expect((await makeCall("   ")).status).toBe(400);
    expect((await makeCall("a".repeat(4001))).status).toBe(400);
  });
});
