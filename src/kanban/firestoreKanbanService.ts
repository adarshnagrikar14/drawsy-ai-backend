import { randomBytes, randomUUID } from "node:crypto";

import { getFirestore } from "firebase-admin/firestore";

import { ApiError } from "../http/apiError.js";
import { normalizeEmail } from "./crypto.js";
import { createRankBetween, initialRank } from "./rank.js";

import type { App } from "firebase-admin/app";
import type {
  DocumentData,
  DocumentSnapshot,
  DocumentReference,
  QuerySnapshot,
  Firestore,
} from "firebase-admin/firestore";
import type { KanbanCrypto } from "./crypto.js";
import type {
  KanbanBoardPayload,
  KanbanBoardSummary,
  KanbanCanvasLink,
  KanbanCard,
  KanbanCardPayload,
  KanbanChange,
  KanbanChecklistItem,
  KanbanChecklistPayload,
  KanbanColumn,
  KanbanColumnPayload,
  KanbanCommand,
  KanbanCommandResult,
  KanbanEncryptedPayload,
  KanbanInvitation,
  KanbanMember,
  KanbanRole,
  KanbanRealtimeEvent,
  KanbanService,
  KanbanSnapshot,
} from "./types.js";

type StoredBoard = {
  ownerId: string;
  schemaVersion: 2;
  revision: number;
  status: "active" | "trashed";
  encryptedPayload: KanbanEncryptedPayload;
  wrappedDataKey: KanbanEncryptedPayload;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
};

type StoredEntity = {
  encryptedPayload: KanbanEncryptedPayload;
};

type StoredInvitation = {
  boardId: string;
  emailDigest: string;
  encryptedPayload: KanbanEncryptedPayload;
  role: "editor" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  tokenDigest: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedBy: string | null;
  acceptedAt: number | null;
};

type StoredEvent = Omit<KanbanChange, "value"> & {
  encryptedValue: KanbanEncryptedPayload;
  expiresAt: Date;
};

type EntityType = KanbanChange["entityType"];
type DeleteColumnCommand = {
  type: "deleteColumn";
  entityId: string;
  baseVersion: number;
  payload: { destinationColumnId: string | null };
};
type QueryCache = Map<string, QuerySnapshot<DocumentData>>;
type CommandDocumentSnapshot = Pick<
  DocumentSnapshot<DocumentData>,
  "data" | "exists" | "id" | "ref"
>;
type CommandTransaction = {
  get(reference: DocumentReference): Promise<CommandDocumentSnapshot>;
  set(reference: DocumentReference, data: DocumentData): void;
  update(reference: DocumentReference, data: DocumentData): void;
  create(reference: DocumentReference, data: DocumentData): void;
  delete(reference: DocumentReference): void;
};
type RealtimeSubscriber = {
  listener: (event: KanbanRealtimeEvent) => void;
  onError: (error: Error) => void;
};
type RealtimeChannel = {
  subscribers: Set<RealtimeSubscriber>;
  unsubscribe: () => void;
  lastVersion: number;
};

