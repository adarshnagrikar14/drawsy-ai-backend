import { getFirestore } from "firebase-admin/firestore";

import { ApiError } from "../http/apiError.js";

import type { App } from "firebase-admin/app";
import type {
  PutCanvasInput,
  PutProjectInput,
  StoredCanvas,
  WorkspaceProject,
  WorkspaceService,
  WorkspaceSnapshot,
} from "./types.js";
import type { SceneStorage } from "./r2SceneStorage.js";
import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";

const toProject = (
  snapshot: DocumentSnapshot<DocumentData>,
): WorkspaceProject => {
  const data = snapshot.data();
  if (!data) {
    throw new ApiError(404, "project_not_found", "The project was not found.");
  }
  return {
    id: snapshot.id,
    title: String(data.title),
    version: Number(data.version),
    createdAt: Number(data.createdAt),
    updatedAt: Number(data.updatedAt),
    lastOpenedAt: Number(data.lastOpenedAt),
  };
};

const toStoredCanvas = (
  snapshot: DocumentSnapshot<DocumentData>,
): StoredCanvas => {
  const data = snapshot.data();
  if (!data) {
    throw new ApiError(404, "canvas_not_found", "The canvas was not found.");
  }
  return {
    id: snapshot.id,
    title: String(data.title),
    projectId: typeof data.projectId === "string" ? data.projectId : null,
    version: Number(data.version),
    createdAt: Number(data.createdAt),
    updatedAt: Number(data.updatedAt),
    lastOpenedAt: Number(data.lastOpenedAt),
    sceneObjectKey: String(data.sceneObjectKey),
  };
};

const toMetadata = ({
  sceneObjectKey: _sceneObjectKey,
  ...canvas
}: StoredCanvas) => canvas;

const assertVersion = (
  snapshot: DocumentSnapshot<DocumentData>,
  baseVersion: number,
  resource: "canvas" | "project",
) => {
  const currentVersion = snapshot.exists ? Number(snapshot.data()?.version) : 0;
  if (currentVersion !== baseVersion) {
    throw new ApiError(
      409,
      "version_conflict",
      `The ${resource} changed on another device.`,
    );
  }
};

const clampTimestamp = (timestamp: number, now: number) =>
  Math.min(timestamp, now);

export class FirestoreWorkspaceService implements WorkspaceService {
  private readonly firestore: Firestore;

  constructor(
    app: App,
    private readonly sceneStorage: SceneStorage,
  ) {
    this.firestore = getFirestore(app);
  }

  private userRef(userId: string) {
    return this.firestore.collection("users").doc(userId);
  }

  private projectRef(userId: string, projectId: string) {
    return this.userRef(userId).collection("projects").doc(projectId);
  }

  private canvasRef(userId: string, canvasId: string) {
    return this.userRef(userId).collection("canvases").doc(canvasId);
  }

  async getWorkspace(userId: string): Promise<WorkspaceSnapshot> {
    const userRef = this.userRef(userId);
    const [projects, canvases] = await Promise.all([
      userRef.collection("projects").get(),
      userRef.collection("canvases").get(),
      userRef.set({ lastSeenAt: Date.now() }, { merge: true }),
    ]);

    return {
      projects: projects.docs.map(toProject),
      canvases: canvases.docs.map((snapshot) =>
        toMetadata(toStoredCanvas(snapshot)),
      ),
    };
  }

  async getCanvasScene(userId: string, canvasId: string) {
    const snapshot = await this.canvasRef(userId, canvasId).get();
    const canvas = toStoredCanvas(snapshot);
    return this.sceneStorage.get(canvas.sceneObjectKey);
  }

