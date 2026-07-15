import { z } from "zod";

import { aiResourceIds } from "./types.js";
import { idSchema } from "../workspace/schemas.js";

const boundedId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
      }),
    { message: "must not contain control characters" },
  );
const resource = z.enum(aiResourceIds);
const context = { sessionId: boundedId, turnId: boundedId };
const limit = z.number().int().min(1).max(100).optional();
const startAt = z.number().int().nonnegative().optional();
const title = z.string().trim().min(1).max(200);
const description = z.string().max(20_000);
const priority = z.enum(["low", "medium", "high"]).nullable();
const progress = z.number().int().min(0).max(100);
const dueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), {
    message: "Invalid calendar date",
  })
  .nullable();

export const aiResourceGrantRequestSchema = z
  .object({
    ...context,
    resources: z
      .array(resource)
      .min(1)
      .max(aiResourceIds.length)
      .refine((values) => new Set(values).size === values.length, {
        message: "must not contain duplicate resources",
      }),
  })
  .strict();

const kanbanUpdateFields = {
  title: title.optional(),
  description: description.optional(),
  priority: priority.optional(),
  progress: progress.optional(),
  dueDate: dueDate.optional(),
  assigneeIds: z.array(idSchema).max(100).optional(),
};

export const aiResourceExecutionRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({ ...context, operation: z.literal("kanban_list_boards") })
      .strict(),
    z
      .object({
        ...context,
        operation: z.literal("kanban_read_board"),
        boardId: idSchema,
      })
      .strict(),
    z
      .object({
        ...context,
        operation: z.literal("kanban_create_card"),
        boardId: idSchema,
        columnId: idSchema,
        title,
        description: description.optional(),
        priority: priority.optional(),
        progress: progress.optional(),
        dueDate: dueDate.optional(),
        assigneeIds: z.array(idSchema).max(100).optional(),
        linkCanvasId: idSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...context,
        operation: z.literal("kanban_update_card"),
        boardId: idSchema,
        cardId: idSchema,
        ...kanbanUpdateFields,
      })
      .strict()
      .refine(
        (value) =>
          Object.keys(kanbanUpdateFields).some(
            (field) => value[field as keyof typeof value] !== undefined,
          ),
        { message: "At least one card field is required" },
      ),
    z
      .object({
        ...context,
        operation: z.literal("kanban_move_card"),
        boardId: idSchema,
        cardId: idSchema,
        columnId: idSchema,
      })
      .strict(),
    z
      .object({
        ...context,
        operation: z.literal("kanban_create_checklist_item"),
        boardId: idSchema,
        cardId: idSchema,
        title,
      })
      .strict(),
    z
      .object({
        ...context,
        operation: z.literal("kanban_update_checklist_item"),
        boardId: idSchema,
        itemId: idSchema,
        title: title.optional(),
        completed: z.boolean().optional(),
      })
      .strict()
      .refine(
        (value) => value.title !== undefined || value.completed !== undefined,
        { message: "A checklist field is required" },
      ),
    z
      .object({
        ...context,
        operation: z.literal("kanban_link_canvas"),
        boardId: idSchema,
        cardId: idSchema,
        canvasId: idSchema,
      })
      .strict(),
    z
      .object({ ...context, operation: z.literal("jira_list_connections") })
      .strict(),
    z
      .object({
        ...context,
        operation: z.literal("jira_list_projects"),
        connectionId: boundedId,
        cloudId: boundedId,
        startAt,
        limit,
      })
      .strict(),
    z
      .object({
        ...context,
        operation: z.literal("jira_search_issues"),
        connectionId: boundedId,
        cloudId: boundedId,
        jql: z.string().trim().min(1).max(10_000),
        nextPageToken: z.string().trim().min(1).max(4_096).optional(),
        limit,
      })
      .strict(),
    z
      .object({
        ...context,
        operation: z.literal("jira_read_issue"),
        connectionId: boundedId,
        cloudId: boundedId,
        issueKey: z.string().trim().min(1).max(256),
      })
      .strict(),
    z
      .object({
        ...context,
        operation: z.literal("jira_list_boards"),
        connectionId: boundedId,
        cloudId: boundedId,
        projectKey: z.string().trim().min(1).max(256).optional(),
        startAt,
        limit,
      })
      .strict(),
    z
      .object({
        ...context,
        operation: z.literal("jira_list_sprints"),
        connectionId: boundedId,
        cloudId: boundedId,
        boardId: boundedId,
        state: z.enum(["active", "future", "closed"]).optional(),
        startAt,
        limit,
      })
      .strict(),
    z
      .object({
        ...context,
        operation: z.literal("jira_list_backlog"),
        connectionId: boundedId,
        cloudId: boundedId,
        boardId: boundedId,
        startAt,
        limit,
      })
      .strict(),
  ],
);

export const aiResourceGrantClaimsSchema = z
  .object({
    version: z.literal(1),
    audience: z.literal("drawsy-resource-ai"),
    subject: boundedId,
    sessionId: boundedId,
    turnId: boundedId,
    resources: z.array(resource).min(1).max(aiResourceIds.length),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    grantId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  })
  .strict();
