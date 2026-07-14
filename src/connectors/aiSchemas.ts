import { z } from "zod";

import { connectorProviderIds } from "./types.js";

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
    {
      message: "must not contain control characters",
    },
  );
const capability = z.enum([
  "mail",
  "calendar",
  "drive",
  "notion",
  "slack",
  "github",
]);

export const connectorAiGrantRequestSchema = z
  .object({
    sessionId: boundedId,
    turnId: boundedId,
    connectionId: boundedId,
    capabilities: z
      .array(capability)
      .min(1)
      .max(6)
      .refine((values) => new Set(values).size === values.length, {
        message: "must not contain duplicate capabilities",
      }),
  })
  .strict();

const executionContextSchema = {
  sessionId: boundedId,
  turnId: boundedId,
  connectionId: boundedId,
  capability,
};

export const connectorAiExecutionRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        ...executionContextSchema,
        operation: z.literal("search"),
        query: z.string().trim().min(1).max(2_000),
        cursor: z.string().trim().min(1).max(4_096).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    z
      .object({
        ...executionContextSchema,
        operation: z.literal("read"),
        resourceId: z.string().trim().min(1).max(4_096),
      })
      .strict(),
  ],
);

export const connectorAiGrantClaimsSchema = z
  .object({
    version: z.literal(1),
    audience: z.literal("drawsy-connector-ai"),
    subject: boundedId,
    sessionId: boundedId,
    turnId: boundedId,
    connectionId: boundedId,
    capabilities: z.array(capability).min(1).max(6),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    grantId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  })
  .strict();

export const connectorAiResourceIdSchema = z
  .object({
    providerId: z.enum(connectorProviderIds),
    capability,
    type: z.string().min(1).max(64),
    id: z.string().min(1).max(2_048),
    parentId: z.string().min(1).max(2_048).optional(),
    number: z.number().int().positive().optional(),
  })
  .strict();
