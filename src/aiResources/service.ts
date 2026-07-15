import { randomUUID } from "node:crypto";

import { ApiError } from "../http/apiError.js";
import { AiResourceGrantSigner } from "./grant.js";

import type { JiraService } from "../jira/types.js";
import type {
  KanbanCard,
  KanbanChecklistItem,
  KanbanCommand,
  KanbanService,
  KanbanSnapshot,
} from "../kanban/types.js";
import type {
  AiResourceExecutionRequest,
  AiResourceGrantRequest,
  AiResourceId,
  AiResourceService,
} from "./types.js";

type KanbanExecutionRequest = Extract<
  AiResourceExecutionRequest,
  { operation: `kanban_${string}` }
>;
type JiraExecutionRequest = Extract<
  AiResourceExecutionRequest,
  { operation: `jira_${string}` }
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textFromAdf = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textFromAdf).filter(Boolean).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  const ownText = typeof value.text === "string" ? value.text : "";
  const content = textFromAdf(value.content);
  const suffix =
    value.type === "paragraph" ||
    value.type === "heading" ||
    value.type === "listItem" ||
    value.type === "hardBreak"
      ? "\n"
      : "";
  return `${ownText}${content}${suffix}`;
};

const clippedText = (value: unknown, limit = 20_000) => {
  const text = textFromAdf(value)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
};

const recordValue = (value: unknown, key: string) =>
  isRecord(value) ? value[key] : undefined;

const stringValue = (value: unknown) =>
  typeof value === "string" ? value : null;

const normalizeJiraIssue = (value: unknown, includeBody = false) => {
  const issue = isRecord(value) ? value : {};
  const fields = isRecord(issue.fields) ? issue.fields : {};
  const status = isRecord(fields.status) ? fields.status : {};
  const priority = isRecord(fields.priority) ? fields.priority : {};
  const assignee = isRecord(fields.assignee) ? fields.assignee : {};
  const issueType = isRecord(fields.issuetype) ? fields.issuetype : {};
  const commentsValue = isRecord(fields.comment) ? fields.comment.comments : [];
  const comments = Array.isArray(commentsValue)
    ? commentsValue.slice(-20).map((comment) => {
        const item = isRecord(comment) ? comment : {};
        const author = isRecord(item.author) ? item.author : {};
        return {
          id: stringValue(item.id),
          author: stringValue(author.displayName),
          body: clippedText(item.body, 8_000),
          createdAt: stringValue(item.created),
          updatedAt: stringValue(item.updated),
        };
      })
    : [];
  return {
    id: stringValue(issue.id),
    key: stringValue(issue.key),
    summary: stringValue(fields.summary),
    status: stringValue(status.name),
    statusCategory: stringValue(
      recordValue(status, "statusCategory")
        ? recordValue(recordValue(status, "statusCategory"), "key")
        : null,
    ),
    issueType: stringValue(issueType.name),
    priority: stringValue(priority.name),
    assignee: stringValue(assignee.displayName),
    updatedAt: stringValue(fields.updated),
    createdAt: stringValue(fields.created),
    ...(includeBody
      ? {
          description: clippedText(fields.description),
          comments,
          url: stringValue(issue.self),
        }
      : {}),
  };
};

const activeKanbanSnapshot = (snapshot: KanbanSnapshot) => ({
  board: snapshot.board,
  columns: snapshot.columns.filter((column) => column.deletedAt === null),
  cards: snapshot.cards.filter((card) => card.deletedAt === null),
  checklistItems: snapshot.checklistItems.filter(
    (item) => item.deletedAt === null,
  ),
  canvasLinks: snapshot.canvasLinks,
  members: snapshot.members,
});

const generatedId = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;

export class DefaultAiResourceService implements AiResourceService {
  private readonly signer: AiResourceGrantSigner;

  constructor(
    key: Buffer,
    ttlMs: number,
    private readonly maxOutputBytes: number,
    private readonly kanban: KanbanService,
    private readonly jira?: JiraService,
  ) {
    this.signer = new AiResourceGrantSigner(key, ttlMs);
  }

  createGrant(userId: string, request: AiResourceGrantRequest) {
    if (request.resources.includes("jira") && !this.jira) {
      throw new ApiError(
        503,
        "jira_unavailable",
        "Jira is not configured for this Drawsy workspace.",
      );
    }
    const { grant, claims } = this.signer.issue(userId, request);
    return {
      grant,
      expiresAt: claims.expiresAt,
      resources: claims.resources,
    };
  }

