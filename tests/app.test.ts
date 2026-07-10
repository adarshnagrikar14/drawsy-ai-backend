import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { ApiError } from "../src/http/apiError.js";

import type { AppConfig } from "../src/config.js";
import type { TokenVerifier } from "../src/auth/types.js";
import type { WorkspaceService } from "../src/workspace/types.js";
import type { PresentationService } from "../src/presentations/types.js";

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
    Promise.resolve({
      ...canvas,
      version: baseVersion + 1,
      contentHash: "a".repeat(64),
    }),
  patchCanvas: (_userId, { baseVersion, ...canvas }) =>
    Promise.resolve({
      ...canvas,
      version: baseVersion + 1,
      createdAt: 1,
      updatedAt: 1,
      contentHash: "a".repeat(64),
    }),
  deleteCanvas: () => Promise.resolve(),
};

const presentationService: PresentationService = {
  getPresentations: () => Promise.resolve({ presentations: [] }),
  getPresentationScene: () => Promise.resolve({}),
  putPresentation: (_userId, { baseVersion, scene: _scene, ...presentation }) =>
    Promise.resolve({
      ...presentation,
      version: baseVersion + 1,
      contentHash: "b".repeat(64),
    }),
  patchPresentation: (_userId, { baseVersion, ...presentation }) =>
    Promise.resolve({
      ...presentation,
      version: baseVersion + 1,
      createdAt: 1,
      updatedAt: 1,
      contentHash: "b".repeat(64),
    }),
  deletePresentation: () => Promise.resolve(),
};

const createVerifier = () => {
  const verify = vi.fn((token: string) => {
    if (token !== "valid-token") {
      return Promise.reject(new Error("Invalid token"));
    }

    return Promise.resolve({
      id: "user-1",
      email: "user@example.com",
      emailVerified: true,
      name: "Drawsy User",
      picture: null,
    });
  });

  return {
    verifier: { verify } satisfies TokenVerifier,
    verify,
  };
};

const createTestApp = (tokenVerifier: TokenVerifier) =>
  createApp({
    config,
    tokenVerifier,
    workspaceService,
    presentationService,
  });

