import { z } from "zod";

import { idSchema } from "../workspace/schemas.js";

const titleSchema = z.string().trim().min(1).max(200);
const timestampSchema = z.number().int().nonnegative();
const baseVersionSchema = z.number().int().nonnegative();

export const putPresentationSchema = z.object({
  id: idSchema,
  title: titleSchema,
  baseVersion: baseVersionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastOpenedAt: timestampSchema,
  scene: z.record(z.string(), z.unknown()),
});

export const patchPresentationSchema = z.object({
  id: idSchema,
  title: titleSchema,
  baseVersion: baseVersionSchema,
  lastOpenedAt: timestampSchema,
});
