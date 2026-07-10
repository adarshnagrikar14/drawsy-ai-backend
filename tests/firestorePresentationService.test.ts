import { describe, expect, it, vi } from "vitest";

import { hashScene } from "../src/workspace/sceneCodec.js";

const { getFirestore } = vi.hoisted(() => ({
  getFirestore: vi.fn(),
}));

vi.mock("firebase-admin/firestore", () => ({ getFirestore }));

import { FirestorePresentationService } from "../src/presentations/firestorePresentationService.js";

import type { SceneStorage } from "../src/workspace/r2SceneStorage.js";

const createSnapshot = (id: string, data?: Record<string, unknown>) => ({
  id,
  exists: !!data,
  data: () => data,
});

const createSceneStorage = () => {
  const createObjectKey = vi.fn(() => "next-object");
  const put = vi.fn(() => Promise.resolve());
  const get = vi.fn(() => Promise.resolve({}));
  const deleteObject = vi.fn(() => Promise.resolve());
  return {
    createObjectKey,
    put,
    get,
    delete: deleteObject,
  } satisfies SceneStorage;
};

const presentationData = (scene: unknown) => ({
  title: "Presentation",
  version: 3,
  createdAt: 1,
  updatedAt: 2,
  lastOpenedAt: 2,
  contentHash: hashScene(scene),
  sceneObjectKey: "current-object",
});

describe("FirestorePresentationService", () => {
  it("reads owned presentation metadata without creating a user write", async () => {
    const presentationsGet = vi.fn(() => Promise.resolve({ docs: [] }));
    const setUser = vi.fn();
    getFirestore.mockReturnValue({
      collection: () => ({
        doc: () => ({
          set: setUser,
          collection: () => ({ get: presentationsGet }),
        }),
      }),
    });
    const service = new FirestorePresentationService(
      {} as never,
      createSceneStorage(),
    );

    await expect(service.getPresentations("user-1")).resolves.toEqual({
      presentations: [],
    });
    expect(setUser).not.toHaveBeenCalled();
  });

  it("treats an identical checkpoint retry as a no-op", async () => {
    const scene = { elements: [], appState: {}, files: {} };
    const snapshot = createSnapshot("presentation-01", presentationData(scene));
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
    const storage = createSceneStorage();
    const service = new FirestorePresentationService({} as never, storage);

    const result = await service.putPresentation("user-1", {
      id: "presentation-01",
      title: "Presentation",
      baseVersion: 2,
      createdAt: 1,
      updatedAt: 2,
      lastOpenedAt: 2,
      scene,
    });

    expect(result.version).toBe(3);
    expect(storage.put).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it("stores new presentation content in the presentation namespace", async () => {
    const emptySnapshot = createSnapshot("presentation-01");
    const reference = { get: () => Promise.resolve(emptySnapshot) };
    const transaction = {
      get: vi.fn(() => Promise.resolve(emptySnapshot)),
      set: vi.fn(),
    };
    const runTransaction = vi.fn(
      (operation: (value: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    );
    getFirestore.mockReturnValue({
      collection: () => ({
        doc: () => ({
          collection: () => ({ doc: () => reference }),
        }),
      }),
      runTransaction,
    });
    const storage = createSceneStorage();
    const service = new FirestorePresentationService({} as never, storage);
    const scene = { elements: [], appState: {}, files: {} };

    const result = await service.putPresentation("user-1", {
      id: "presentation-01",
      title: "Presentation",
      baseVersion: 0,
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
      scene,
    });

    expect(storage.createObjectKey).toHaveBeenCalledWith(
      "user-1",
      "presentation-01",
      "presentations",
    );
    expect(storage.put).toHaveBeenCalledWith("next-object", scene);
    expect(transaction.set).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ version: 1, contentHash: hashScene(scene) });
  });
});
