import { getFirestore } from "firebase-admin/firestore";

import { ApiError } from "../http/apiError.js";

import type { App } from "firebase-admin/app";
import type {
  DocumentData,
  DocumentSnapshot,
  Firestore,
} from "firebase-admin/firestore";
import type {
  CanvasComment,
  CommentMessage,
  CommentService,
  CreateCommentInput,
} from "./types.js";

const toMessage = (data: Record<string, unknown>): CommentMessage => ({
  id: String(data.id),
  body: String(data.body),
  createdAt: Number(data.createdAt),
  updatedAt: Number(data.updatedAt),
});

const toComment = (snapshot: DocumentSnapshot<DocumentData>): CanvasComment => {
  const data = snapshot.data();
  if (!data) {
    throw new ApiError(404, "comment_not_found", "The comment was not found.");
  }
  return {
    id: snapshot.id,
    canvasId: String(data.canvasId),
    x: Number(data.x),
    y: Number(data.y),
    elementId: typeof data.elementId === "string" ? data.elementId : null,
    status: data.status === "resolved" ? "resolved" : "open",
    version: Number(data.version),
    createdAt: Number(data.createdAt),
    updatedAt: Number(data.updatedAt),
    messages: Array.isArray(data.messages)
      ? data.messages.map((message) =>
          toMessage(message as Record<string, unknown>),
        )
      : [],
  };
};

export class FirestoreCommentService implements CommentService {
  private readonly firestore: Firestore;

  constructor(app: App) {
    this.firestore = getFirestore(app);
  }

  private canvasRef(userId: string, canvasId: string) {
    return this.firestore
      .collection("users")
      .doc(userId)
      .collection("canvases")
      .doc(canvasId);
  }

  private commentRef(userId: string, canvasId: string, commentId: string) {
    return this.canvasRef(userId, canvasId)
      .collection("comments")
      .doc(commentId);
  }

  private async assertCanvasExists(userId: string, canvasId: string) {
    if (!(await this.canvasRef(userId, canvasId).get()).exists) {
      throw new ApiError(404, "canvas_not_found", "The canvas was not found.");
    }
  }

  async list(userId: string, canvasId: string) {
    await this.assertCanvasExists(userId, canvasId);
    const snapshot = await this.canvasRef(userId, canvasId)
      .collection("comments")
      .orderBy("updatedAt", "desc")
      .get();
    return snapshot.docs.map(toComment);
  }

  async create(userId: string, input: CreateCommentInput) {
    const canvasReference = this.canvasRef(userId, input.canvasId);
    const commentReference = this.commentRef(userId, input.canvasId, input.id);
    return this.firestore.runTransaction(async (transaction) => {
      const [canvas, existing] = await Promise.all([
        transaction.get(canvasReference),
        transaction.get(commentReference),
      ]);
      if (!canvas.exists) {
        throw new ApiError(
          404,
          "canvas_not_found",
          "The canvas was not found.",
        );
      }
      if (existing.exists) {
        return toComment(existing);
      }
      const now = Date.now();
      const comment: CanvasComment = {
        id: input.id,
        canvasId: input.canvasId,
        x: input.x,
        y: input.y,
        elementId: input.elementId,
        status: "open",
        version: 1,
        createdAt: now,
        updatedAt: now,
        messages: [
          {
            id: input.messageId,
            body: input.body,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      transaction.create(commentReference, comment);
      return comment;
    });
  }

  async delete(
    userId: string,
    canvasId: string,
    commentId: string,
    baseVersion: number,
  ) {
    const canvasReference = this.canvasRef(userId, canvasId);
    const reference = this.commentRef(userId, canvasId, commentId);
    await this.firestore.runTransaction(async (transaction) => {
      const [canvas, snapshot] = await Promise.all([
        transaction.get(canvasReference),
        transaction.get(reference),
      ]);
      if (!canvas.exists) {
        throw new ApiError(
          404,
          "canvas_not_found",
          "The canvas was not found.",
        );
      }
      const current = toComment(snapshot);
      if (current.version !== baseVersion) {
        throw new ApiError(
          409,
          "version_conflict",
          "This comment changed in another tab or device.",
        );
      }
      transaction.delete(reference);
    });
  }

  async deleteAllForCanvas(userId: string, canvasId: string) {
    await this.firestore.recursiveDelete(
      this.canvasRef(userId, canvasId).collection("comments"),
    );
  }
}
