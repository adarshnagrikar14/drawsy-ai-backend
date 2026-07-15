import { describe, expect, it, vi } from "vitest";

import { DefaultAiResourceService } from "../src/aiResources/service.js";

import type { JiraService } from "../src/jira/types.js";
import type {
  KanbanCommand,
  KanbanCommandResult,
  KanbanService,
  KanbanSnapshot,
} from "../src/kanban/types.js";

const snapshot = (): KanbanSnapshot => ({
  board: {
    id: "board-0001",
    schemaVersion: 2,
    ownerId: "user-0001",
    role: "owner",
    revision: 4,
    status: "active",
    title: "Product",
    roughness: 1,
    cardRadius: 1,
    isLocked: false,
    createdAt: 1,
    updatedAt: 1,
    trashedAt: null,
  },
  columns: [
    {
      id: "column-0001",
      boardId: "board-0001",
      title: "To do",
      rank: "a",
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    },
  ],
  cards: [
    {
      id: "card-0001",
      boardId: "board-0001",
      columnId: "column-0001",
      rank: "a",
      version: 1,
      fieldVersions: { title: 1, description: 1 },
      assigneeIds: [],
      title: "Existing",
      description: "",
      priority: null,
      progress: 0,
      dueDate: null,
      legacyAssigneeText: null,
      legacyCanvasTags: [],
      createdBy: "user-0001",
      updatedBy: "user-0001",
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    },
  ],
  checklistItems: [],
  canvasLinks: [],
  members: [
    {
      userId: "user-0001",
      role: "owner",
      membershipVersion: 1,
      invitedBy: null,
      joinedAt: 1,
      updatedAt: 1,
    },
  ],
});

const kanbanService = () => {
  const listBoards = vi.fn(() =>
    Promise.resolve([
      {
        id: "board-0001",
        title: "Product",
        role: "owner",
        revision: 4,
        status: "active",
        updatedAt: 1,
      },
    ]),
  );
  const getSnapshot = vi.fn(() => Promise.resolve(snapshot()));
  const applyCommands = vi.fn(
    (
      _userId: string,
      _boardId: string,
      _clientId: string,
      commands: KanbanCommand[],
    ): Promise<KanbanCommandResult[]> =>
      Promise.resolve([
        {
          operationId: commands[0]!.operationId,
          status: "applied",
          revision: 5,
        },
      ]),
  );
  return {
    service: {
      listBoards,
      getSnapshot,
      applyCommands,
    } as unknown as KanbanService,
    applyCommands,
  };
};

const issueAdf = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Investigate the sync race." }],
    },
  ],
};

describe("Drawsy AI resources", () => {
  it("keeps grants bound to the exact session, turn, and resource", async () => {
    const service = new DefaultAiResourceService(
      Buffer.alloc(32, 7),
      60_000,
      256 * 1024,
      kanbanService().service,
    );
    const grant = service.createGrant("user-0001", {
      sessionId: "session-0001",
      turnId: "turn-0001",
      resources: ["kanban"],
    });

    await expect(
      service.execute(grant.grant, {
        sessionId: "session-other",
        turnId: "turn-0001",
        operation: "kanban_list_boards",
      }),
    ).rejects.toMatchObject({ code: "resource_ai_scope_mismatch" });
    await expect(
      service.execute(grant.grant, {
        sessionId: "session-0001",
        turnId: "turn-0001",
        operation: "jira_list_connections",
      }),
    ).rejects.toMatchObject({ code: "resource_ai_not_attached" });
  });

  it("translates semantic Kanban updates into revision-aware commands", async () => {
    const kanban = kanbanService();
    const service = new DefaultAiResourceService(
      Buffer.alloc(32, 8),
      60_000,
      256 * 1024,
      kanban.service,
    );
    const grant = service.createGrant("user-0001", {
      sessionId: "session-0001",
      turnId: "turn-0001",
      resources: ["kanban"],
    });

    await service.execute(grant.grant, {
      sessionId: "session-0001",
      turnId: "turn-0001",
      operation: "kanban_update_card",
      boardId: "board-0001",
      cardId: "card-0001",
      title: "Updated from Jira",
    });

    expect(kanban.applyCommands).toHaveBeenCalledWith(
      "user-0001",
      "board-0001",
      "drawsy-ai-user-0001",
      [
        expect.objectContaining({
          type: "updateCard",
          entityId: "card-0001",
          knownBoardRevision: 4,
          baseFieldVersions: { title: 1 },
          payload: { title: "Updated from Jira" },
        }),
      ],
    );
  });

  it("normalizes Jira issue content without exposing write operations", async () => {
    const jiraRequest = vi.fn(() =>
      Promise.resolve({
        issues: [
          {
            id: "10001",
            key: "DRAW-42",
            fields: {
              summary: "Sync race",
              description: issueAdf,
              status: { name: "In progress" },
              issuetype: { name: "Bug" },
              priority: { name: "High" },
              assignee: { displayName: "Ada" },
              updated: "2026-07-15T10:00:00.000Z",
            },
          },
        ],
        nextPageToken: null,
      }),
    );
    const jira = {
      listConnections: vi.fn(() => Promise.resolve([])),
      request: jiraRequest,
    } as unknown as JiraService;
    const service = new DefaultAiResourceService(
      Buffer.alloc(32, 9),
      60_000,
      256 * 1024,
      kanbanService().service,
      jira,
    );
    const grant = service.createGrant("user-0001", {
      sessionId: "session-0001",
      turnId: "turn-0001",
      resources: ["jira"],
    });

    await expect(
      service.execute(grant.grant, {
        sessionId: "session-0001",
        turnId: "turn-0001",
        operation: "jira_search_issues",
        connectionId: "connection-0001",
        cloudId: "cloud-0001",
        jql: "project = DRAW",
      }),
    ).resolves.toMatchObject({
      issues: [
        {
          key: "DRAW-42",
          summary: "Sync race",
          status: "In progress",
          issueType: "Bug",
        },
      ],
    });
    expect(jiraRequest).toHaveBeenCalledWith(
      "user-0001",
      "connection-0001",
      "cloud-0001",
      "/search/jql",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
