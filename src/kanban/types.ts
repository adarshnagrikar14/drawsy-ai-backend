export type KanbanRole = "owner" | "editor" | "viewer";

export type KanbanPriority = "low" | "medium" | "high" | null;

export type KanbanEncryptedPayload = {
  version: 1;
  keyVersion: number;
  iv: string;
  authTag: string;
  ciphertext: string;
};

export type KanbanBoardPayload = {
  title: string;
  roughness: 0 | 1 | 2;
  cardRadius: 0 | 1 | 2;
  isLocked: boolean;
};

export type KanbanColumnPayload = {
  title: string;
};

export type KanbanCardPayload = {
  title: string;
  description: string;
  priority: KanbanPriority;
  progress: number;
  dueDate: string | null;
  legacyAssigneeText: string | null;
  legacyCanvasTags: string[];
};

export type KanbanChecklistPayload = {
  title: string;
};

export type KanbanBoard = KanbanBoardPayload & {
  id: string;
  schemaVersion: 2;
  ownerId: string;
  role: KanbanRole;
  revision: number;
  status: "active" | "trashed";
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
};

export type KanbanColumn = KanbanColumnPayload & {
  id: string;
  boardId: string;
  rank: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type KanbanCard = KanbanCardPayload & {
  id: string;
  boardId: string;
  columnId: string;
  rank: string;
  version: number;
  fieldVersions: Record<string, number>;
  assigneeIds: string[];
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type KanbanChecklistItem = KanbanChecklistPayload & {
  id: string;
  boardId: string;
  cardId: string;
  rank: string;
  completed: boolean;
  version: number;
  fieldVersions: Record<string, number>;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type KanbanCanvasLink = {
  id: string;
  boardId: string;
  cardId: string;
  canvasId: string;
  state: "available" | "restricted";
  title?: string;
  createdAt: number;
};

export type KanbanMember = {
  userId: string;
  role: KanbanRole;
  membershipVersion: number;
  invitedBy: string | null;
  joinedAt: number;
  updatedAt: number;
};

export type KanbanBoardSummary = Pick<
  KanbanBoard,
  "id" | "title" | "role" | "revision" | "status" | "updatedAt"
>;

export type KanbanSnapshot = {
  board: KanbanBoard;
  columns: KanbanColumn[];
  cards: KanbanCard[];
  checklistItems: KanbanChecklistItem[];
  canvasLinks: KanbanCanvasLink[];
  members: KanbanMember[];
};

export type KanbanChange = {
  revision: number;
  type: string;
  entityType: "board" | "column" | "card" | "checklist" | "canvasLink";
  entityId: string;
  deleted: boolean;
  value: unknown;
  actorId: string;
  createdAt: number;
};

type CommandBase = {
  operationId: string;
  clientSequence: number;
  knownBoardRevision: number;
};

export type KanbanCommand = CommandBase &
  (
    | {
        type: "updateBoard";
        payload: Partial<KanbanBoardPayload>;
      }
    | {
        type: "createColumn";
        entityId: string;
        payload: KanbanColumnPayload & {
          beforeId: string | null;
          afterId: string | null;
        };
      }
    | {
        type: "updateColumn";
        entityId: string;
        baseVersion: number;
        payload: Partial<KanbanColumnPayload>;
      }
    | {
        type: "moveColumn";
        entityId: string;
        baseVersion: number;
        payload: {
          beforeId: string | null;
          afterId: string | null;
          title?: string;
        };
      }
    | {
        type: "deleteColumn" | "restoreColumn";
        entityId: string;
        baseVersion: number;
        payload: { destinationColumnId: string | null };
      }
    | {
        type: "createCard";
        entityId: string;
        payload: KanbanCardPayload & {
          columnId: string;
          assigneeIds: string[];
          beforeId: string | null;
          afterId: string | null;
        };
      }
    | {
        type: "updateCard";
        entityId: string;
        baseFieldVersions: Record<string, number>;
        payload: Partial<KanbanCardPayload> & { assigneeIds?: string[] };
      }
    | {
        type: "moveCard";
        entityId: string;
        baseVersion: number;
        payload: {
          columnId: string;
          beforeId: string | null;
          afterId: string | null;
        };
      }
    | {
        type: "deleteCard" | "restoreCard";
        entityId: string;
        baseVersion: number;
        payload: Record<string, never>;
      }
    | {
        type: "createChecklistItem";
        entityId: string;
        payload: KanbanChecklistPayload & {
          cardId: string;
          beforeId: string | null;
          afterId: string | null;
        };
      }
    | {
        type: "updateChecklistItem";
        entityId: string;
        baseFieldVersions: Record<string, number>;
        payload: Partial<KanbanChecklistPayload> & { completed?: boolean };
      }
    | {
        type: "moveChecklistItem";
        entityId: string;
        baseVersion: number;
        payload: {
          beforeId: string | null;
          afterId: string | null;
        };
      }
    | {
        type: "deleteChecklistItem" | "restoreChecklistItem";
        entityId: string;
        baseVersion: number;
        payload: Record<string, never>;
      }
    | {
        type: "createCanvasLink";
        entityId: string;
        payload: { cardId: string; canvasId: string };
      }
    | {
        type: "deleteCanvasLink";
        entityId: string;
        payload: Record<string, never>;
      }
  );

export type KanbanCommandResult = {
  operationId: string;
  status: "applied" | "duplicate" | "conflict" | "rejected";
  revision: number;
  code?: string;
  message?: string;
  change?: KanbanChange;
};

export type KanbanRealtimeEvent =
  | { type: "revision"; latestRevision: number }
  | { type: "role_changed"; role: KanbanRole; membershipVersion: number }
  | { type: "access_revoked" };

export type KanbanInvitation = {
  id: string;
  boardId: string;
  email: string;
  role: Exclude<KanbanRole, "owner">;
  status: "pending" | "accepted" | "revoked" | "expired";
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedBy: string | null;
  acceptedAt: number | null;
};

export interface KanbanService {
  listBoards(userId: string): Promise<KanbanBoardSummary[]>;
  createBoard(
    userId: string,
    input: {
      id: string;
      title: string;
      initialColumnId?: string;
      initialColumnTitle?: string;
      columns?: Array<{ id: string; title: string }>;
    },
  ): Promise<KanbanSnapshot>;
  getSnapshot(userId: string, boardId: string): Promise<KanbanSnapshot>;
  getChanges(
    userId: string,
    boardId: string,
    afterRevision: number,
  ): Promise<{ changes: KanbanChange[]; latestRevision: number }>;
  applyCommands(
    userId: string,
    boardId: string,
    clientId: string,
    commands: KanbanCommand[],
  ): Promise<KanbanCommandResult[]>;
  listMembers(userId: string, boardId: string): Promise<KanbanMember[]>;
  updateMemberRole(
    userId: string,
    boardId: string,
    memberId: string,
    role: Exclude<KanbanRole, "owner">,
  ): Promise<KanbanMember>;
  removeMember(
    userId: string,
    boardId: string,
    memberId: string,
  ): Promise<void>;
  transferOwnership(
    userId: string,
    boardId: string,
    targetUserId: string,
  ): Promise<{ previousOwner: KanbanMember; owner: KanbanMember }>;
  createInvitation(
    userId: string,
    boardId: string,
    input: { email: string; role: "editor" | "viewer"; expiresInHours: number },
  ): Promise<{ invitation: KanbanInvitation; token: string }>;
  inspectInvitation(token: string): Promise<{
    boardTitle: string;
    role: "editor" | "viewer";
    expiresAt: number;
  }>;
  acceptInvitation(
    user: { id: string; email: string | null; emailVerified: boolean },
    token: string,
  ): Promise<KanbanBoardSummary>;
  revokeInvitation(
    userId: string,
    boardId: string,
    invitationId: string,
  ): Promise<void>;
  getRealtimeState(
    userId: string,
    boardId: string,
  ): Promise<{ latestRevision: number; member: KanbanMember }>;
  subscribeToRealtime(
    userId: string,
    boardId: string,
    listener: (event: KanbanRealtimeEvent) => void,
    onError: (error: Error) => void,
  ): () => void;
}
