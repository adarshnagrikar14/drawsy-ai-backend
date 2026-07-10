import { getFirestore } from "firebase-admin/firestore";

import { ApiError } from "../http/apiError.js";
import { hashScene } from "../workspace/sceneCodec.js";

import type { SceneStorage } from "../workspace/r2SceneStorage.js";
import type {
  PatchPresentationInput,
  PresentationMetadata,
  PresentationService,
  PutPresentationInput,
  StoredPresentation,
} from "./types.js";
import type { App } from "firebase-admin/app";
import type {
  DocumentData,
  DocumentSnapshot,
  Firestore,
} from "firebase-admin/firestore";

const toStoredPresentation = (
  snapshot: DocumentSnapshot<DocumentData>,
): StoredPresentation => {
  const data = snapshot.data();
  if (!data) {
    throw new ApiError(
      404,
      "presentation_not_found",
      "The presentation was not found.",
    );
  }
  return {
    id: snapshot.id,
    title: String(data.title),
    version: Number(data.version),
    createdAt: Number(data.createdAt),
    updatedAt: Number(data.updatedAt),
    lastOpenedAt: Number(data.lastOpenedAt),
    contentHash: typeof data.contentHash === "string" ? data.contentHash : null,
    sceneObjectKey: String(data.sceneObjectKey),
  };
};

const toMetadata = ({
  sceneObjectKey: _sceneObjectKey,
  ...presentation
}: StoredPresentation): PresentationMetadata => presentation;

const assertVersion = (
  snapshot: DocumentSnapshot<DocumentData>,
  baseVersion: number,
) => {
  const currentVersion = snapshot.exists ? Number(snapshot.data()?.version) : 0;
  if (currentVersion !== baseVersion) {
    throw new ApiError(
      409,
      "version_conflict",
      "The presentation changed on another device.",
    );
  }
};

const clampTimestamp = (timestamp: number, now: number) =>
  Math.min(timestamp, now);

export class FirestorePresentationService implements PresentationService {
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

  private presentationRef(userId: string, presentationId: string) {
    return this.userRef(userId).collection("presentations").doc(presentationId);
  }

  async getPresentations(userId: string) {
    const snapshot = await this.userRef(userId)
      .collection("presentations")
      .get();
    return {
      presentations: snapshot.docs.map((document) =>
        toMetadata(toStoredPresentation(document)),
      ),
    };
  }

  async getPresentationScene(userId: string, presentationId: string) {
    const snapshot = await this.presentationRef(userId, presentationId).get();
    return this.sceneStorage.get(toStoredPresentation(snapshot).sceneObjectKey);
  }

  async putPresentation(userId: string, input: PutPresentationInput) {
    const reference = this.presentationRef(userId, input.id);
    const existingSnapshot = await reference.get();
    const existing = existingSnapshot.exists
      ? toStoredPresentation(existingSnapshot)
      : null;
    const contentHash = hashScene(input.scene);

    if (
      existing?.contentHash === contentHash &&
      existing.title === input.title &&
      existing.lastOpenedAt >= input.lastOpenedAt
    ) {
      return toMetadata(existing);
    }
    assertVersion(existingSnapshot, input.baseVersion);
    if (existing?.contentHash === contentHash) {
      return this.patchPresentation(userId, {
        id: input.id,
        title: input.title,
        baseVersion: input.baseVersion,
        lastOpenedAt: input.lastOpenedAt,
      });
    }

    const previousObjectKey = existing?.sceneObjectKey || null;
    const objectKey = this.sceneStorage.createObjectKey(
      userId,
      input.id,
      "presentations",
    );
    await this.sceneStorage.put(objectKey, input.scene);

    try {
      const presentation = await this.firestore.runTransaction(
        async (transaction) => {
          const currentSnapshot = await transaction.get(reference);
          assertVersion(currentSnapshot, input.baseVersion);
          const now = Date.now();
          const stored: StoredPresentation = {
            id: input.id,
            title: input.title,
            version: input.baseVersion + 1,
            createdAt: currentSnapshot.exists
              ? Number(currentSnapshot.data()?.createdAt)
              : clampTimestamp(input.createdAt, now),
            updatedAt: now,
            lastOpenedAt: clampTimestamp(input.lastOpenedAt, now),
            contentHash,
            sceneObjectKey: objectKey,
          };
          transaction.set(reference, stored);
          return stored;
        },
      );

      if (previousObjectKey && previousObjectKey !== objectKey) {
        await this.sceneStorage.delete(previousObjectKey).catch((error) => {
          console.error(
            JSON.stringify({
              level: "error",
              message: "stale_presentation_scene_cleanup_failed",
              presentationId: input.id,
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
        });
      }
      return toMetadata(presentation);
    } catch (error) {
      await this.sceneStorage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async patchPresentation(userId: string, input: PatchPresentationInput) {
    const reference = this.presentationRef(userId, input.id);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        throw new ApiError(
          404,
          "presentation_not_found",
          "The presentation was not found.",
        );
      }
      const current = toStoredPresentation(snapshot);
      const now = Date.now();
      const lastOpenedAt = clampTimestamp(input.lastOpenedAt, now);
      const metadataMatches = current.title === input.title;

      if (current.version !== input.baseVersion && !metadataMatches) {
        assertVersion(snapshot, input.baseVersion);
      }
      if (metadataMatches && current.lastOpenedAt >= lastOpenedAt) {
        return toMetadata(current);
      }

      const next: StoredPresentation = {
        ...current,
        title: input.title,
        version: current.version + 1,
        updatedAt: now,
        lastOpenedAt: Math.max(current.lastOpenedAt, lastOpenedAt),
      };
      transaction.set(reference, next);
      return toMetadata(next);
    });
  }

  async deletePresentation(
    userId: string,
    presentationId: string,
    baseVersion: number,
  ) {
    const reference = this.presentationRef(userId, presentationId);
    const deleted = await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        throw new ApiError(
          404,
          "presentation_not_found",
          "The presentation was not found.",
        );
      }
      assertVersion(snapshot, baseVersion);
      const presentation = toStoredPresentation(snapshot);
      transaction.delete(reference);
      return presentation;
    });
    await this.sceneStorage.delete(deleted.sceneObjectKey).catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          message: "deleted_presentation_scene_cleanup_failed",
          presentationId,
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    });
  }
}
