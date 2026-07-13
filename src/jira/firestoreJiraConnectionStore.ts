import { createHash, randomBytes, randomUUID } from "node:crypto";

import { getFirestore } from "firebase-admin/firestore";

import { ApiError } from "../http/apiError.js";

import type { App } from "firebase-admin/app";
import type {
  JiraConnection,
  JiraConnectionStore,
  JiraOAuthAttemptStatus,
  StoredJiraConnection,
} from "./types.js";

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("base64url");

export class FirestoreJiraConnectionStore implements JiraConnectionStore {
  private readonly firestore;

  constructor(app: App) {
    this.firestore = getFirestore(app);
  }

  async createOAuthState(userId: string, expiresAt: number) {
    const state = randomBytes(32).toString("base64url");
    const attemptId = randomUUID();
    const batch = this.firestore.batch();
    batch.set(this.firestore.collection("jiraOAuthStates").doc(digest(state)), {
      userId,
      attemptId,
      expiresAt,
      createdAt: Date.now(),
    });
    batch.set(this.firestore.collection("jiraOAuthAttempts").doc(attemptId), {
      userId,
      status: "pending",
      expiresAt,
      updatedAt: Date.now(),
    });
    await batch.commit();
    return { state, attemptId };
  }

  async consumeOAuthState(state: string) {
    const reference = this.firestore
      .collection("jiraOAuthStates")
      .doc(digest(state));
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        throw new ApiError(
          400,
          "invalid_oauth_state",
          "OAuth state is invalid or expired.",
        );
      }
      const data = snapshot.data() as {
        userId?: string;
        attemptId?: string;
        expiresAt?: number;
      };
      transaction.delete(reference);
      if (
        !data.userId ||
        !data.attemptId ||
        !data.expiresAt ||
        data.expiresAt <= Date.now()
      ) {
        throw new ApiError(
          400,
          "invalid_oauth_state",
          "OAuth state is invalid or expired.",
        );
      }
      return { userId: data.userId, attemptId: data.attemptId };
    });
  }

  async setOAuthAttemptStatus(
    attemptId: string,
    status: JiraOAuthAttemptStatus,
  ) {
    await this.firestore
      .collection("jiraOAuthAttempts")
      .doc(attemptId)
      .set({ ...status, updatedAt: Date.now() }, { merge: true });
  }

  async getOAuthAttemptStatus(userId: string, attemptId: string) {
    const snapshot = await this.firestore
      .collection("jiraOAuthAttempts")
      .doc(attemptId)
      .get();
    const data = snapshot.data() as
      | (JiraOAuthAttemptStatus & { userId?: string; expiresAt?: number })
      | undefined;
    if (!snapshot.exists || data?.userId !== userId) {
      throw new ApiError(
        404,
        "oauth_attempt_not_found",
        "OAuth attempt was not found.",
      );
    }
    if (!data.expiresAt || data.expiresAt <= Date.now()) {
      return { status: "failed", error: "expired" } as const;
    }
    return {
      status: data.status,
      ...(data.error ? { error: data.error } : {}),
    };
  }

  async listConnections(userId: string) {
    const snapshot = await this.connections(userId)
      .orderBy("updatedAt", "desc")
      .get();
    return snapshot.docs.map((document) => {
      const connection = document.data() as StoredJiraConnection;
      return {
        id: document.id,
        accountId: connection.accountId,
        accountName: connection.accountName,
        accountEmail: connection.accountEmail,
        accountAvatarUrl: connection.accountAvatarUrl,
        sites: connection.sites,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      } satisfies JiraConnection;
    });
  }

  async getConnection(userId: string, connectionId: string) {
    const snapshot = await this.connections(userId).doc(connectionId).get();
    if (!snapshot.exists) {
      throw new ApiError(
        404,
        "jira_connection_not_found",
        "Jira connection was not found.",
      );
    }
    return { ...(snapshot.data() as StoredJiraConnection), id: snapshot.id };
  }

  async saveConnection(userId: string, connection: StoredJiraConnection) {
    const id = connection.id || randomUUID();
    await this.connections(userId)
      .doc(id)
      .set({ ...connection, id });
  }

  async deleteConnection(userId: string, connectionId: string) {
    await this.connections(userId).doc(connectionId).delete();
  }

  private connections(userId: string) {
    return this.firestore
      .collection("users")
      .doc(userId)
      .collection("jiraConnections");
  }
}
