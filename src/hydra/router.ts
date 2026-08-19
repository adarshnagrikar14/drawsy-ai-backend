import { Router } from "express";
import { z } from "zod";

import type { RequestHandler, Response } from "express";
import type { HydraService } from "./service.js";

const userId = (response: Response) => {
  const user = response.locals.user;
  if (!user) {
    throw new Error("Authenticated Hydra request is missing user context");
  }
  return user.id;
};

const querySchema = z
  .object({
    query: z.string().trim().min(1).max(20_000),
    maxResults: z.number().int().min(1).max(20).optional(),
    additionalContext: z.string().trim().max(20_000).optional(),
  })
  .strict();

const connectorCapabilitySchema = z.enum([
  "mail",
  "calendar",
  "drive",
  "notion",
  "slack",
  "github",
  "read-ai",
  "fireflies",
  "aws",
]);

const turnSchema = z
  .object({
    eventId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    turnId: z.string().trim().min(1).max(256),
    conversationId: z.string().trim().max(256).nullable(),
    surfaceKind: z.string().trim().min(1).max(64),
    surfaceId: z.string().trim().max(256).nullable(),
    userMessage: z.string().max(20_000),
    assistantMessage: z.string().max(60_000),
    connectorSources: z
      .array(
        z
          .object({
            connectionId: z.string().trim().min(1).max(256),
            capability: connectorCapabilitySchema,
            label: z.string().trim().max(256).optional(),
            accountLabel: z.string().trim().max(256).optional(),
          })
          .strict(),
      )
      .max(100),
    contextReferences: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(256),
            elementIds: z.array(z.string().trim().min(1).max(256)).max(10_000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

const deleteSchema = z
  .object({
    ids: z.array(z.string().trim().min(1).max(256)).min(1).max(100),
  })
  .strict();

export const createHydraRouter = (
  authenticate: RequestHandler,
  service: HydraService,
) => {
  const router = Router();
  router.use("/hydra", authenticate);

  router.get("/hydra/status", async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(await service.status(userId(response)));
  });

  router.post("/hydra/query", async (request, response) => {
    const input = querySchema.parse(request.body);
    response.setHeader("Cache-Control", "no-store");
    response.json(await service.query(userId(response), input));
  });

  router.post("/hydra/turns", async (request, response) => {
    const input = turnSchema.parse(request.body);
    response.setHeader("Cache-Control", "no-store");
    response
      .status(202)
      .json(await service.ingestTurn(userId(response), input));
  });

  router.delete("/hydra/memory", async (request, response) => {
    const input = deleteSchema.parse(request.body);
    await service.deleteMemory(userId(response), input.ids);
    response.status(204).end();
  });

  return router;
};