describe("Drawsy backend API", () => {
  it("reports service health without authentication", async () => {
    const { verifier } = createVerifier();
    const response = await request(createTestApp(verifier)).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "drawsy-ai-backend",
    });
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it.each([undefined, "Basic credentials", "Bearer", "Bearer token extra"])(
    "rejects a missing or malformed authorization header: %s",
    async (authorization) => {
      const { verifier } = createVerifier();
      const call = request(createTestApp(verifier)).get("/v1/me");
      if (authorization) {
        call.set("authorization", authorization);
      }

      const response = await call;

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: { code: "authentication_required" },
        requestId: response.get("x-request-id"),
      });
    },
  );

  it("rejects an invalid or expired token without leaking verifier details", async () => {
    const { verifier } = createVerifier();
    const response = await request(createTestApp(verifier))
      .get("/v1/me")
      .set("authorization", "Bearer invalid-token");

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: {
        code: "invalid_token",
        message: "The authentication token is invalid or expired.",
      },
    });
    expect(response.text).not.toContain("Invalid token");
  });

  it("returns the verified user for a valid Firebase ID token", async () => {
    const { verifier, verify } = createVerifier();
    const response = await request(createTestApp(verifier))
      .get("/v1/me")
      .set("authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      user: {
        id: "user-1",
        email: "user@example.com",
        emailVerified: true,
        name: "Drawsy User",
        picture: null,
      },
    });
    expect(verify).toHaveBeenCalledWith("valid-token");
  });

  it("allows configured browser origins and omits CORS for unknown origins", async () => {
    const { verifier } = createVerifier();
    const app = createTestApp(verifier);
    const allowed = await request(app)
      .get("/health")
      .set("origin", "http://localhost:3001");
    const unknown = await request(app)
      .get("/health")
      .set("origin", "https://unknown.example");

    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3001",
    );
    expect(unknown.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns a stable not-found error", async () => {
    const { verifier } = createVerifier();
    const response = await request(createTestApp(verifier)).get("/missing");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: { code: "not_found" },
      requestId: response.get("x-request-id"),
    });
  });

  it("reports malformed JSON as a client error with a request ID", async () => {
    const { verifier } = createVerifier();
    const response = await request(createTestApp(verifier))
      .post("/missing")
      .set("content-type", "application/json")
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "invalid_json" },
      requestId: response.get("x-request-id"),
    });
  });

  it("reports oversized request bodies without exposing parser details", async () => {
    const { verifier } = createVerifier();
    const smallConfig = { ...config, sceneSizeLimitBytes: 64 };
    const response = await request(
      createApp({
        config: smallConfig,
        tokenVerifier: verifier,
        workspaceService,
      }),
    )
      .put("/v1/canvases/canvas-01")
      .set("authorization", "Bearer valid-token")
      .send({ scene: "x".repeat(128) });

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      error: { code: "scene_too_large" },
      requestId: response.get("x-request-id"),
    });
  });

  it("returns the authenticated user's workspace", async () => {
    const { verifier } = createVerifier();
    const getWorkspace = vi.fn(() =>
      Promise.resolve({ projects: [], canvases: [] }),
    );
    const service = { ...workspaceService, getWorkspace };
    const response = await request(
      createApp({ config, tokenVerifier: verifier, workspaceService: service }),
    )
      .get("/v1/workspace")
      .set("authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ projects: [], canvases: [] });
    expect(getWorkspace).toHaveBeenCalledWith("user-1");
  });

  it("validates and saves a canvas with an optimistic base version", async () => {
    const { verifier } = createVerifier();
    const putCanvas = vi.fn<WorkspaceService["putCanvas"]>((...arguments_) =>
      workspaceService.putCanvas(...arguments_),
    );
    const service = { ...workspaceService, putCanvas };
    const payload = {
      id: "canvas-01",
      title: "Architecture",
      projectId: null,
      baseVersion: 0,
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
      scene: { elements: [], appState: {}, files: {} },
    };
    const response = await request(
      createApp({ config, tokenVerifier: verifier, workspaceService: service }),
    )
      .put("/v1/canvases/canvas-01")
      .set("authorization", "Bearer valid-token")
      .send(payload);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      canvas: {
        id: "canvas-01",
        version: 1,
      },
    });
    expect(putCanvas).toHaveBeenCalledWith("user-1", payload);
  });

  it("updates canvas metadata without requiring scene content", async () => {
    const { verifier } = createVerifier();
    const patchCanvas = vi.fn<WorkspaceService["patchCanvas"]>(
      (...arguments_) => workspaceService.patchCanvas(...arguments_),
    );
    const service = { ...workspaceService, patchCanvas };
    const payload = {
      id: "canvas-01",
      title: "Architecture",
      projectId: null,
      baseVersion: 1,
      lastOpenedAt: 3,
    };

    const response = await request(
      createApp({ config, tokenVerifier: verifier, workspaceService: service }),
    )
      .patch("/v1/canvases/canvas-01")
      .set("authorization", "Bearer valid-token")
      .send(payload);

    expect(response.status).toBe(200);
    const body = response.body as { canvas: Record<string, unknown> };
    expect(body.canvas).toMatchObject({
      id: "canvas-01",
      version: 2,
      contentHash: "a".repeat(64),
    });
    expect(patchCanvas).toHaveBeenCalledWith("user-1", payload);
  });

  it("returns a stable conflict when a remote version changed", async () => {
    const { verifier } = createVerifier();
    const service: WorkspaceService = {
      ...workspaceService,
      putProject: () =>
        Promise.reject(
          new ApiError(
            409,
            "version_conflict",
            "The project changed on another device.",
          ),
        ),
    };
    const response = await request(
      createApp({ config, tokenVerifier: verifier, workspaceService: service }),
    )
      .put("/v1/projects/project-01")
      .set("authorization", "Bearer valid-token")
      .send({
        id: "project-01",
        title: "Product",
        baseVersion: 1,
        createdAt: 1,
        updatedAt: 2,
        lastOpenedAt: 2,
      });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: {
        code: "version_conflict",
        message: "The project changed on another device.",
      },
    });
  });

  it("returns only the authenticated user's presentations", async () => {
    const { verifier } = createVerifier();
    const getPresentations = vi.fn(() =>
      Promise.resolve({ presentations: [] }),
    );
    const service = { ...presentationService, getPresentations };
    const response = await request(
      createApp({
        config,
        tokenVerifier: verifier,
        workspaceService,
        presentationService: service,
      }),
    )
      .get("/v1/presentations")
      .set("authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ presentations: [] });
    expect(getPresentations).toHaveBeenCalledWith("user-1");
  });

  it("validates and saves a presentation with an optimistic base version", async () => {
    const { verifier } = createVerifier();
    const putPresentation = vi.fn<PresentationService["putPresentation"]>(
      (...arguments_) => presentationService.putPresentation(...arguments_),
    );
    const service = { ...presentationService, putPresentation };
    const payload = {
      id: "presentation-01",
      title: "Product launch",
      baseVersion: 0,
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
      scene: {
        elements: [],
        appState: {},
        files: {},
        presentation: { version: 1, builds: [], transitions: {} },
      },
    };
    const response = await request(
      createApp({
        config,
        tokenVerifier: verifier,
        workspaceService,
        presentationService: service,
      }),
    )
      .put("/v1/presentations/presentation-01")
      .set("authorization", "Bearer valid-token")
      .send(payload);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      presentation: { id: "presentation-01", version: 1 },
    });
    expect(putPresentation).toHaveBeenCalledWith("user-1", payload);
  });

  it("rejects a presentation path/body identifier mismatch", async () => {
    const { verifier } = createVerifier();
    const response = await request(createTestApp(verifier))
      .put("/v1/presentations/presentation-01")
      .set("authorization", "Bearer valid-token")
      .send({
        id: "presentation-02",
        title: "Product launch",
        baseVersion: 0,
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1,
        scene: {},
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "id_mismatch" } });
  });
});
