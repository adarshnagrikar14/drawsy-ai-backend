import { createHash, randomBytes, randomUUID } from "node:crypto";

import { getFirestore, Timestamp } from "firebase-admin/firestore";

import { ApiError } from "../http/apiError.js";

import type { App } from "firebase-admin/app";
import type {
  ConnectorConnection,
  ConnectorConnectionStore,
  ConnectorOAuthAttemptStatus,
  ConnectorProviderId,
  StoredConnectorConnection,
} from "./types.js";

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("base64url");

export class FirestoreConnectorConnectionStore implements ConnectorConnectionStore {
  private readonly firestore;

  constructor(app: App) {
    this.firestore = getFirestore(app);
  }

  async createOAuthState(
    userId: string,
    providerId: ConnectorProviderId,
    expiresAt: number,
    codeVerifier?: string,
  ) {
    const state = randomBytes(32).toString("base64url");
    const attemptId = randomUUID();
    const batch = this.firestore.batch();
    batch.set(
      this.firestore.collection("connectorOAuthStates").doc(digest(state)),
      {
        userId,
        providerId,
        attemptId,
        ...(codeVerifier ? { codeVerifier } : {}),
        expiresAt,
        deleteAt: Timestamp.fromMillis(expiresAt),
        createdAt: Date.now(),
      },
    );
    batch.set(
      this.firestore.collection("connectorOAuthAttempts").doc(attemptId),
      {
        userId,
        providerId,
        status: "pending",
        expiresAt,
        deleteAt: Timestamp.fromMillis(expiresAt),
        updatedAt: Date.now(),
      },
    );
    await batch.commit();
    return { state, attemptId };
  }

  async consumeOAuthState(state: string, providerId: ConnectorProviderId) {
    const reference = this.firestore
      .collection("connectorOAuthStates")
      .doc(digest(state));
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const data = snapshot.data() as
        | {
            userId?: string;
            providerId?: string;
            attemptId?: string;
            expiresAt?: number;
            codeVerifier?: string;
          }
        | undefined;
      transaction.delete(reference);
      if (
        !snapshot.exists ||
        !data?.userId ||
        data.providerId !== providerId ||
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
      return {
        userId: data.userId,
        attemptId: data.attemptId,
        ...(data.codeVerifier ? { codeVerifier: data.codeVerifier } : {}),
      };
    });
  }

  async setOAuthAttemptStatus(
    attemptId: string,
    status: ConnectorOAuthAttemptStatus,
  ) {
    await this.firestore
      .collection("connectorOAuthAttempts")
      .doc(attemptId)
      .set({ ...status, updatedAt: Date.now() }, { merge: true });
  }

  async getOAuthAttemptStatus(userId: string, attemptId: string) {
    const snapshot = await this.firestore
      .collection("connectorOAuthAttempts")
      .doc(attemptId)
      .get();
    const data = snapshot.data() as
      | (ConnectorOAuthAttemptStatus & {
          userId?: string;
          expiresAt?: number;
        })
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
      const connection = document.data() as StoredConnectorConnection;
      return {
        id: document.id,
        providerId: connection.providerId,
        accountId: connection.accountId,
        accountName: connection.accountName,
        accountEmail: connection.accountEmail,
        accountAvatarUrl: connection.accountAvatarUrl,
        capabilities: connection.capabilities,
        scopes: connection.scopes,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      } satisfies ConnectorConnection;
    });
  }

  async getConnection(userId: string, connectionId: string) {
    const snapshot = await this.connections(userId).doc(connectionId).get();
    if (!snapshot.exists) {
      throw new ApiError(
        404,
        "connector_connection_not_found",
        "Connector connection was not found.",
      );
    }
    return {
      ...(snapshot.data() as StoredConnectorConnection),
      id: snapshot.id,
    };
  }

  async saveConnection(userId: string, connection: StoredConnectorConnection) {
    await this.connections(userId).doc(connection.id).set(connection);
  }

  async deleteConnection(userId: string, connectionId: string) {
    await this.connections(userId).doc(connectionId).delete();
  }

  private connections(userId: string) {
    return this.firestore
      .collection("users")
      .doc(userId)
      .collection("connectorConnections");
  }
}