class CommandFailure extends Error {
  constructor(
    readonly status: "conflict" | "rejected",
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const requireData = <T>(
  snapshot: CommandDocumentSnapshot,
  code: string,
  message: string,
): T => {
  if (!snapshot.exists) {
    throw new ApiError(404, code, message);
  }
  return snapshot.data() as T;
};

const unique = <T>(values: T[]) => [...new Set(values)];

const eventId = (revision: number) => revision.toString().padStart(20, "0");

const roleCanEdit = (role: KanbanRole) => role === "owner" || role === "editor";

const ORIGINAL_KANBAN_COLUMN_TITLES = [
  "Not started",
  "In progress",
  "Done",
  "In review",
];

const compareRanks = (first: string, second: string) =>
  first < second ? -1 : first > second ? 1 : 0;

const assertVersion = (actual: number, expected: number) => {
  if (actual !== expected) {
    throw new CommandFailure(
      "conflict",
      "version_conflict",
      "This item changed on another device.",
    );
  }
};

const changedFields = (payload: Record<string, unknown>) =>
  Object.keys(payload).filter((key) => payload[key] !== undefined);

const assertFieldVersions = (
  current: Record<string, number>,
  expected: Record<string, number>,
  fields: string[],
) => {
  const conflicts = fields.filter(
    (field) => (current[field] || 0) !== (expected[field] || 0),
  );
  if (conflicts.length > 0) {
    throw new CommandFailure(
      "conflict",
      "field_conflict",
      `Fields changed on another device: ${conflicts.join(", ")}`,
    );
  }
};

const nextFieldVersions = (
  current: Record<string, number>,
  fields: string[],
) => ({
  ...current,
  ...Object.fromEntries(
    fields.map((field) => [field, (current[field] || 0) + 1]),
  ),
});

export class FirestoreKanbanService implements KanbanService {
  private readonly firestore: Firestore;
  private readonly boardChannels = new Map<string, RealtimeChannel>();
  private readonly memberChannels = new Map<string, RealtimeChannel>();

  constructor(
    app: App,
    private readonly crypto: KanbanCrypto,
    private readonly retention: {
      eventMs: number;
      operationMs: number;
      invitesPerHour: number;
    },
  ) {
    this.firestore = getFirestore(app);
  }

  private boardRef(boardId: string) {
    return this.firestore.collection("kanbanBoards").doc(boardId);
  }

  private memberRef(boardId: string, userId: string) {
    return this.boardRef(boardId).collection("members").doc(userId);
  }

  private userBoardRef(userId: string, boardId: string) {
    return this.firestore
      .collection("users")
      .doc(userId)
      .collection("kanbanBoardRefs")
      .doc(boardId);
  }

  private entityRef(
    boardId: string,
    collection: "columns" | "cards" | "checklistItems" | "canvasLinks",
    id: string,
  ) {
    return this.boardRef(boardId).collection(collection).doc(id);
  }

  private boardKey(boardId: string, board: StoredBoard) {
    return this.crypto.unwrapDataKey(boardId, board.wrappedDataKey);
  }

  private async readMembership(userId: string, boardId: string) {
    const [boardSnapshot, memberSnapshot] = await Promise.all([
      this.boardRef(boardId).get(),
      this.memberRef(boardId, userId).get(),
    ]);
    const board = requireData<StoredBoard>(
      boardSnapshot,
      "board_not_found",
      "The board was not found.",
    );
    const member = requireData<KanbanMember>(
      memberSnapshot,
      "board_not_found",
      "The board was not found.",
    );
    return { board, member };
  }

  async listBoards(userId: string) {
    const references = await this.firestore
      .collection("users")
      .doc(userId)
      .collection("kanbanBoardRefs")
      .get();
    if (references.empty) {
      return [];
    }
    const boardSnapshots = await this.firestore.getAll(
      ...references.docs.map((reference) => this.boardRef(reference.id)),
    );
    const summaries = boardSnapshots
      .filter((snapshot) => snapshot.exists)
      .map((snapshot) => {
        const board = requireData<StoredBoard>(
          snapshot,
          "board_not_found",
          "The board was not found.",
        );
        const member = references.docs
          .find((reference) => reference.id === snapshot.id)
          ?.data() as { role?: KanbanRole } | undefined;
        const key = this.boardKey(snapshot.id, board);
        const payload = this.crypto.decryptJson<KanbanBoardPayload>(
          key,
          snapshot.id,
          "board",
          snapshot.id,
          board.encryptedPayload,
        );
        return {
          id: snapshot.id,
          title: payload.title,
          role: member?.role || "viewer",
          revision: board.revision,
          status: board.status,
          updatedAt: board.updatedAt,
        } satisfies KanbanBoardSummary;
      });
    return summaries.sort(
      (first, second) => second.updatedAt - first.updatedAt,
    );
  }

  async getRealtimeState(userId: string, boardId: string) {
    const { board, member } = await this.readMembership(userId, boardId);
    return { latestRevision: board.revision, member };
  }

  subscribeToRealtime(
    userId: string,
    boardId: string,
    listener: (event: KanbanRealtimeEvent) => void,
    onError: (error: Error) => void,
  ) {
    const subscriber = { listener, onError };
    const boardChannel = this.getBoardChannel(boardId);
    boardChannel.subscribers.add(subscriber);
    const memberChannelId = `${boardId}:${userId}`;
    const memberChannel = this.getMemberChannel(
      memberChannelId,
      boardId,
      userId,
    );
    memberChannel.subscribers.add(subscriber);

    return () => {
      this.releaseRealtimeChannel(this.boardChannels, boardId, subscriber);
      this.releaseRealtimeChannel(
        this.memberChannels,
        memberChannelId,
        subscriber,
      );
    };
  }

  private getBoardChannel(boardId: string) {
    const current = this.boardChannels.get(boardId);
    if (current) {
      return current;
    }
    const channel: RealtimeChannel = {
      subscribers: new Set(),
      unsubscribe: () => undefined,
      lastVersion: -1,
    };
    channel.unsubscribe = this.boardRef(boardId).onSnapshot(
      (snapshot) => {
        if (!snapshot.exists) {
          channel.subscribers.forEach(({ listener }) =>
            listener({ type: "access_revoked" }),
          );
          return;
        }
        const revision = Number(snapshot.data()?.revision || 0);
        if (revision !== channel.lastVersion) {
          channel.lastVersion = revision;
          channel.subscribers.forEach(({ listener }) =>
            listener({ type: "revision", latestRevision: revision }),
          );
        }
      },
      (error) => channel.subscribers.forEach(({ onError }) => onError(error)),
    );
    this.boardChannels.set(boardId, channel);
    return channel;
  }

  private getMemberChannel(channelId: string, boardId: string, userId: string) {
    const current = this.memberChannels.get(channelId);
    if (current) {
      return current;
    }
    const channel: RealtimeChannel = {
      subscribers: new Set(),
      unsubscribe: () => undefined,
      lastVersion: -1,
    };
    channel.unsubscribe = this.memberRef(boardId, userId).onSnapshot(
      (snapshot) => {
        if (!snapshot.exists) {
          channel.subscribers.forEach(({ listener }) =>
            listener({ type: "access_revoked" }),
          );
          return;
        }
        const member = snapshot.data() as KanbanMember;
        if (member.membershipVersion !== channel.lastVersion) {
          channel.lastVersion = member.membershipVersion;
          channel.subscribers.forEach(({ listener }) =>
            listener({
              type: "role_changed",
              role: member.role,
              membershipVersion: member.membershipVersion,
            }),
          );
        }
      },
      (error) => channel.subscribers.forEach(({ onError }) => onError(error)),
    );
    this.memberChannels.set(channelId, channel);
    return channel;
  }

  private releaseRealtimeChannel(
    channels: Map<string, RealtimeChannel>,
    channelId: string,
    subscriber: RealtimeSubscriber,
  ) {
    const channel = channels.get(channelId);
    if (!channel) {
      return;
    }
    channel.subscribers.delete(subscriber);
    if (channel.subscribers.size === 0) {
      channel.unsubscribe();
      channels.delete(channelId);
    }
  }

  async createBoard(
    userId: string,
    input: {
      id: string;
      title: string;
      initialColumnId?: string;
      initialColumnTitle?: string;
      columns?: Array<{ id: string; title: string }>;
    },
  ) {
    const boardReference = this.boardRef(input.id);
    const memberReference = this.memberRef(input.id, userId);
    const userReference = this.userBoardRef(userId, input.id);
    const dataKey = this.crypto.createDataKey();
    const now = Date.now();
    const initialColumns =
      input.columns && input.columns.length > 0
        ? input.columns
        : ORIGINAL_KANBAN_COLUMN_TITLES.map((title, index) => ({
            id:
              index === 0 && input.initialColumnId
                ? input.initialColumnId
                : randomUUID(),
            title:
              index === 0 && input.initialColumnTitle
                ? input.initialColumnTitle
                : title,
          }));
    if (
      new Set(initialColumns.map((column) => column.id)).size !==
      initialColumns.length
    ) {
      throw new ApiError(
        400,
        "duplicate_column_id",
        "Initial columns must have unique IDs.",
      );
    }
    const payload: KanbanBoardPayload = {
      title: input.title,
      roughness: 1,
      cardRadius: 1,
      isLocked: false,
    };
    const stored: StoredBoard = {
      ownerId: userId,
      schemaVersion: 2,
      revision: 1,
      status: "active",
      encryptedPayload: this.crypto.encryptJson(
        dataKey,
        input.id,
        "board",
        input.id,
        payload,
      ),
      wrappedDataKey: this.crypto.wrapDataKey(input.id, dataKey),
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
    };
    const member: KanbanMember = {
      userId,
      role: "owner",
      membershipVersion: 1,
      invitedBy: null,
      joinedAt: now,
      updatedAt: now,
    };
    let previousRank: string | null = null;
    const columns = initialColumns.map((column) => {
      const rank =
        previousRank === null
          ? initialRank()
          : createRankBetween(previousRank, null);
      previousRank = rank;
      const columnPayload: KanbanColumnPayload = {
        title: column.title,
      };
      return {
        id: column.id,
        stored: {
          boardId: input.id,
          rank,
          version: 1,
          encryptedPayload: this.crypto.encryptJson(
            dataKey,
            input.id,
            "column",
            column.id,
            columnPayload,
          ),
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      };
    });
    await this.firestore.runTransaction(async (transaction) => {
      const boardSnapshot = await transaction.get(boardReference);
      if (boardSnapshot.exists) {
        throw new ApiError(
          409,
          "board_already_exists",
          "The board already exists.",
        );
      }
      transaction.create(boardReference, stored);
      transaction.set(memberReference, member);
      transaction.set(userReference, {
        boardId: input.id,
        role: "owner",
        updatedAt: now,
      });
      for (const column of columns) {
        transaction.set(
          this.entityRef(input.id, "columns", column.id),
          column.stored,
        );
      }
      transaction.create(
        boardReference.collection("events").doc(eventId(1)),
        this.createStoredEvent(
          dataKey,
          input.id,
          1,
          "board_created",
          "board",
          input.id,
          false,
          { id: input.id, ...payload },
          userId,
          now,
        ),
      );
    });
    return this.getSnapshot(userId, input.id);
  }

  async getSnapshot(userId: string, boardId: string) {
    const { board, member } = await this.readMembership(userId, boardId);
    const key = this.boardKey(boardId, board);
    const boardPayload = this.crypto.decryptJson<KanbanBoardPayload>(
      key,
      boardId,
      "board",
      boardId,
      board.encryptedPayload,
    );
    const boardReference = this.boardRef(boardId);
    const [columns, cards, checklistItems, links, members] = await Promise.all([
      boardReference.collection("columns").get(),
      boardReference.collection("cards").get(),
      boardReference.collection("checklistItems").get(),
      boardReference.collection("canvasLinks").get(),
      boardReference.collection("members").get(),
    ]);
    const snapshot: KanbanSnapshot = {
      board: {
        id: boardId,
        ...boardPayload,
        schemaVersion: 2,
        ownerId: board.ownerId,
        role: member.role,
        revision: board.revision,
        status: board.status,
        createdAt: board.createdAt,
        updatedAt: board.updatedAt,
        trashedAt: board.trashedAt,
      },
      columns: columns.docs.map((item) => this.toColumn(key, boardId, item)),
      cards: cards.docs.map((item) => this.toCard(key, boardId, item)),
      checklistItems: checklistItems.docs.map((item) =>
        this.toChecklistItem(key, boardId, item),
      ),
      canvasLinks: await this.resolveCanvasLinks(userId, boardId, links.docs),
      members: members.docs.map((item) => item.data() as KanbanMember),
    };
    snapshot.columns.sort((first, second) =>
      compareRanks(first.rank, second.rank),
    );
    snapshot.cards.sort((first, second) =>
      compareRanks(first.rank, second.rank),
    );
    snapshot.checklistItems.sort((first, second) =>
      compareRanks(first.rank, second.rank),
    );
    return snapshot;
  }

  async getChanges(userId: string, boardId: string, afterRevision: number) {
    const { board } = await this.readMembership(userId, boardId);
    const key = this.boardKey(boardId, board);
    const events = await this.boardRef(boardId)
      .collection("events")
      .where("revision", ">", afterRevision)
      .orderBy("revision", "asc")
      .limit(500)
      .get();
    return {
      changes: events.docs.map((snapshot) => {
        const event = snapshot.data() as StoredEvent;
        return {
          revision: event.revision,
          type: event.type,
          entityType: event.entityType,
          entityId: event.entityId,
          deleted: event.deleted,
          value: this.crypto.decryptJson(
            key,
            boardId,
            "event",
            snapshot.id,
            event.encryptedValue,
          ),
          actorId: event.actorId,
          createdAt: event.createdAt,
        };
      }),
      latestRevision: board.revision,
    };
  }

  private collectRefsToPreFetch(
    boardId: string,
    userId: string,
    commands: KanbanCommand[],
  ): Map<string, DocumentReference> {
    const boardRef = this.boardRef(boardId);
    const memberRef = this.memberRef(boardId, userId);
    const refs = new Map<string, DocumentReference>();

    refs.set(boardRef.path, boardRef);
    refs.set(memberRef.path, memberRef);

    for (const command of commands) {
      const opRef = boardRef.collection("operations").doc(command.operationId);
      refs.set(opRef.path, opRef);

      let collectionName = "";
      if (command.type.toLowerCase().includes("column")) {
        collectionName = "columns";
      } else if (command.type.toLowerCase().includes("card")) {
        collectionName = "cards";
      } else if (command.type.toLowerCase().includes("checklist")) {
        collectionName = "checklistItems";
      } else if (command.type.toLowerCase().includes("canvaslink")) {
        collectionName = "canvasLinks";
      }

      if ("entityId" in command && command.entityId && collectionName) {
        const entRef = boardRef
          .collection(collectionName)
          .doc(command.entityId);
        refs.set(entRef.path, entRef);
      }

      if (command.payload) {
        const {
          beforeId,
          afterId,
          columnId,
          cardId,
          canvasId,
          assigneeIds,
          destinationColumnId,
        } = command.payload as Record<string, unknown>;

        if (collectionName) {
          if (typeof beforeId === "string") {
            const ref = boardRef.collection(collectionName).doc(beforeId);
            refs.set(ref.path, ref);
          }
          if (typeof afterId === "string") {
            const ref = boardRef.collection(collectionName).doc(afterId);
            refs.set(ref.path, ref);
          }
        }

        if (typeof columnId === "string") {
          const ref = boardRef.collection("columns").doc(columnId);
          refs.set(ref.path, ref);
        }
        if (typeof cardId === "string") {
          const ref = boardRef.collection("cards").doc(cardId);
          refs.set(ref.path, ref);
        }
        if (
          command.type === "createCanvasLink" &&
          typeof canvasId === "string"
        ) {
          const ref = this.firestore
            .collection("users")
            .doc(userId)
            .collection("canvases")
            .doc(canvasId);
          refs.set(ref.path, ref);
        }
        if (typeof destinationColumnId === "string") {
          const ref = boardRef.collection("columns").doc(destinationColumnId);
          refs.set(ref.path, ref);
        }
        if (Array.isArray(assigneeIds)) {
          for (const id of assigneeIds) {
            if (typeof id === "string") {
              const ref = boardRef.collection("members").doc(id);
              refs.set(ref.path, ref);
            }
          }
        }
      }
    }

    return refs;
  }

  async applyCommands(
    userId: string,
    boardId: string,
    clientId: string,
    commands: KanbanCommand[],
  ) {
    const boardReference = this.boardRef(boardId);
    const memberReference = this.memberRef(boardId, userId);

    return await this.firestore.runTransaction(async (transaction) => {
      const pathsToPreFetch = this.collectRefsToPreFetch(
        boardId,
        userId,
        commands,
      );
      const docRefs = Array.from(pathsToPreFetch.values());
      const snapshots =
        docRefs.length > 0 ? await transaction.getAll(...docRefs) : [];
      const snapshotsMap = new Map<string, CommandDocumentSnapshot>();
      for (const snap of snapshots) {
        snapshotsMap.set(snap.ref.path, snap);
      }

      const boardSnapshot = snapshotsMap.get(boardReference.path)!;
      const memberSnapshot = snapshotsMap.get(memberReference.path)!;

      const board = requireData<StoredBoard>(
        boardSnapshot,
        "board_not_found",
        "The board was not found.",
      );
      const member = requireData<KanbanMember>(
        memberSnapshot,
        "board_not_found",
        "The board was not found.",
      );

      if (!roleCanEdit(member.role)) {
        throw new ApiError(
          403,
          "permission_denied",
          "Editor access is required.",
        );
      }
      if (board.status !== "active") {
        throw new ApiError(400, "board_trashed", "The board is trashed.");
      }

      const key = this.boardKey(boardId, board);
      const boardPayload = this.crypto.decryptJson<KanbanBoardPayload>(
        key,
        boardId,
        "board",
        boardId,
        board.encryptedPayload,
      );

      const queryCache: QueryCache = new Map();
      for (const command of commands) {
        if (command.type === "deleteColumn") {
          const columnsQuery = boardReference
            .collection("columns")
            .where("deletedAt", "==", null);
          const cardsQuery = boardReference
            .collection("cards")
            .where("columnId", "==", command.entityId)
            .where("deletedAt", "==", null);

          const [columnsSnap, cardsSnap] = await Promise.all([
            transaction.get(columnsQuery),
            transaction.get(cardsQuery),
          ]);

          queryCache.set(`columns:${boardId}`, columnsSnap);
          queryCache.set(`cards:${boardId}:${command.entityId}`, cardsSnap);
        }
      }

      const snapshotFromData = (
        reference: DocumentReference,
        data: DocumentData | undefined,
      ): CommandDocumentSnapshot => ({
        ref: reference,
        id: reference.id,
        exists: data !== undefined,
        data: () => data,
      });
      const commandTransaction: CommandTransaction = {
        get: (reference) => {
          const snapshot = snapshotsMap.get(reference.path);
          if (!snapshot) {
            throw new Error(
              `Kanban command document was not prefetched: ${reference.path}`,
            );
          }
          return Promise.resolve(snapshot);
        },
        set: (reference, data) => {
          transaction.set(reference, data);
          snapshotsMap.set(reference.path, snapshotFromData(reference, data));
        },
        update: (reference, data) => {
          const snapshot = snapshotsMap.get(reference.path);
          if (!snapshot?.exists) {
            throw new Error(
              `Kanban command update target was not prefetched: ${reference.path}`,
            );
          }
          const current = snapshot.data();
          transaction.update(reference, data);
          snapshotsMap.set(
            reference.path,
            snapshotFromData(reference, { ...current, ...data }),
          );
        },
        create: (reference, data) => {
          transaction.create(reference, data);
          snapshotsMap.set(reference.path, snapshotFromData(reference, data));
        },
        delete: (reference) => {
          transaction.delete(reference);
          snapshotsMap.set(
            reference.path,
            snapshotFromData(reference, undefined),
          );
        },
      };

      const results: KanbanCommandResult[] = [];
      let currentRevision = board.revision;
      const now = Date.now();

      for (const command of commands) {
        const operationReference = boardReference
          .collection("operations")
          .doc(command.operationId);
        const operationSnapshot = snapshotsMap.get(operationReference.path)!;

        if (operationSnapshot.exists) {
          const previous = operationSnapshot.data() as KanbanCommandResult & {
            actorId?: string;
            clientId?: string;
          };
          if (previous.actorId !== userId || previous.clientId !== clientId) {
            throw new ApiError(
              409,
              "operation_id_reused",
              "The operation identifier was already used.",
            );
          }
          results.push({
            operationId: previous.operationId,
            status: "duplicate",
            revision: previous.revision,
          });
          continue;
        }

        try {
          const isUnlockOnly =
            command.type === "updateBoard" &&
            command.payload.isLocked === false &&
            Object.entries(command.payload).every(
              ([field, value]) =>
                field === "isLocked" ||
                value === boardPayload[field as keyof KanbanBoardPayload],
            );
          if (boardPayload.isLocked && !isUnlockOnly) {
            throw new CommandFailure(
              "rejected",
              "board_locked",
              "Unlock the board before making changes.",
            );
          }

          const nextRevision = currentRevision + 1;
          const change = await this.executeCommand(
            commandTransaction,
            key,
            boardId,
            userId,
            command,
            nextRevision,
            now,
            queryCache,
          );

          currentRevision = nextRevision;

          results.push({
            operationId: command.operationId,
            status: "applied",
            revision: nextRevision,
            change,
          });

          transaction.create(operationReference, {
            operationId: command.operationId,
            actorId: userId,
            clientId,
            clientSequence: command.clientSequence,
            status: "applied",
            revision: nextRevision,
            createdAt: now,
            expiresAt: new Date(now + this.retention.operationMs),
          });

          transaction.create(
            boardReference.collection("events").doc(eventId(nextRevision)),
            this.createStoredEvent(
              key,
              boardId,
              nextRevision,
              change.type,
              change.entityType,
              change.entityId,
              change.deleted,
              change.value,
              userId,
              now,
            ),
          );

          transaction.create(boardReference.collection("audit").doc(), {
            actorId: userId,
            operationId: command.operationId,
            action: command.type,
            entityId: "entityId" in command ? command.entityId : boardId,
            createdAt: now,
          });
        } catch (error) {
          if (!(error instanceof CommandFailure)) {
            throw error;
          }
          results.push({
            operationId: command.operationId,
            status: error.status,
            revision: currentRevision,
            code: error.code,
            message: error.message,
          });
        }
      }

      if (currentRevision > board.revision) {
        transaction.update(boardReference, {
          revision: currentRevision,
          updatedAt: now,
        });
      }

      return results;
    });
  }

  private async executeCommand(
    transaction: CommandTransaction,
    key: Buffer,
    boardId: string,
    userId: string,
    command: KanbanCommand,
    revision: number,
    now: number,
    queryCache: QueryCache,
  ): Promise<KanbanChange> {
    if (command.type === "updateBoard") {
      const reference = this.boardRef(boardId);
      const current = requireData<StoredBoard>(
        await transaction.get(reference),
        "board_not_found",
        "The board was not found.",
      );
      const payload = this.crypto.decryptJson<KanbanBoardPayload>(
        key,
        boardId,
        "board",
        boardId,
        current.encryptedPayload,
      );
      const next = { ...payload, ...command.payload };
      transaction.update(reference, {
        encryptedPayload: this.crypto.encryptJson(
          key,
          boardId,
          "board",
          boardId,
          next,
        ),
      });
      return this.change(
        revision,
        command.type,
        "board",
        boardId,
        false,
        next,
        userId,
        now,
      );
    }

    if (command.type === "createColumn") {
      const reference = this.entityRef(boardId, "columns", command.entityId);
      if ((await transaction.get(reference)).exists) {
        throw new CommandFailure(
          "rejected",
          "column_exists",
          "The column exists.",
        );
      }
      const rank = await this.rankFor(
        transaction,
        boardId,
        "columns",
        null,
        command.payload.beforeId,
        command.payload.afterId,
      );
      const value: KanbanColumn = {
        id: command.entityId,
        boardId,
        title: command.payload.title,
        rank,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      transaction.create(reference, this.storeColumn(key, value));
      return this.change(
        revision,
        command.type,
        "column",
        value.id,
        false,
        value,
        userId,
        now,
      );
    }

    if (command.type === "updateColumn" || command.type === "moveColumn") {
      const reference = this.entityRef(boardId, "columns", command.entityId);
      const snapshot = await transaction.get(reference);
      const current = this.toColumn(key, boardId, snapshot);
      assertVersion(current.version, command.baseVersion);
      const isRenaming =
        (command.type === "updateColumn" &&
          command.payload.title &&
          command.payload.title !== current.title) ||
        (command.type === "moveColumn" &&
          command.payload.title &&
          command.payload.title !== current.title);
      if (isRenaming && ORIGINAL_KANBAN_COLUMN_TITLES.includes(current.title)) {
        throw new CommandFailure(
          "rejected",
          "og_column_rename",
          "Original Kanban columns cannot be renamed.",
        );
      }
      const value: KanbanColumn =
        command.type === "updateColumn"
          ? {
              ...current,
              ...command.payload,
              version: current.version + 1,
              updatedAt: now,
            }
          : {
              ...current,
              ...(command.payload.title
                ? { title: command.payload.title }
                : {}),
              rank: await this.rankFor(
                transaction,
                boardId,
                "columns",
                null,
                command.payload.beforeId,
                command.payload.afterId,
              ),
              version: current.version + 1,
              updatedAt: now,
            };
      transaction.set(reference, this.storeColumn(key, value));
      return this.change(
        revision,
        command.type,
        "column",
        value.id,
        false,
        value,
        userId,
        now,
      );
    }

    if (command.type === "deleteColumn") {
      return this.deleteColumn(
        transaction,
        key,
        boardId,
        userId,
        command as DeleteColumnCommand,
        revision,
        now,
        queryCache,
      );
    }

    if (command.type === "restoreColumn") {
      const reference = this.entityRef(boardId, "columns", command.entityId);
      const current = this.toColumn(
        key,
        boardId,
        await transaction.get(reference),
      );
      assertVersion(current.version, command.baseVersion);
      const value = {
        ...current,
        version: current.version + 1,
        updatedAt: now,
        deletedAt: null,
      };
      transaction.set(reference, this.storeColumn(key, value));
      return this.change(
        revision,
        command.type,
        "column",
        value.id,
        false,
        value,
        userId,
        now,
      );
    }

    if (command.type === "createCard") {
      await this.assertColumn(transaction, boardId, command.payload.columnId);
      await this.assertAssignees(
        transaction,
        boardId,
        command.payload.assigneeIds,
      );
      const reference = this.entityRef(boardId, "cards", command.entityId);
      if ((await transaction.get(reference)).exists) {
        throw new CommandFailure("rejected", "card_exists", "The card exists.");
      }
      const rank = await this.rankFor(
        transaction,
        boardId,
        "cards",
        command.payload.columnId,
        command.payload.beforeId,
        command.payload.afterId,
      );
      const { columnId, assigneeIds } = command.payload;
      const payload: KanbanCardPayload = {
        title: command.payload.title,
        description: command.payload.description,
        priority: command.payload.priority,
        progress: command.payload.progress,
        dueDate: command.payload.dueDate,
        legacyAssigneeText: command.payload.legacyAssigneeText,
        legacyCanvasTags: command.payload.legacyCanvasTags,
      };
      const fields = [...Object.keys(payload), "assigneeIds"];
      const value: KanbanCard = {
        id: command.entityId,
        boardId,
        columnId,
        rank,
        ...payload,
        assigneeIds,
        version: 1,
        fieldVersions: Object.fromEntries(fields.map((field) => [field, 1])),
        createdBy: userId,
        updatedBy: userId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      transaction.create(reference, this.storeCard(key, value));
      return this.change(
        revision,
        command.type,
        "card",
        value.id,
        false,
        value,
        userId,
        now,
      );
    }

    if (command.type === "updateCard") {
      const reference = this.entityRef(boardId, "cards", command.entityId);
      const current = this.toCard(
        key,
        boardId,
        await transaction.get(reference),
      );
      if (current.deletedAt !== null) {
        throw new CommandFailure(
          "conflict",
          "entity_deleted",
          "The card was deleted.",
        );
      }
      const fields = changedFields(command.payload);
      assertFieldVersions(
        current.fieldVersions,
        command.baseFieldVersions,
        fields,
      );
      if (command.payload.assigneeIds) {
        await this.assertAssignees(
          transaction,
          boardId,
          command.payload.assigneeIds,
        );
      }
      const value: KanbanCard = {
        ...current,
        ...command.payload,
        assigneeIds: command.payload.assigneeIds || current.assigneeIds,
        version: current.version + 1,
        fieldVersions: nextFieldVersions(current.fieldVersions, fields),
        updatedBy: userId,
        updatedAt: now,
      };
      transaction.set(reference, this.storeCard(key, value));
      return this.change(
        revision,
        command.type,
        "card",
        value.id,
        false,
        value,
        userId,
        now,
      );
    }

    if (command.type === "moveCard") {
      const reference = this.entityRef(boardId, "cards", command.entityId);
      const current = this.toCard(
        key,
        boardId,
        await transaction.get(reference),
      );
      assertVersion(current.version, command.baseVersion);
      await this.assertColumn(transaction, boardId, command.payload.columnId);
      const value: KanbanCard = {
        ...current,
        columnId: command.payload.columnId,
        rank: await this.rankFor(
          transaction,
          boardId,
          "cards",
          command.payload.columnId,
          command.payload.beforeId,
          command.payload.afterId,
        ),
        version: current.version + 1,
        updatedBy: userId,
        updatedAt: now,
      };
      transaction.set(reference, this.storeCard(key, value));
      return this.change(
        revision,
        command.type,
        "card",
        value.id,
        false,
        value,
        userId,
        now,
      );
    }

    if (command.type === "deleteCard" || command.type === "restoreCard") {
      const reference = this.entityRef(boardId, "cards", command.entityId);
      const current = this.toCard(
        key,
        boardId,
        await transaction.get(reference),
      );
      assertVersion(current.version, command.baseVersion);
      const deleting = command.type === "deleteCard";
      const value: KanbanCard = {
        ...current,
        deletedAt: deleting ? now : null,
        version: current.version + 1,
        updatedBy: userId,
        updatedAt: now,
      };
      transaction.set(reference, this.storeCard(key, value));
      return this.change(
        revision,
        command.type,
        "card",
        value.id,
        deleting,
        value,
        userId,
        now,
      );
    }

    if (command.type === "createChecklistItem") {
      await this.assertCard(transaction, key, boardId, command.payload.cardId);
      const reference = this.entityRef(
        boardId,
        "checklistItems",
        command.entityId,
      );
      if ((await transaction.get(reference)).exists) {
        throw new CommandFailure(
          "rejected",
          "checklist_exists",
          "The item exists.",
        );
      }
      const rank = await this.rankFor(
        transaction,
        boardId,
        "checklistItems",
        command.payload.cardId,
        command.payload.beforeId,
        command.payload.afterId,
      );
      const value: KanbanChecklistItem = {
        id: command.entityId,
        boardId,
        cardId: command.payload.cardId,
        title: command.payload.title,
        rank,
        completed: false,
        version: 1,
        fieldVersions: { title: 1, completed: 1 },
        createdBy: userId,
        updatedBy: userId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      transaction.create(reference, this.storeChecklistItem(key, value));
      return this.change(
        revision,
        command.type,
        "checklist",
        value.id,
        false,
        value,
        userId,
        now,
      );
    }

    if (command.type === "updateChecklistItem") {
      const reference = this.entityRef(
        boardId,
        "checklistItems",
        command.entityId,
      );
      const current = this.toChecklistItem(
        key,
        boardId,
        await transaction.get(reference),
      );
      const fields = changedFields(command.payload);
      assertFieldVersions(
        current.fieldVersions,
        command.baseFieldVersions,
        fields,
      );
      const value: KanbanChecklistItem = {
        ...current,
        ...command.payload,
        version: current.version + 1,
        fieldVersions: nextFieldVersions(current.fieldVersions, fields),
        updatedBy: userId,
        updatedAt: now,
      };
      transaction.set(reference, this.storeChecklistItem(key, value));
      return this.change(
        revision,
        command.type,
        "checklist",
        value.id,
        false,
        value,
        userId,
        now,
      );
    }

    if (command.type === "moveChecklistItem") {
      const reference = this.entityRef(
        boardId,
        "checklistItems",
        command.entityId,
      );
      const current = this.toChecklistItem(
        key,
        boardId,
        await transaction.get(reference),
      );
      assertVersion(current.version, command.baseVersion);
      const value: KanbanChecklistItem = {
        ...current,
        rank: await this.rankFor(
          transaction,
          boardId,
          "checklistItems",
          current.cardId,
          command.payload.beforeId,
          command.payload.afterId,
        ),
        version: current.version + 1,
        updatedBy: userId,
        updatedAt: now,
      };
      transaction.set(reference, this.storeChecklistItem(key, value));
      return this.change(
        revision,
        command.type,
        "checklist",
        value.id,
        false,
        value,
        userId,
        now,
      );
    }

    if (
      command.type === "deleteChecklistItem" ||
      command.type === "restoreChecklistItem"
    ) {
      const reference = this.entityRef(
        boardId,
        "checklistItems",
        command.entityId,
      );
      const current = this.toChecklistItem(
        key,
        boardId,
        await transaction.get(reference),
      );
      assertVersion(current.version, command.baseVersion);
      const deleting = command.type === "deleteChecklistItem";
      const value: KanbanChecklistItem = {
        ...current,
        deletedAt: deleting ? now : null,
        version: current.version + 1,
        updatedBy: userId,
        updatedAt: now,
      };
      transaction.set(reference, this.storeChecklistItem(key, value));
      return this.change(
        revision,
        command.type,
        "checklist",
        value.id,
        deleting,
        value,
        userId,
        now,
      );
    }

    if (command.type === "createCanvasLink") {
      await this.assertCard(transaction, key, boardId, command.payload.cardId);
      const canvas = await transaction.get(
        this.firestore
          .collection("users")
          .doc(userId)
          .collection("canvases")
          .doc(command.payload.canvasId),
      );
      if (!canvas.exists) {
        throw new CommandFailure(
          "rejected",
          "canvas_not_found",
          "The canvas was not found.",
        );
      }
      const reference = this.entityRef(
        boardId,
        "canvasLinks",
        command.entityId,
      );
      const value = {
        id: command.entityId,
        boardId,
        cardId: command.payload.cardId,
        canvasId: command.payload.canvasId,
        state: "available" as const,
        createdAt: now,
      };
      transaction.create(reference, value);
      return this.change(
        revision,
        command.type,
        "canvasLink",
        value.id,
        false,
        value,
        userId,
        now,
      );
    }

    const reference = this.entityRef(boardId, "canvasLinks", command.entityId);
    if (!(await transaction.get(reference)).exists) {
      throw new CommandFailure(
        "rejected",
        "link_not_found",
        "The link was not found.",
      );
    }
    transaction.delete(reference);
    return this.change(
      revision,
      command.type,
      "canvasLink",
      command.entityId,
      true,
      { id: command.entityId },
      userId,
      now,
    );
  }

  private async deleteColumn(
    transaction: CommandTransaction,
    key: Buffer,
    boardId: string,
    userId: string,
    command: DeleteColumnCommand,
    revision: number,
    now: number,
    queryCache: QueryCache,
  ) {
    const reference = this.entityRef(boardId, "columns", command.entityId);
    const current = this.toColumn(
      key,
      boardId,
      await transaction.get(reference),
    );
    assertVersion(current.version, command.baseVersion);
    if (ORIGINAL_KANBAN_COLUMN_TITLES.includes(current.title)) {
      throw new CommandFailure(
        "rejected",
        "og_column_delete",
        "Original Kanban columns cannot be deleted.",
      );
    }
    const columnsKey = `columns:${boardId}`;
    const cardsKey = `cards:${boardId}:${command.entityId}`;

    const activeColumns = queryCache.get(columnsKey);
    if (!activeColumns) {
      throw new Error("Active Kanban columns were not prefetched");
    }
    if (activeColumns.size <= 1) {
      throw new CommandFailure(
        "rejected",
        "last_column",
        "A board must keep at least one column.",
      );
    }
    const cards = queryCache.get(cardsKey);
    if (!cards) {
      throw new Error("Kanban column cards were not prefetched");
    }
    if (!cards.empty && !command.payload.destinationColumnId) {
      throw new CommandFailure(
        "rejected",
        "column_not_empty",
        "Choose a destination for the column's cards.",
      );
    }
    if (command.payload.destinationColumnId) {
      await this.assertColumn(
        transaction,
        boardId,
        command.payload.destinationColumnId,
      );
      for (const cardSnapshot of cards.docs) {
        const card = this.toCard(key, boardId, cardSnapshot);
        transaction.set(
          cardSnapshot.ref,
          this.storeCard(key, {
            ...card,
            columnId: command.payload.destinationColumnId,
            version: card.version + 1,
            updatedBy: userId,
            updatedAt: now,
          }),
        );
      }
    }
    const value = {
      ...current,
      version: current.version + 1,
      updatedAt: now,
      deletedAt: now,
    };
    transaction.set(reference, this.storeColumn(key, value));
    return this.change(
      revision,
      command.type,
      "column",
      value.id,
      true,
      value,
      userId,
      now,
    );
  }

  private async rankFor(
    transaction: CommandTransaction,
    boardId: string,
    collection: "columns" | "cards" | "checklistItems",
    parentId: string | null,
    beforeId: string | null,
    afterId: string | null,
  ) {
    const getRank = async (id: string | null) => {
      if (!id) {
        return null;
      }
      const snapshot = await transaction.get(
        this.entityRef(boardId, collection, id),
      );
      if (!snapshot.exists || snapshot.data()?.deletedAt !== null) {
        throw new CommandFailure(
          "conflict",
          "invalid_neighbor",
          "The order changed.",
        );
      }
      if (
        (collection === "cards" && snapshot.data()?.columnId !== parentId) ||
        (collection === "checklistItems" &&
          snapshot.data()?.cardId !== parentId)
      ) {
        throw new CommandFailure(
          "conflict",
          "invalid_neighbor",
          "The order changed.",
        );
      }
      return String(snapshot.data()?.rank);
    };
    const beforeRank = await getRank(beforeId);
    const afterRank = await getRank(afterId);
    if (
      beforeRank !== null &&
      afterRank !== null &&
      compareRanks(beforeRank, afterRank) >= 0
    ) {
      throw new CommandFailure(
        "conflict",
        "invalid_neighbor",
        "The order changed.",
      );
    }
    return createRankBetween(beforeRank, afterRank);
  }

  private async assertColumn(
    transaction: CommandTransaction,
    boardId: string,
    columnId: string,
  ) {
    const snapshot = await transaction.get(
      this.entityRef(boardId, "columns", columnId),
    );
    if (!snapshot.exists || snapshot.data()?.deletedAt !== null) {
      throw new CommandFailure(
        "rejected",
        "column_not_found",
        "The column was not found.",
      );
    }
  }

  private async assertCard(
    transaction: CommandTransaction,
    key: Buffer,
    boardId: string,
    cardId: string,
  ) {
    const card = this.toCard(
      key,
      boardId,
      await transaction.get(this.entityRef(boardId, "cards", cardId)),
    );
    if (card.deletedAt !== null) {
      throw new CommandFailure(
        "rejected",
        "card_not_found",
        "The card was not found.",
      );
    }
  }

  private async assertAssignees(
    transaction: CommandTransaction,
    boardId: string,
    assigneeIds: string[],
  ) {
    const ids = unique(assigneeIds);
    if (ids.length === 0) {
      return;
    }
    const snapshots = await Promise.all(
      ids.map((id) => transaction.get(this.memberRef(boardId, id))),
    );
    if (snapshots.some((snapshot) => !snapshot.exists)) {
      throw new CommandFailure(
        "rejected",
        "invalid_assignee",
        "Assignees must be board members.",
      );
    }
  }

  async listMembers(userId: string, boardId: string) {
    await this.readMembership(userId, boardId);
    const members = await this.boardRef(boardId).collection("members").get();
    return members.docs.map((snapshot) => snapshot.data() as KanbanMember);
  }

  async updateMemberRole(
    userId: string,
    boardId: string,
    memberId: string,
    role: "editor" | "viewer",
  ) {
    const boardReference = this.boardRef(boardId);
    const actorReference = this.memberRef(boardId, userId);
    const targetReference = this.memberRef(boardId, memberId);
    const userReference = this.userBoardRef(memberId, boardId);
    return this.firestore.runTransaction(async (transaction) => {
      const [boardSnapshot, actorSnapshot, targetSnapshot] = await Promise.all([
        transaction.get(boardReference),
        transaction.get(actorReference),
        transaction.get(targetReference),
      ]);
      const board = requireData<StoredBoard>(
        boardSnapshot,
        "board_not_found",
        "The board was not found.",
      );
      const actor = requireData<KanbanMember>(
        actorSnapshot,
        "board_not_found",
        "The board was not found.",
      );
      const target = requireData<KanbanMember>(
        targetSnapshot,
        "member_not_found",
        "The member was not found.",
      );
      if (actor.role !== "owner") {
        throw new ApiError(
          403,
          "permission_denied",
          "Owner access is required.",
        );
      }
      if (target.role === "owner" || memberId === board.ownerId) {
        throw new ApiError(
          409,
          "owner_role_locked",
          "Transfer ownership first.",
        );
      }
      const next = {
        ...target,
        role,
        membershipVersion: target.membershipVersion + 1,
        updatedAt: Date.now(),
      };
      transaction.set(targetReference, next);
      transaction.set(userReference, {
        boardId,
        role,
        updatedAt: next.updatedAt,
      });
      return next;
    });
  }

  async removeMember(userId: string, boardId: string, memberId: string) {
    const boardReference = this.boardRef(boardId);
    const actorReference = this.memberRef(boardId, userId);
    const targetReference = this.memberRef(boardId, memberId);
    await this.firestore.runTransaction(async (transaction) => {
      const [boardSnapshot, actorSnapshot, targetSnapshot] = await Promise.all([
        transaction.get(boardReference),
        transaction.get(actorReference),
        transaction.get(targetReference),
      ]);
      const board = requireData<StoredBoard>(
        boardSnapshot,
        "board_not_found",
        "The board was not found.",
      );
      const actor = requireData<KanbanMember>(
        actorSnapshot,
        "board_not_found",
        "The board was not found.",
      );
      const target = requireData<KanbanMember>(
        targetSnapshot,
        "member_not_found",
        "The member was not found.",
      );
      const selfLeaving = userId === memberId;
      if (!selfLeaving && actor.role !== "owner") {
        throw new ApiError(
          403,
          "permission_denied",
          "Owner access is required.",
        );
      }
      if (target.role === "owner" || memberId === board.ownerId) {
        throw new ApiError(
          409,
          "owner_cannot_leave",
          "Transfer ownership first.",
        );
      }
      transaction.delete(targetReference);
      transaction.delete(this.userBoardRef(memberId, boardId));
    });
  }

  async transferOwnership(
    userId: string,
    boardId: string,
    targetUserId: string,
  ) {
    if (userId === targetUserId) {
      throw new ApiError(
        400,
        "owner_unchanged",
        "Choose another board member.",
      );
    }
    const boardReference = this.boardRef(boardId);
    const actorReference = this.memberRef(boardId, userId);
    const targetReference = this.memberRef(boardId, targetUserId);
    return this.firestore.runTransaction(async (transaction) => {
      const [boardSnapshot, actorSnapshot, targetSnapshot] = await Promise.all([
        transaction.get(boardReference),
        transaction.get(actorReference),
        transaction.get(targetReference),
      ]);
      const board = requireData<StoredBoard>(
        boardSnapshot,
        "board_not_found",
        "The board was not found.",
      );
      const actor = requireData<KanbanMember>(
        actorSnapshot,
        "board_not_found",
        "The board was not found.",
      );
      const target = requireData<KanbanMember>(
        targetSnapshot,
        "member_not_found",
        "The target must already be a board member.",
      );
      if (actor.role !== "owner" || board.ownerId !== userId) {
        throw new ApiError(
          403,
          "permission_denied",
          "Owner access is required.",
        );
      }
      const now = Date.now();
      const previousOwner: KanbanMember = {
        ...actor,
        role: "editor",
        membershipVersion: actor.membershipVersion + 1,
        updatedAt: now,
      };
      const owner: KanbanMember = {
        ...target,
        role: "owner",
        membershipVersion: target.membershipVersion + 1,
        updatedAt: now,
      };
      transaction.update(boardReference, {
        ownerId: targetUserId,
        updatedAt: now,
      });
      transaction.set(actorReference, previousOwner);
      transaction.set(targetReference, owner);
      transaction.set(this.userBoardRef(userId, boardId), {
        boardId,
        role: "editor",
        updatedAt: now,
      });
      transaction.set(this.userBoardRef(targetUserId, boardId), {
        boardId,
        role: "owner",
        updatedAt: now,
      });
      transaction.create(boardReference.collection("audit").doc(), {
        actorId: userId,
        action: "ownership_transfer",
        targetUserId,
        createdAt: now,
      });
      return { previousOwner, owner };
    });
  }

  async createInvitation(
    userId: string,
    boardId: string,
    input: { email: string; role: "editor" | "viewer"; expiresInHours: number },
  ) {
    const email = normalizeEmail(input.email);
    const token = randomBytes(32).toString("base64url");
    const tokenDigest = this.crypto.invitationDigest(token);
    const emailDigest = this.crypto.emailDigest(email);
    const invitationId = randomUUID();
    const now = Date.now();
    const expiresAt = now + input.expiresInHours * 3_600_000;
    const boardReference = this.boardRef(boardId);
    const invitationReference = boardReference
      .collection("invitations")
      .doc(invitationId);
    const tokenReference = this.firestore
      .collection("kanbanInvitationTokens")
      .doc(tokenDigest);
    const rateReference = this.firestore
      .collection("kanbanRateLimits")
      .doc(`invite_${userId}_${boardId}`);
    let invitation!: KanbanInvitation;
    await this.firestore.runTransaction(async (transaction) => {
      const pendingInvitations = boardReference
        .collection("invitations")
        .where("emailDigest", "==", emailDigest)
        .where("status", "==", "pending")
        .limit(1);
      const [boardSnapshot, actorSnapshot, existingInvitation, rateSnapshot] =
        await Promise.all([
          transaction.get(boardReference),
          transaction.get(this.memberRef(boardId, userId)),
          transaction.get(pendingInvitations),
          transaction.get(rateReference),
        ]);
      const board = requireData<StoredBoard>(
        boardSnapshot,
        "board_not_found",
        "The board was not found.",
      );
      const actor = requireData<KanbanMember>(
        actorSnapshot,
        "board_not_found",
        "The board was not found.",
      );
      if (actor.role !== "owner") {
        throw new ApiError(
          403,
          "permission_denied",
          "Owner access is required.",
        );
      }
      if (!existingInvitation.empty) {
        const existing = existingInvitation.docs[0]!;
        const existingData = existing.data() as StoredInvitation;
        if (existingData.expiresAt > now) {
          throw new ApiError(
            409,
            "invitation_already_pending",
            "An active invitation already exists for this email.",
          );
        }
        transaction.update(existing.ref, { status: "expired" });
        transaction.delete(
          this.firestore
            .collection("kanbanInvitationTokens")
            .doc(existingData.tokenDigest),
        );
      }
      const currentRate = rateSnapshot.data() as
        { windowStartedAt?: number; count?: number } | undefined;
      const withinWindow =
        typeof currentRate?.windowStartedAt === "number" &&
        now - currentRate.windowStartedAt < 3_600_000;
      const count = withinWindow ? Number(currentRate?.count || 0) : 0;
      if (count >= this.retention.invitesPerHour) {
        throw new ApiError(
          429,
          "invitation_rate_limited",
          "Too many invitations were created. Try again later.",
        );
      }
      const key = this.boardKey(boardId, board);
      invitation = {
        id: invitationId,
        boardId,
        email,
        role: input.role,
        status: "pending",
        createdBy: userId,
        createdAt: now,
        expiresAt,
        acceptedBy: null,
        acceptedAt: null,
      };
      const stored: StoredInvitation = {
        boardId,
        emailDigest,
        encryptedPayload: this.crypto.encryptJson(
          key,
          boardId,
          "invitation",
          invitationId,
          { email },
        ),
        role: input.role,
        status: "pending",
        tokenDigest,
        createdBy: userId,
        createdAt: now,
        expiresAt,
        acceptedBy: null,
        acceptedAt: null,
      };
      transaction.create(invitationReference, stored);
      transaction.create(tokenReference, {
        boardId,
        invitationId,
        expiresAt: new Date(expiresAt),
      });
      transaction.set(rateReference, {
        windowStartedAt: withinWindow
          ? Number(currentRate?.windowStartedAt)
          : now,
        count: count + 1,
        expiresAt: new Date(now + 7_200_000),
      });
    });
    return { invitation, token };
  }

  async inspectInvitation(token: string) {
    const { boardId, board, invitation, key } =
      await this.readInvitation(token);
    this.assertInvitationPending(invitation);
    const payload = this.crypto.decryptJson<KanbanBoardPayload>(
      key,
      boardId,
      "board",
      boardId,
      board.encryptedPayload,
    );
    return {
      boardTitle: payload.title,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  }

  async acceptInvitation(
    user: { id: string; email: string | null; emailVerified: boolean },
    token: string,
  ) {
    if (!user.email || !user.emailVerified) {
      throw new ApiError(
        403,
        "verified_email_required",
        "A verified email is required.",
      );
    }
    const tokenDigest = this.crypto.invitationDigest(token);
    const tokenReference = this.firestore
      .collection("kanbanInvitationTokens")
      .doc(tokenDigest);
    const lookup = requireData<{ boardId: string; invitationId: string }>(
      await tokenReference.get(),
      "invitation_invalid",
      "The invitation is invalid or expired.",
    );
    const boardReference = this.boardRef(lookup.boardId);
    const invitationReference = boardReference
      .collection("invitations")
      .doc(lookup.invitationId);
    await this.firestore.runTransaction(async (transaction) => {
      const [boardSnapshot, invitationSnapshot, memberSnapshot] =
        await Promise.all([
          transaction.get(boardReference),
          transaction.get(invitationReference),
          transaction.get(this.memberRef(lookup.boardId, user.id)),
        ]);
      requireData<StoredBoard>(
        boardSnapshot,
        "invitation_invalid",
        "The invitation is invalid or expired.",
      );
      const invitation = requireData<StoredInvitation>(
        invitationSnapshot,
        "invitation_invalid",
        "The invitation is invalid or expired.",
      );
      this.assertInvitationPending(invitation);
      if (
        !this.crypto.secureDigestMatches(
          invitation.emailDigest,
          this.crypto.emailDigest(user.email!),
        )
      ) {
        throw new ApiError(
          403,
          "invitation_email_mismatch",
          "Use the invited email address.",
        );
      }
      const now = Date.now();
      const existingMember = memberSnapshot.exists
        ? (memberSnapshot.data() as KanbanMember)
        : null;
      const member: KanbanMember = existingMember
        ? {
            ...existingMember,
            role:
              existingMember.role === "owner" || invitation.role === "editor"
                ? existingMember.role === "owner"
                  ? "owner"
                  : "editor"
                : existingMember.role,
            membershipVersion:
              existingMember.role === "viewer" && invitation.role === "editor"
                ? existingMember.membershipVersion + 1
                : existingMember.membershipVersion,
            updatedAt: now,
          }
        : {
            userId: user.id,
            role: invitation.role,
            membershipVersion: 1,
            invitedBy: invitation.createdBy,
            joinedAt: now,
            updatedAt: now,
          };
      transaction.set(this.memberRef(lookup.boardId, user.id), member);
      transaction.set(this.userBoardRef(user.id, lookup.boardId), {
        boardId: lookup.boardId,
        role: member.role,
        updatedAt: now,
      });
      transaction.update(invitationReference, {
        status: "accepted",
        acceptedBy: user.id,
        acceptedAt: now,
      });
      transaction.delete(tokenReference);
    });
    return (await this.listBoards(user.id)).find(
      (board) => board.id === lookup.boardId,
    )!;
  }

  async revokeInvitation(
    userId: string,
    boardId: string,
    invitationId: string,
  ) {
    const boardReference = this.boardRef(boardId);
    const invitationReference = boardReference
      .collection("invitations")
      .doc(invitationId);
    await this.firestore.runTransaction(async (transaction) => {
      const [actorSnapshot, invitationSnapshot] = await Promise.all([
        transaction.get(this.memberRef(boardId, userId)),
        transaction.get(invitationReference),
      ]);
      const actor = requireData<KanbanMember>(
        actorSnapshot,
        "board_not_found",
        "The board was not found.",
      );
      const invitation = requireData<StoredInvitation>(
        invitationSnapshot,
        "invitation_not_found",
        "The invitation was not found.",
      );
      if (actor.role !== "owner") {
        throw new ApiError(
          403,
          "permission_denied",
          "Owner access is required.",
        );
      }
      transaction.update(invitationReference, { status: "revoked" });
      transaction.delete(
        this.firestore
          .collection("kanbanInvitationTokens")
          .doc(invitation.tokenDigest),
      );
    });
  }

  private async readInvitation(token: string) {
    const digest = this.crypto.invitationDigest(token);
    const lookup = requireData<{ boardId: string; invitationId: string }>(
      await this.firestore
        .collection("kanbanInvitationTokens")
        .doc(digest)
        .get(),
      "invitation_invalid",
      "The invitation is invalid or expired.",
    );
    const [boardSnapshot, invitationSnapshot] = await Promise.all([
      this.boardRef(lookup.boardId).get(),
      this.boardRef(lookup.boardId)
        .collection("invitations")
        .doc(lookup.invitationId)
        .get(),
    ]);
    const board = requireData<StoredBoard>(
      boardSnapshot,
      "invitation_invalid",
      "The invitation is invalid or expired.",
    );
    const invitation = requireData<StoredInvitation>(
      invitationSnapshot,
      "invitation_invalid",
      "The invitation is invalid or expired.",
    );
    return {
      boardId: lookup.boardId,
      invitationId: lookup.invitationId,
      board,
      invitation,
      key: this.boardKey(lookup.boardId, board),
    };
  }

  private assertInvitationPending(invitation: StoredInvitation) {
    if (invitation.status !== "pending" || invitation.expiresAt <= Date.now()) {
      throw new ApiError(
        404,
        "invitation_invalid",
        "The invitation is invalid or expired.",
      );
    }
  }

  private createStoredEvent(
    key: Buffer,
    boardId: string,
    revision: number,
    type: string,
    entityType: EntityType,
    entityId: string,
    deleted: boolean,
    value: unknown,
    actorId: string,
    createdAt: number,
  ): StoredEvent {
    return {
      revision,
      type,
      entityType,
      entityId,
      deleted,
      encryptedValue: this.crypto.encryptJson(
        key,
        boardId,
        "event",
        eventId(revision),
        value,
      ),
      actorId,
      createdAt,
      expiresAt: new Date(createdAt + this.retention.eventMs),
    };
  }

  private change(
    revision: number,
    type: string,
    entityType: EntityType,
    entityId: string,
    deleted: boolean,
    value: unknown,
    actorId: string,
    createdAt: number,
  ): KanbanChange {
    return {
      revision,
      type,
      entityType,
      entityId,
      deleted,
      value,
      actorId,
      createdAt,
    };
  }

  private storeColumn(key: Buffer, column: KanbanColumn) {
    return {
      boardId: column.boardId,
      rank: column.rank,
      version: column.version,
      createdAt: column.createdAt,
      updatedAt: column.updatedAt,
      deletedAt: column.deletedAt,
      encryptedPayload: this.crypto.encryptJson(
        key,
        column.boardId,
        "column",
        column.id,
        { title: column.title },
      ),
    };
  }

  private toColumn(
    key: Buffer,
    boardId: string,
    snapshot: CommandDocumentSnapshot,
  ): KanbanColumn {
    const data = requireData<DocumentData>(
      snapshot,
      "column_not_found",
      "The column was not found.",
    );
    const payload = this.crypto.decryptJson<KanbanColumnPayload>(
      key,
      boardId,
      "column",
      snapshot.id,
      (data as StoredEntity).encryptedPayload,
    );
    return {
      id: snapshot.id,
      boardId,
      ...payload,
      rank: String(data.rank),
      version: Number(data.version),
      createdAt: Number(data.createdAt),
      updatedAt: Number(data.updatedAt),
      deletedAt: typeof data.deletedAt === "number" ? data.deletedAt : null,
    };
  }

  private storeCard(key: Buffer, card: KanbanCard) {
    const payload: KanbanCardPayload = {
      title: card.title,
      description: card.description,
      priority: card.priority,
      progress: card.progress,
      dueDate: card.dueDate,
      legacyAssigneeText: card.legacyAssigneeText,
      legacyCanvasTags: card.legacyCanvasTags,
    };
    return {
      boardId: card.boardId,
      columnId: card.columnId,
      rank: card.rank,
      version: card.version,
      fieldVersions: card.fieldVersions,
      assigneeIds: card.assigneeIds,
      createdBy: card.createdBy,
      updatedBy: card.updatedBy,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      deletedAt: card.deletedAt,
      encryptedPayload: this.crypto.encryptJson(
        key,
        card.boardId,
        "card",
        card.id,
        payload,
      ),
    };
  }

  private toCard(
    key: Buffer,
    boardId: string,
    snapshot: CommandDocumentSnapshot,
  ): KanbanCard {
    const data = requireData<DocumentData>(
      snapshot,
      "card_not_found",
      "The card was not found.",
    );
    const payload = this.crypto.decryptJson<KanbanCardPayload>(
      key,
      boardId,
      "card",
      snapshot.id,
      (data as StoredEntity).encryptedPayload,
    );
    return {
      id: snapshot.id,
      boardId,
      ...payload,
      columnId: String(data.columnId),
      rank: String(data.rank),
      version: Number(data.version),
      fieldVersions: (data.fieldVersions || {}) as Record<string, number>,
      assigneeIds: Array.isArray(data.assigneeIds)
        ? data.assigneeIds.map(String)
        : [],
      createdBy: String(data.createdBy),
      updatedBy: String(data.updatedBy),
      createdAt: Number(data.createdAt),
      updatedAt: Number(data.updatedAt),
      deletedAt: typeof data.deletedAt === "number" ? data.deletedAt : null,
    };
  }

  private storeChecklistItem(key: Buffer, item: KanbanChecklistItem) {
    const payload: KanbanChecklistPayload = { title: item.title };
    return {
      boardId: item.boardId,
      cardId: item.cardId,
      rank: item.rank,
      completed: item.completed,
      version: item.version,
      fieldVersions: item.fieldVersions,
      createdBy: item.createdBy,
      updatedBy: item.updatedBy,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      deletedAt: item.deletedAt,
      encryptedPayload: this.crypto.encryptJson(
        key,
        item.boardId,
        "checklist",
        item.id,
        payload,
      ),
    };
  }

  private toChecklistItem(
    key: Buffer,
    boardId: string,
    snapshot: CommandDocumentSnapshot,
  ): KanbanChecklistItem {
    const data = requireData<DocumentData>(
      snapshot,
      "checklist_not_found",
      "The checklist item was not found.",
    );
    const payload = this.crypto.decryptJson<KanbanChecklistPayload>(
      key,
      boardId,
      "checklist",
      snapshot.id,
      (data as StoredEntity).encryptedPayload,
    );
    return {
      id: snapshot.id,
      boardId,
      ...payload,
      cardId: String(data.cardId),
      rank: String(data.rank),
      completed: Boolean(data.completed),
      version: Number(data.version),
      fieldVersions: (data.fieldVersions || {}) as Record<string, number>,
      createdBy: String(data.createdBy),
      updatedBy: String(data.updatedBy),
      createdAt: Number(data.createdAt),
      updatedAt: Number(data.updatedAt),
      deletedAt: typeof data.deletedAt === "number" ? data.deletedAt : null,
    };
  }

  private async resolveCanvasLinks(
    userId: string,
    boardId: string,
    links: DocumentSnapshot<DocumentData>[],
  ): Promise<KanbanCanvasLink[]> {
    if (links.length === 0) {
      return [];
    }
    const canvases = await this.firestore.getAll(
      ...links.map((link) =>
        this.firestore
          .collection("users")
          .doc(userId)
          .collection("canvases")
          .doc(String(link.data()?.canvasId)),
      ),
    );
    return links.map((link, index) => {
      const data = link.data()!;
      const canvas = canvases[index];
      return {
        id: link.id,
        boardId,
        cardId: String(data.cardId),
        canvasId: String(data.canvasId),
        state: canvas?.exists ? "available" : "restricted",
        ...(canvas?.exists
          ? { title: String(canvas.data()?.title || "Untitled") }
          : {}),
        createdAt: Number(data.createdAt),
      };
    });
  }
}
