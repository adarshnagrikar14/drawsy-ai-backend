import { Router } from "express";
import { z } from "zod";

import { connectorProviderIds } from "./types.js";
import {
  connectorAiExecutionRequestSchema,
  connectorAiGrantRequestSchema,
} from "./aiSchemas.js";
import { ApiError } from "../http/apiError.js";

import type { RequestHandler, Response } from "express";
import type { ConnectorService } from "./types.js";

const id = z.string().trim().min(1).max(256);
const providerId = z.enum(connectorProviderIds);
const oauthCode = z.string().trim().min(1).max(4_096);
const aiGrant = z.string().min(32).max(16_384);

const userId = (response: Response) => {
  const user = response.locals.user;
  if (!user) {
    throw new Error("Authenticated connector request is missing user context");
  }
  return user.id;
};

export const createConnectorsRouter = (
  authenticate: RequestHandler,
  service: ConnectorService,
  successUrl: string,
) => {
  const router = Router();

  router.post("/connectors/ai/execute", async (request, response) => {
    const authorization = request.header("authorization");
    const match = authorization?.match(/^Bearer ([^\s]+)$/);
    if (!match?.[1]) {
      throw new ApiError(
        401,
        "connector_ai_grant_required",
        "A valid connector grant is required.",
      );
    }
    const parsedGrant = aiGrant.safeParse(match[1]);
    if (!parsedGrant.success) {
      throw new ApiError(
        401,
        "connector_ai_grant_invalid",
        "A valid connector grant is required.",
      );
    }
    const values = connectorAiExecutionRequestSchema.parse(request.body);
    response.setHeader("Cache-Control", "no-store");
    response.json(await service.executeAiRequest(parsedGrant.data, values));
  });

  router.get(
    "/connectors/:providerId/oauth/callback",
    async (request, response) => {
      response.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
      const params = z.object({ providerId }).safeParse(request.params);
      const query = z
        .object({
          code: oauthCode.optional(),
          state: id.optional(),
          error: id.optional(),
        })
        .safeParse(request.query);
      const target = new URL(successUrl);
      if (
        !params.success ||
        !query.success ||
        query.data.error ||
        !query.data.code ||
        !query.data.state
      ) {
        if (
          params.success &&
          query.success &&
          query.data.state &&
          query.data.error
        ) {
          await service
            .failAuthorization(
              params.data.providerId,
              query.data.state,
              query.data.error,
            )
            .catch(() => undefined);
        }
        target.searchParams.set("connector", "error");
        target.searchParams.set(
          "connector_error",
          query.success
            ? query.data.error || "invalid_response"
            : "invalid_response",
        );
        response.redirect(303, target.toString());
        return;
      }
      try {
        await service.completeAuthorization(
          params.data.providerId,
          query.data.code,
          query.data.state,
        );
        target.searchParams.set("connector", "connected");
        target.searchParams.set("provider", params.data.providerId);
      } catch (error) {
        target.searchParams.set("connector", "error");
        target.searchParams.set(
          "connector_error",
          error instanceof Error && "code" in error
            ? String(error.code)
            : "authorization_failed",
        );
      }
      response.redirect(303, target.toString());
    },
  );

  router.use("/connectors", authenticate);

  router.get("/connectors", async (_request, response) => {
    response.json(await service.getOverview(userId(response)));
  });
  router.post("/connectors/ai/grants", async (request, response) => {
    const values = connectorAiGrantRequestSchema.parse(request.body);
    response.setHeader("Cache-Control", "no-store");
    response
      .status(201)
      .json(await service.createAiGrant(userId(response), values));
  });
  router.post(
    "/connectors/:providerId/oauth/start",
    async (request, response) => {
      const values = z.object({ providerId }).parse(request.params);
      response.json(
        await service.getAuthorizationUrl(userId(response), values.providerId),
      );
    },
  );
  router.get(
    "/connectors/oauth/attempts/:attemptId",
    async (request, response) => {
      const { attemptId } = z.object({ attemptId: id }).parse(request.params);
      response.json(
        await service.getAuthorizationStatus(userId(response), attemptId),
      );
    },
  );
  router.delete(
    "/connectors/connections/:connectionId",
    async (request, response) => {
      const { connectionId } = z
        .object({ connectionId: id })
        .parse(request.params);
      await service.deleteConnection(userId(response), connectionId);
      response.status(204).end();
    },
  );

  return router;
};
