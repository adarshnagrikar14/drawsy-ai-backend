import { z } from "zod";

import { idSchema } from "../workspace/schemas.js";

export const commentBodySchema = z.string().trim().min(1).max(4_000);
const coordinateSchema = z
  .number()
  .finite()
  .min(-1_000_000_000)
  .max(1_000_000_000);

export const createCommentSchema = z.object({
  id: idSchema,
  messageId: idSchema,
  x: coordinateSchema,
  y: coordinateSchema,
  elementId: idSchema.nullable(),
  body: commentBodySchema,
});

export const deleteCommentSchema = z.object({
  baseVersion: z.coerce.number().int().positive(),
});
