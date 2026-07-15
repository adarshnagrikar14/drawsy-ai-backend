export const aiResourceIds = ["kanban", "jira"] as const;

export type AiResourceId = (typeof aiResourceIds)[number];

export type AiResourceGrantRequest = {
  sessionId: string;
  turnId: string;
  resources: AiResourceId[];
};

export type AiResourceExecutionRequest = {
  sessionId: string;
  turnId: string;
} & (
  | { operation: "kanban_list_boards" }
  | { operation: "kanban_read_board"; boardId: string }
  | {
      operation: "kanban_create_card";
      boardId: string;
      columnId: string;
      title: string;
      description?: string;
      priority?: "low" | "medium" | "high" | null;
      progress?: number;
      dueDate?: string | null;
      assigneeIds?: string[];
      linkCanvasId?: string;
    }
  | {
      operation: "kanban_update_card";
      boardId: string;
      cardId: string;
      title?: string;
      description?: string;
      priority?: "low" | "medium" | "high" | null;
      progress?: number;
      dueDate?: string | null;
      assigneeIds?: string[];
    }
  | {
      operation: "kanban_move_card";
      boardId: string;
      cardId: string;
      columnId: string;
    }
  | {
      operation: "kanban_create_checklist_item";
      boardId: string;
      cardId: string;
      title: string;
    }
  | {
      operation: "kanban_update_checklist_item";
      boardId: string;
      itemId: string;
      title?: string;
      completed?: boolean;
    }
  | {
      operation: "kanban_link_canvas";
      boardId: string;
      cardId: string;
      canvasId: string;
    }
  | { operation: "jira_list_connections" }
  | {
      operation: "jira_list_projects";
      connectionId: string;
      cloudId: string;
      startAt?: number;
      limit?: number;
    }
  | {
      operation: "jira_search_issues";
      connectionId: string;
      cloudId: string;
      jql: string;
      nextPageToken?: string;
      limit?: number;
    }
  | {
      operation: "jira_read_issue";
      connectionId: string;
      cloudId: string;
      issueKey: string;
    }
  | {
      operation: "jira_list_boards";
      connectionId: string;
      cloudId: string;
      projectKey?: string;
      startAt?: number;
      limit?: number;
    }
  | {
      operation: "jira_list_sprints";
      connectionId: string;
      cloudId: string;
      boardId: string;
      state?: "active" | "future" | "closed";
      startAt?: number;
      limit?: number;
    }
  | {
      operation: "jira_list_backlog";
      connectionId: string;
      cloudId: string;
      boardId: string;
      startAt?: number;
      limit?: number;
    }
);

export interface AiResourceService {
  createGrant(
    userId: string,
    request: AiResourceGrantRequest,
  ): {
    grant: string;
    expiresAt: number;
    resources: AiResourceId[];
  };
  execute(grant: string, request: AiResourceExecutionRequest): Promise<unknown>;
}