  async execute(grant: string, request: AiResourceExecutionRequest) {
    const claims = this.signer.verify(grant);
    if (
      claims.sessionId !== request.sessionId ||
      claims.turnId !== request.turnId
    ) {
      throw new ApiError(
        403,
        "resource_ai_scope_mismatch",
        "This Drawsy resource grant belongs to another AI turn.",
      );
    }
    const resource: AiResourceId = request.operation.startsWith("kanban_")
      ? "kanban"
      : "jira";
    if (!claims.resources.includes(resource)) {
      throw new ApiError(
        403,
        "resource_ai_not_attached",
        `The ${resource} resource was not attached to this turn.`,
      );
    }
    const result =
      resource === "kanban"
        ? await this.executeKanban(
            claims.subject,
            request as KanbanExecutionRequest,
          )
        : await this.executeJira(
            claims.subject,
            request as JiraExecutionRequest,
          );
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") > this.maxOutputBytes
    ) {
      throw new ApiError(
        413,
        "resource_ai_response_too_large",
        "The Drawsy resource returned too much data. Narrow the request.",
      );
    }
    return result;
  }

  private async executeKanban(userId: string, request: KanbanExecutionRequest) {
    if (request.operation === "kanban_list_boards") {
      return { boards: await this.kanban.listBoards(userId) };
    }
    const snapshot = await this.kanban.getSnapshot(userId, request.boardId);
    if (request.operation === "kanban_read_board") {
      return { snapshot: activeKanbanSnapshot(snapshot) };
    }
    if (snapshot.board.role === "viewer") {
      throw new ApiError(
        403,
        "permission_denied",
        "Editor access is required to change this Kanban board.",
      );
    }

    if (request.operation === "kanban_create_card") {
      this.requireColumn(snapshot, request.columnId);
      const cardId = generatedId("aicard");
      const result = await this.applyKanbanCommand(userId, snapshot, {
        operationId: generatedId("aiop"),
        clientSequence: 0,
        knownBoardRevision: snapshot.board.revision,
        type: "createCard",
        entityId: cardId,
        payload: {
          title: request.title,
          description: request.description ?? "",
          priority: request.priority ?? null,
          progress: request.progress ?? 0,
          dueDate: request.dueDate ?? null,
          legacyAssigneeText: null,
          legacyCanvasTags: [],
          columnId: request.columnId,
          assigneeIds: request.assigneeIds ?? [],
          beforeId: null,
          afterId: null,
        },
      });
      let canvasLink = null;
      if (request.linkCanvasId) {
        canvasLink = await this.linkCanvas(
          userId,
          request.boardId,
          cardId,
          request.linkCanvasId,
        );
      }
      return { cardId, result, canvasLink };
    }

    if (request.operation === "kanban_update_card") {
      const card = this.requireCard(snapshot, request.cardId);
      const payload = Object.fromEntries(
        Object.entries({
          title: request.title,
          description: request.description,
          priority: request.priority,
          progress: request.progress,
          dueDate: request.dueDate,
          assigneeIds: request.assigneeIds,
        }).filter(([, value]) => value !== undefined),
      );
      const fields = Object.keys(payload);
      return {
        result: await this.applyKanbanCommand(userId, snapshot, {
          operationId: generatedId("aiop"),
          clientSequence: 0,
          knownBoardRevision: snapshot.board.revision,
          type: "updateCard",
          entityId: card.id,
          baseFieldVersions: Object.fromEntries(
            fields.map((field) => [field, card.fieldVersions[field] ?? 0]),
          ),
          payload,
        } as KanbanCommand),
      };
    }

    if (request.operation === "kanban_move_card") {
      const card = this.requireCard(snapshot, request.cardId);
      this.requireColumn(snapshot, request.columnId);
      return {
        result: await this.applyKanbanCommand(userId, snapshot, {
          operationId: generatedId("aiop"),
          clientSequence: 0,
          knownBoardRevision: snapshot.board.revision,
          type: "moveCard",
          entityId: card.id,
          baseVersion: card.version,
          payload: {
            columnId: request.columnId,
            beforeId: null,
            afterId: null,
          },
        }),
      };
    }

    if (request.operation === "kanban_create_checklist_item") {
      this.requireCard(snapshot, request.cardId);
      const itemId = generatedId("aicheck");
      return {
        itemId,
        result: await this.applyKanbanCommand(userId, snapshot, {
          operationId: generatedId("aiop"),
          clientSequence: 0,
          knownBoardRevision: snapshot.board.revision,
          type: "createChecklistItem",
          entityId: itemId,
          payload: {
            cardId: request.cardId,
            title: request.title,
            beforeId: null,
            afterId: null,
          },
        }),
      };
    }

    if (request.operation === "kanban_update_checklist_item") {
      const item = this.requireChecklistItem(snapshot, request.itemId);
      const payload = Object.fromEntries(
        Object.entries({
          title: request.title,
          completed: request.completed,
        }).filter(([, value]) => value !== undefined),
      );
      const fields = Object.keys(payload);
      return {
        result: await this.applyKanbanCommand(userId, snapshot, {
          operationId: generatedId("aiop"),
          clientSequence: 0,
          knownBoardRevision: snapshot.board.revision,
          type: "updateChecklistItem",
          entityId: item.id,
          baseFieldVersions: Object.fromEntries(
            fields.map((field) => [field, item.fieldVersions[field] ?? 0]),
          ),
          payload,
        } as KanbanCommand),
      };
    }

    return {
      result: await this.linkCanvas(
        userId,
        request.boardId,
        request.cardId,
        request.canvasId,
      ),
    };
  }

  private async executeJira(userId: string, request: JiraExecutionRequest) {
    if (!this.jira) {
      throw new ApiError(503, "jira_unavailable", "Jira is unavailable.");
    }
    if (request.operation === "jira_list_connections") {
      return { connections: await this.jira.listConnections(userId) };
    }
    const limit = "limit" in request ? (request.limit ?? 50) : 50;
    if (request.operation === "jira_list_projects") {
      const page = await this.jira.request<Record<string, unknown>>(
        userId,
        request.connectionId,
        request.cloudId,
        `/project/search?expand=description,lead,issueTypes&startAt=${
          request.startAt ?? 0
        }&maxResults=${limit}&orderBy=name`,
      );
      const values = Array.isArray(page.values) ? page.values : [];
      return {
        values: values.map((project) => {
          const item = isRecord(project) ? project : {};
          return {
            id: stringValue(item.id),
            key: stringValue(item.key),
            name: stringValue(item.name),
            projectTypeKey: stringValue(item.projectTypeKey),
            simplified: item.simplified === true,
          };
        }),
        startAt: page.startAt ?? request.startAt ?? 0,
        maxResults: page.maxResults ?? limit,
        total: page.total ?? null,
        isLast: page.isLast ?? null,
      };
    }
    if (request.operation === "jira_search_issues") {
      const page = await this.jira.request<Record<string, unknown>>(
        userId,
        request.connectionId,
        request.cloudId,
        "/search/jql",
        {
          method: "POST",
          body: JSON.stringify({
            jql: request.jql,
            maxResults: limit,
            ...(request.nextPageToken
              ? { nextPageToken: request.nextPageToken }
              : {}),
            fields: [
              "summary",
              "description",
              "status",
              "issuetype",
              "priority",
              "assignee",
              "created",
              "updated",
            ],
          }),
        },
      );
      const issues = Array.isArray(page.issues) ? page.issues : [];
      return {
        issues: issues.map((issue) => normalizeJiraIssue(issue)),
        nextPageToken: stringValue(page.nextPageToken),
        isLast: page.isLast ?? null,
      };
    }
    if (request.operation === "jira_read_issue") {
      const issue = await this.jira.request(
        userId,
        request.connectionId,
        request.cloudId,
        `/issue/${encodeURIComponent(
          request.issueKey,
        )}?fields=summary,description,status,issuetype,priority,assignee,created,updated,comment&expand=names,schema`,
      );
      return { issue: normalizeJiraIssue(issue, true) };
    }
    if (request.operation === "jira_list_boards") {
      const query = new URLSearchParams({
        startAt: String(request.startAt ?? 0),
        maxResults: String(limit),
      });
      if (request.projectKey) {
        query.set("projectKeyOrId", request.projectKey);
      }
      const page = await this.jira.request<Record<string, unknown>>(
        userId,
        request.connectionId,
        request.cloudId,
        `/board?${query}`,
        {},
        "software",
      );
      const values = Array.isArray(page.values) ? page.values : [];
      return {
        values: values.map((board) => {
          const item = isRecord(board) ? board : {};
          return {
            id: item.id ?? null,
            name: stringValue(item.name),
            type: stringValue(item.type),
            location: item.location ?? null,
          };
        }),
        startAt: page.startAt ?? request.startAt ?? 0,
        maxResults: page.maxResults ?? limit,
        total: page.total ?? null,
        isLast: page.isLast ?? null,
      };
    }
    if (request.operation === "jira_list_sprints") {
      const query = new URLSearchParams({
        startAt: String(request.startAt ?? 0),
        maxResults: String(limit),
      });
      if (request.state) {
        query.set("state", request.state);
      }
      const page = await this.jira.request<Record<string, unknown>>(
        userId,
        request.connectionId,
        request.cloudId,
        `/board/${encodeURIComponent(request.boardId)}/sprint?${query}`,
        {},
        "software",
      );
      return page;
    }
    const page = await this.jira.request<Record<string, unknown>>(
      userId,
      request.connectionId,
      request.cloudId,
      `/board/${encodeURIComponent(request.boardId)}/backlog?startAt=${
        request.startAt ?? 0
      }&maxResults=${limit}`,
      {},
      "software",
    );
    const issues = Array.isArray(page.issues) ? page.issues : [];
    return {
      issues: issues.map((issue) => normalizeJiraIssue(issue)),
      startAt: page.startAt ?? request.startAt ?? 0,
      maxResults: page.maxResults ?? limit,
      total: page.total ?? null,
    };
  }

  private requireColumn(snapshot: KanbanSnapshot, columnId: string) {
    const column = snapshot.columns.find(
      (candidate) => candidate.id === columnId && candidate.deletedAt === null,
    );
    if (!column) {
      throw new ApiError(
        404,
        "kanban_column_not_found",
        "The Kanban column was not found.",
      );
    }
    return column;
  }

  private requireCard(snapshot: KanbanSnapshot, cardId: string): KanbanCard {
    const card = snapshot.cards.find(
      (candidate) => candidate.id === cardId && candidate.deletedAt === null,
    );
    if (!card) {
      throw new ApiError(
        404,
        "kanban_card_not_found",
        "The Kanban card was not found.",
      );
    }
    return card;
  }

  private requireChecklistItem(
    snapshot: KanbanSnapshot,
    itemId: string,
  ): KanbanChecklistItem {
    const item = snapshot.checklistItems.find(
      (candidate) => candidate.id === itemId && candidate.deletedAt === null,
    );
    if (!item) {
      throw new ApiError(
        404,
        "kanban_checklist_not_found",
        "The Kanban checklist item was not found.",
      );
    }
    return item;
  }

  private async applyKanbanCommand(
    userId: string,
    snapshot: KanbanSnapshot,
    command: KanbanCommand,
  ) {
    const [result] = await this.kanban.applyCommands(
      userId,
      snapshot.board.id,
      `drawsy-ai-${userId}`,
      [command],
    );
    if (
      !result ||
      (result.status !== "applied" && result.status !== "duplicate")
    ) {
      throw new ApiError(
        result?.status === "conflict" ? 409 : 400,
        result?.code || "kanban_command_failed",
        result?.message || "The Kanban change could not be applied.",
      );
    }
    return result;
  }

  private async linkCanvas(
    userId: string,
    boardId: string,
    cardId: string,
    canvasId: string,
  ) {
    const snapshot = await this.kanban.getSnapshot(userId, boardId);
    this.requireCard(snapshot, cardId);
    const existing = snapshot.canvasLinks.find(
      (link) => link.cardId === cardId && link.canvasId === canvasId,
    );
    if (existing) {
      return { status: "already_linked", link: existing };
    }
    const linkId = generatedId("ailink");
    const result = await this.applyKanbanCommand(userId, snapshot, {
      operationId: generatedId("aiop"),
      clientSequence: 0,
      knownBoardRevision: snapshot.board.revision,
      type: "createCanvasLink",
      entityId: linkId,
      payload: { cardId, canvasId },
    });
    return { status: "linked", linkId, result };
  }
}
