import { z } from "zod";

import { idSchema } from "../workspace/schemas.js";

const operationIdSchema = idSchema;
const sequenceSchema = z.number().int().nonnegative();
const versionSchema = z.number().int().nonnegative();
const titleSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().max(20_000);
const optionalNeighborSchema = idSchema.nullable();
const roleSchema = z.enum(["editor", "viewer"]);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), {
    message: "Invalid calendar date",
  });

const baseCommandSchema = z.object({
  operationId: operationIdSchema,
  clientSequence: sequenceSchema,
  knownBoardRevision: versionSchema,
});

const neighborsSchema = z.object({
  beforeId: optionalNeighborSchema,
  afterId: optionalNeighborSchema,
});

const boardPayloadSchema = z
  .object({
    title: titleSchema.optional(),
    roughness: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    cardRadius: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    isLocked: z.boolean().optional(),
  })
  .strict();

const cardFieldsSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema,
    priority: z.enum(["low", "medium", "high"]).nullable(),
    progress: z.number().int().min(0).max(100),
    dueDate: dateSchema.nullable(),
    legacyAssigneeText: z.string().trim().max(500).nullable(),
    legacyCanvasTags: z.array(z.string().trim().min(1).max(200)).max(100),
  })
  .strict();

const updateCardFieldsSchema = cardFieldsSchema.partial().extend({
  assigneeIds: z.array(idSchema).max(100).optional(),
});

const commandSchema = z.discriminatedUnion("type", [
  baseCommandSchema.extend({
    type: z.literal("updateBoard"),
    payload: boardPayloadSchema,
  }),
  baseCommandSchema.extend({
    type: z.literal("createColumn"),
    entityId: idSchema,
    payload: neighborsSchema.extend({ title: titleSchema }).strict(),
  }),
  baseCommandSchema.extend({
    type: z.literal("updateColumn"),
    entityId: idSchema,
    baseVersion: versionSchema.positive(),
    payload: z.object({ title: titleSchema.optional() }).strict(),
  }),
  baseCommandSchema.extend({
    type: z.literal("moveColumn"),
    entityId: idSchema,
    baseVersion: versionSchema.positive(),
    payload: neighborsSchema.extend({ title: titleSchema.optional() }).strict(),
  }),
  baseCommandSchema.extend({
    type: z.enum(["deleteColumn", "restoreColumn"]),
    entityId: idSchema,
    baseVersion: versionSchema.positive(),
    payload: z.object({ destinationColumnId: idSchema.nullable() }).strict(),
  }),
  baseCommandSchema.extend({
    type: z.literal("createCard"),
    entityId: idSchema,
    payload: cardFieldsSchema
      .extend({
        columnId: idSchema,
        assigneeIds: z.array(idSchema).max(100),
        beforeId: optionalNeighborSchema,
        afterId: optionalNeighborSchema,
      })
      .strict(),
  }),
  baseCommandSchema.extend({
    type: z.literal("updateCard"),
    entityId: idSchema,
    baseFieldVersions: z.record(z.string(), versionSchema),
    payload: updateCardFieldsSchema,
  }),
  baseCommandSchema.extend({
    type: z.literal("moveCard"),
    entityId: idSchema,
    baseVersion: versionSchema.positive(),
    payload: neighborsSchema.extend({ columnId: idSchema }).strict(),
  }),
  baseCommandSchema.extend({
    type: z.enum(["deleteCard", "restoreCard"]),
    entityId: idSchema,
    baseVersion: versionSchema.positive(),
    payload: z.object({}).strict(),
  }),
  baseCommandSchema.extend({
    type: z.literal("createChecklistItem"),
    entityId: idSchema,
    payload: neighborsSchema
      .extend({ cardId: idSchema, title: titleSchema })
      .strict(),
  }),
  baseCommandSchema.extend({
    type: z.literal("updateChecklistItem"),
    entityId: idSchema,
    baseFieldVersions: z.record(z.string(), versionSchema),
    payload: z
      .object({
        title: titleSchema.optional(),
        completed: z.boolean().optional(),
      })
      .strict(),
  }),
  baseCommandSchema.extend({
    type: z.literal("moveChecklistItem"),
    entityId: idSchema,
    baseVersion: versionSchema.positive(),
    payload: neighborsSchema.strict(),
  }),
  baseCommandSchema.extend({
    type: z.enum(["deleteChecklistItem", "restoreChecklistItem"]),
    entityId: idSchema,
    baseVersion: versionSchema.positive(),
    payload: z.object({}).strict(),
  }),
  baseCommandSchema.extend({
    type: z.literal("createCanvasLink"),
    entityId: idSchema,
    payload: z.object({ cardId: idSchema, canvasId: idSchema }).strict(),
  }),
  baseCommandSchema.extend({
    type: z.literal("deleteCanvasLink"),
    entityId: idSchema,
    payload: z.object({}).strict(),
  }),
]);

export const createBoardSchema = z
  .object({
    id: idSchema,
    title: titleSchema,
    initialColumnId: idSchema.optional(),
    initialColumnTitle: titleSchema.optional(),
    columns: z
      .array(
        z
          .object({
            id: idSchema,
            title: titleSchema,
          })
          .strict(),
      )
      .min(1)
      .max(24)
      .optional(),
  })
  .strict();

export const commandBatchSchema = z
  .object({
    clientId: idSchema,
    commands: z.array(commandSchema).min(1).max(100),
  })
  .strict();

export const changesQuerySchema = z.object({
  afterRevision: z.coerce.number().int().nonnegative(),
});

export const updateMemberSchema = z.object({ role: roleSchema }).strict();

export const transferOwnershipSchema = z
  .object({ targetUserId: idSchema })
  .strict();

export const createInvitationSchema = z
  .object({
    email: z.email().max(320),
    role: roleSchema,
    expiresInHours: z.number().int().min(1).max(720).default(168),
  })
  .strict();

export const invitationTokenSchema = z
  .object({ token: z.string().min(40).max(512) })
  .strict();

export type CommandBatch = z.infer<typeof commandBatchSchema>;