  async putProject(userId: string, input: PutProjectInput) {
    const reference = this.projectRef(userId, input.id);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      assertVersion(snapshot, input.baseVersion, "project");
      const now = Date.now();
      const project: WorkspaceProject = {
        id: input.id,
        title: input.title,
        version: input.baseVersion + 1,
        createdAt: snapshot.exists
          ? Number(snapshot.data()?.createdAt)
          : clampTimestamp(input.createdAt, now),
        updatedAt: now,
        lastOpenedAt: clampTimestamp(input.lastOpenedAt, now),
      };
      transaction.set(reference, project);
      return project;
    });
  }

  async deleteProject(userId: string, projectId: string, baseVersion: number) {
    const projectReference = this.projectRef(userId, projectId);
    const canvasesQuery = this.userRef(userId)
      .collection("canvases")
      .where("projectId", "==", projectId);

    const deletedCanvases = await this.firestore.runTransaction(
      async (transaction) => {
        const [project, canvases] = await Promise.all([
          transaction.get(projectReference),
          transaction.get(canvasesQuery),
        ]);
        if (!project.exists) {
          throw new ApiError(
            404,
            "project_not_found",
            "The project was not found.",
          );
        }
        assertVersion(project, baseVersion, "project");
        transaction.delete(projectReference);
        const storedCanvases = canvases.docs.map(toStoredCanvas);
        for (const canvas of canvases.docs) {
          transaction.delete(canvas.ref);
        }
        return storedCanvases;
      },
    );

    await this.deleteSceneObjects(deletedCanvases);
    return { deletedCanvasIds: deletedCanvases.map((canvas) => canvas.id) };
  }

  async putCanvas(userId: string, input: PutCanvasInput) {
    const canvasReference = this.canvasRef(userId, input.id);
    const existingSnapshot = await canvasReference.get();
    assertVersion(existingSnapshot, input.baseVersion, "canvas");
    if (input.projectId) {
      await this.assertProjectExists(userId, input.projectId);
    }

    const previousObjectKey = existingSnapshot.exists
      ? toStoredCanvas(existingSnapshot).sceneObjectKey
      : null;
    const objectKey = this.sceneStorage.createObjectKey(userId, input.id);
    await this.sceneStorage.put(objectKey, input.scene);

    try {
      const canvas = await this.firestore.runTransaction(
        async (transaction) => {
          const [currentCanvas, project] = await this.getCanvasTransactionState(
            transaction,
            canvasReference,
            input.projectId ? this.projectRef(userId, input.projectId) : null,
          );
          assertVersion(currentCanvas, input.baseVersion, "canvas");
          if (input.projectId && !project?.exists) {
            throw new ApiError(
              404,
              "project_not_found",
              "The project was not found.",
            );
          }

          const now = Date.now();
          const storedCanvas: StoredCanvas = {
            id: input.id,
            title: input.title,
            projectId: input.projectId,
            version: input.baseVersion + 1,
            createdAt: currentCanvas.exists
              ? Number(currentCanvas.data()?.createdAt)
              : clampTimestamp(input.createdAt, now),
            updatedAt: now,
            lastOpenedAt: clampTimestamp(input.lastOpenedAt, now),
            sceneObjectKey: objectKey,
          };
          transaction.set(canvasReference, storedCanvas);
          return storedCanvas;
        },
      );

      if (previousObjectKey && previousObjectKey !== objectKey) {
        await this.sceneStorage.delete(previousObjectKey).catch((error) => {
          console.error(
            JSON.stringify({
              level: "error",
              message: "stale_scene_cleanup_failed",
              canvasId: input.id,
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
        });
      }
      return toMetadata(canvas);
    } catch (error) {
      await this.sceneStorage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async deleteCanvas(userId: string, canvasId: string, baseVersion: number) {
    const reference = this.canvasRef(userId, canvasId);
    const deleted = await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        throw new ApiError(
          404,
          "canvas_not_found",
          "The canvas was not found.",
        );
      }
      assertVersion(snapshot, baseVersion, "canvas");
      const canvas = toStoredCanvas(snapshot);
      transaction.delete(reference);
      return canvas;
    });
    await this.deleteSceneObjects([deleted]);
  }

  private async assertProjectExists(userId: string, projectId: string) {
    const project = await this.projectRef(userId, projectId).get();
    if (!project.exists) {
      throw new ApiError(
        404,
        "project_not_found",
        "The project was not found.",
      );
    }
  }

  private async getCanvasTransactionState(
    transaction: Transaction,
    canvasReference: DocumentReference<DocumentData>,
    projectReference: DocumentReference<DocumentData> | null,
  ) {
    if (!projectReference) {
      return [await transaction.get(canvasReference), null] as const;
    }
    const [canvas, project] = await Promise.all([
      transaction.get(canvasReference),
      transaction.get(projectReference),
    ]);
    return [canvas, project] as const;
  }

  private async deleteSceneObjects(canvases: StoredCanvas[]) {
    const results = await Promise.allSettled(
      canvases.map((canvas) => this.sceneStorage.delete(canvas.sceneObjectKey)),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          JSON.stringify({
            level: "error",
            message: "deleted_scene_cleanup_failed",
            canvasId: canvases[index]?.id,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : "Unknown error",
          }),
        );
      }
    });
  }
}
