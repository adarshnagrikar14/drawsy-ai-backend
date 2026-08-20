import { getFirestore } from "firebase-admin/firestore";
import type { DocumentData } from "firebase-admin/firestore";

import type { App } from "firebase-admin/app";
import type {
  HydraStateStore,
  HydraSyncState,
  HydraUserState,
} from "./types.js";

type StoredHydraUserState = HydraUserState & {
  syncLeaseUntil?: number | null;
  lastError?: string | null;
};

const USER_SEEN_WRITE_INTERVAL_MS = 60_000;

const isAlreadyExistsError = (error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === 6 || code === "6" || code === "ALREADY_EXISTS";
};

export class FirestoreHydraStateStore implements HydraStateStore {
  private readonly firestore;

  constructor(app: App) {
    this.firestore = getFirestore(app);
  }

  async ensureUser(userId: string, now: number) {
    const reference = this.user(userId);
    const snapshot = await reference.get();
    if (!snapshot.exists) {
      const initial = {
        enabled: true,
        lastSeenAt: now,
        nextSyncAt: now,
        syncInProgress: false,
        syncLeaseUntil: null,
        lastSyncAt: null,
        lastError: null,
      };
      try {
        await reference.create(initial);
        return this.readUser(initial);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        const retry = await reference.get();
        return this.readUser(retry.data());
      }
    }

    const current = this.readStoredUser(snapshot.data());
    const staleSyncLease =
      current.syncInProgress && (current.syncLeaseUntil || 0) <= now;
    const updates: Record<string, unknown> = {
      ...(current.enabled ? {} : { enabled: true }),
      // A process can die after acquiring the lease and before finishSync.
      // Clear that durable marker on the next authenticated read so a
      // restart cannot leave this user's sync permanently stuck.
      ...(staleSyncLease
        ? { syncInProgress: false, syncLeaseUntil: null, nextSyncAt: now }
        : {}),
      ...(now - current.lastSeenAt >= USER_SEEN_WRITE_INTERVAL_MS
        ? { lastSeenAt: now }
        : {}),
      ...(current.nextSyncAt === null && !current.syncInProgress
        ? { nextSyncAt: now }
        : {}),
    };
    if (Object.keys(updates).length) {
      await reference.set(updates, { merge: true });
    }
    return this.readUser({ ...current, ...updates });
  }

  async getUser(userId: string) {
    const snapshot = await this.user(userId).get();
    return snapshot.exists ? this.readUser(snapshot.data()) : null;
  }

  async listDueUsers(now: number, limit: number) {
    const snapshot = await this.firestore
      .collection("hydraUsers")
      .where("enabled", "==", true)
      .limit(Math.max(limit * 4, limit))
      .get();
    return snapshot.docs
      .map((document) => ({
        id: document.id,
        state: this.readStoredUser(document.data()),
      }))
      .filter(
        ({ state }) =>
          !state.syncInProgress &&
          (state.nextSyncAt === null || state.nextSyncAt <= now),
      )
      .sort(
        (left, right) =>
          (left.state.nextSyncAt || 0) - (right.state.nextSyncAt || 0),
      )
      .slice(0, limit)
      .map(({ id }) => id);
  }

  async tryStartSync(userId: string, now: number, leaseMs: number) {
    const reference = this.user(userId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return false;
      const current = this.readStoredUser(snapshot.data());
      if (!current.enabled) return false;
      if (current.syncInProgress && (current.syncLeaseUntil || 0) > now) {
        return false;
      }
      transaction.set(
        reference,
        {
          syncInProgress: true,
          syncLeaseUntil: now + leaseMs,
          lastError: null,
        },
        { merge: true },
      );
      return true;
    });
  }

  async finishSync(
    userId: string,
    input: { finishedAt: number; nextSyncAt: number; error?: string },
  ) {
    await this.user(userId).set(
      {
        syncInProgress: false,
        syncLeaseUntil: null,
        lastSyncAt: input.finishedAt,
        nextSyncAt: input.nextSyncAt,
        lastError: input.error || null,
      },
      { merge: true },
    );
  }

  async getConnectionState(userId: string, connectionId: string) {
    const snapshot = await this.connection(userId, connectionId).get();
    if (!snapshot.exists) return null;
    return this.readConnection(snapshot.data());
  }

  async saveConnectionState(userId: string, state: HydraSyncState) {
    await this.connection(userId, state.connectionId).set(state, {
      merge: true,
    });
  }

  private readUser(value: DocumentData | undefined) {
    const state = this.readStoredUser(value);
    return {
      enabled: state.enabled,
      lastSeenAt: state.lastSeenAt,
      lastSyncAt: state.lastSyncAt,
      nextSyncAt: state.nextSyncAt,
      syncInProgress: state.syncInProgress,
    } satisfies HydraUserState;
  }

  private readStoredUser(value: DocumentData | undefined) {
    const record = value || {};
    return {
      enabled: record.enabled !== false,
      lastSeenAt: typeof record.lastSeenAt === "number" ? record.lastSeenAt : 0,
      lastSyncAt:
        typeof record.lastSyncAt === "number" ? record.lastSyncAt : null,
      nextSyncAt:
        typeof record.nextSyncAt === "number" ? record.nextSyncAt : null,
      syncInProgress: record.syncInProgress === true,
      syncLeaseUntil:
        typeof record.syncLeaseUntil === "number"
          ? record.syncLeaseUntil
          : null,
      lastError: typeof record.lastError === "string" ? record.lastError : null,
    } satisfies StoredHydraUserState;
  }

  private readConnection(value: DocumentData | undefined) {
    const record = value || {};
    const cursorRecord =
      record.cursorByCapability &&
      typeof record.cursorByCapability === "object" &&
      !Array.isArray(record.cursorByCapability)
        ? (record.cursorByCapability as Record<string, unknown>)
        : null;
    return {
      connectionId: String(record.connectionId || ""),
      status:
        record.status === "syncing" ||
        record.status === "ready" ||
        record.status === "error" ||
        record.status === "unsupported"
          ? record.status
          : "waiting",
      currentCapability:
        typeof record.currentCapability === "string"
          ? (record.currentCapability as HydraSyncState["currentCapability"])
          : null,
      completedCapabilities:
        typeof record.completedCapabilities === "number"
          ? record.completedCapabilities
          : 0,
      totalCapabilities:
        typeof record.totalCapabilities === "number"
          ? record.totalCapabilities
          : 0,
      recordsSubmitted:
        typeof record.recordsSubmitted === "number"
          ? record.recordsSubmitted
          : 0,
      lastSyncAt:
        typeof record.lastSyncAt === "number" ? record.lastSyncAt : null,
      connectionUpdatedAt:
        typeof record.connectionUpdatedAt === "number"
          ? record.connectionUpdatedAt
          : 0,
      cursorByCapability: cursorRecord
        ? Object.fromEntries(
            Object.entries(cursorRecord).map(([key, cursor]) => [
              key,
              typeof cursor === "string" ? cursor : null,
            ]),
          )
        : {},
      pendingIndexingIds: Array.isArray(record.pendingIndexingIds)
        ? record.pendingIndexingIds.filter(
            (id: unknown): id is string =>
              typeof id === "string" && id.length > 0,
          )
        : [],
      lastError: typeof record.lastError === "string" ? record.lastError : null,
    } satisfies HydraSyncState;
  }

  private user(userId: string) {
    return this.firestore.collection("hydraUsers").doc(userId);
  }

  private connection(userId: string, connectionId: string) {
    return this.user(userId).collection("connections").doc(connectionId);
  }
}
