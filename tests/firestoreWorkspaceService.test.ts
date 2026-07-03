import { describe, expect, it, vi } from "vitest";

import { hashScene } from "../src/workspace/sceneCodec.js";

const { getFirestore } = vi.hoisted(() => ({
  getFirestore: vi.fn(),
}));

vi.mock("firebase-admin/firestore", () => ({ getFirestore }));

import { FirestoreWorkspaceService } from "../src/workspace/firestoreWorkspaceService.js";

import type { SceneStorage } from "../src/workspace/r2SceneStorage.js";

const createSnapshot = (id: string, data?: Record<string, unknown>) => ({
  id,
  exists: !!data,
  data: () => data,
});

const createSceneStorage = () => {
  const put = vi.fn(() => Promise.resolve());
  return {
    put,
    storage: {
      createObjectKey: vi.fn(() => "next-object"),
      put,
      get: vi.fn(() => Promise.resolve({})),
      delete: vi.fn(() => Promise.resolve()),
    } satisfies SceneStorage,
  };
};

const canvasData = (scene: unknown) => ({
  title: "Canvas",
  projectId: null,
  version: 3,
  createdAt: 1,
  updatedAt: 2,
  lastOpenedAt: 2,
  contentHash: hashScene(scene),
  sceneObjectKey: "current-object",
});

describe("FirestoreWorkspaceService", () => {
  it("reads workspace metadata without creating a billing write", async () => {
    const projectGet = vi.fn(() => Promise.resolve({ docs: [] }));
    const canvasGet = vi.fn(() => Promise.resolve({ docs: [] }));
    const setUser = vi.fn();
    getFirestore.mockReturnValue({
      collection: () => ({
        doc: () => ({
          set: setUser,
          collection: (name: string) => ({
            get: name === "projects" ? projectGet : canvasGet,
          }),
        }),
      }),
    });
    const { storage } = createSceneStorage();
    const service = new FirestoreWorkspaceService({} as never, storage);

    await expect(service.getWorkspace("user-1")).resolves.toEqual({
      projects: [],
      canvases: [],
    });
    expect(setUser).not.toHaveBeenCalled();
  });

  it("treats an identical checkpoint retry as a complete no-op", async () => {
    const scene = { elements: [], appState: {}, files: {} };
    const snapshot = createSnapshot("canvas-01", canvasData(scene));
    const runTransaction = vi.fn();
    getFirestore.mockReturnValue({
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({ get: () => Promise.resolve(snapshot) }),
          }),
        }),
      }),
      runTransaction,
    });
    const { put, storage } = createSceneStorage();
    const service = new FirestoreWorkspaceService({} as never, storage);

    const result = await service.putCanvas("user-1", {
      id: "canvas-01",
      title: "Canvas",
      projectId: null,
      baseVersion: 2,
      createdAt: 1,
      updatedAt: 2,
      lastOpenedAt: 2,
      scene,
    });

    expect(result.version).toBe(3);
    expect(put).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it("updates metadata without writing another scene object", async () => {
    const scene = { elements: [], appState: {}, files: {} };
    const snapshot = createSnapshot("canvas-01", canvasData(scene));
    const transaction = {
      get: vi.fn(() => Promise.resolve(snapshot)),
      set: vi.fn(),
    };
    const runTransaction = vi.fn(
      (operation: (value: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    );
    getFirestore.mockReturnValue({
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({ get: () => Promise.resolve(snapshot) }),
          }),
        }),
      }),
      runTransaction,
    });
    const { put, storage } = createSceneStorage();
    const service = new FirestoreWorkspaceService({} as never, storage);

    const result = await service.putCanvas("user-1", {
      id: "canvas-01",
      title: "Renamed",
      projectId: null,
      baseVersion: 3,
      createdAt: 1,
      updatedAt: 2,
      lastOpenedAt: 4,
      scene,
    });

    expect(result).toMatchObject({ title: "Renamed", version: 4 });
    expect(put).not.toHaveBeenCalled();
    expect(transaction.set).toHaveBeenCalledTimes(1);
  });
});
