import { Router } from "express";
import { z } from "zod";

import { ApiError } from "../http/apiError.js";
import {
  aiResourceExecutionRequestSchema,
  aiResourceGrantRequestSchema,
} from "./schemas.js";

import type { RequestHandler, Response } from "express";
import type { AiResourceService } from "./types.js";

const grantSchema = z.string().min(32).max(16_384);

const userId = (response: Response) => {
  const user = response.locals.user;
  if (!user) {
    throw new Error(
      "Authenticated Drawsy resource request is missing user context",
    );
  }
  return user.id;
};

export const createAiResourcesRouter = (
  authenticate: RequestHandler,
  service: AiResourceService,
) => {
  const router = Router();

  router.post("/ai/resources/execute", async (request, response) => {
    const match = request.header("authorization")?.match(/^Bearer ([^\s]+)$/);
    const parsed = grantSchema.safeParse(match?.[1]);
    if (!parsed.success) {
      throw new ApiError(
        401,
        "resource_ai_grant_required",
        "A valid Drawsy resource grant is required.",
      );
    }
    const values = aiResourceExecutionRequestSchema.parse(request.body);
    response.setHeader("Cache-Control", "no-store");
    response.json(await service.execute(parsed.data, values));
  });

  router.post("/ai/resources/grants", authenticate, (request, response) => {
    const values = aiResourceGrantRequestSchema.parse(request.body);
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json(service.createGrant(userId(response), values));
  });

  return router;
};
