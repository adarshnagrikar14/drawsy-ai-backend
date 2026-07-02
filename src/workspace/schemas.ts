import { z } from "zod";

export const idSchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const titleSchema = z.string().trim().min(1).max(200);
const timestampSchema = z.number().int().nonnegative();
const baseVersionSchema = z.number().int().nonnegative();

export const putProjectSchema = z.object({
  id: idSchema,
  title: titleSchema,
  baseVersion: baseVersionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastOpenedAt: timestampSchema,
});

export const putCanvasSchema = z.object({
  id: idSchema,
  title: titleSchema,
  projectId: idSchema.nullable(),
  baseVersion: baseVersionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastOpenedAt: timestampSchema,
  scene: z.record(z.string(), z.unknown()),
});

export const deleteVersionSchema = z.object({
  baseVersion: z.coerce.number().int().positive(),
});
