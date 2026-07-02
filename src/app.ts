import { randomUUID } from "node:crypto";

import cors from "cors";
import express from "express";
import helmet from "helmet";
import { ZodError } from "zod";

import { createAuthenticate } from "./http/authenticate.js";
import { ApiError } from "./http/apiError.js";
import { createWorkspaceRouter } from "./workspace/router.js";

import type { AppConfig } from "./config.js";
import type { TokenVerifier } from "./auth/types.js";
import type { WorkspaceService } from "./workspace/types.js";
import type { NextFunction, Request, Response } from "express";

type AppDependencies = {
  config: AppConfig;
  tokenVerifier: TokenVerifier;
  workspaceService: WorkspaceService;
};

export const createApp = ({
  config,
  tokenVerifier,
  workspaceService,
}: AppDependencies) => {
  const app = express();
  const authenticate = createAuthenticate(tokenVerifier);

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        callback(null, !origin || config.allowedOrigins.has(origin));
      },
    }),
  );
  app.use((_request, response, next) => {
    response.locals.requestId = randomUUID();
    response.setHeader("x-request-id", response.locals.requestId);
    next();
  });
  app.use(express.json({ limit: config.sceneSizeLimitBytes }));

  app.get("/health", (_request, response) => {
    response.status(200).json({
      status: "ok",
      service: "drawsy-ai-backend",
    });
  });

  app.get("/v1/me", authenticate, (_request, response) => {
    const user = response.locals.user;
    if (!user) {
      throw new Error("Authenticated request is missing user context");
    }
    response.status(200).json({ user });
  });

  app.use("/v1", createWorkspaceRouter(authenticate, workspaceService));

  app.use((_request, response) => {
    response.status(404).json({
      error: {
        code: "not_found",
        message: "The requested resource was not found.",
      },
      requestId: response.locals.requestId,
    });
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (
        error instanceof SyntaxError &&
        "status" in error &&
        error.status === 400
      ) {
        response.status(400).json({
          error: {
            code: "invalid_json",
            message: "The request body contains invalid JSON.",
          },
          requestId: response.locals.requestId,
        });
        return;
      }

      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 413
      ) {
        response.status(413).json({
          error: {
            code: "scene_too_large",
            message: "The canvas exceeds the workspace size limit.",
          },
          requestId: response.locals.requestId,
        });
        return;
      }

      if (error instanceof ZodError) {
        response.status(400).json({
          error: {
            code: "invalid_request",
            message: "The request is invalid.",
            issues: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
          requestId: response.locals.requestId,
        });
        return;
      }

      if (error instanceof ApiError) {
        response.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
          },
          requestId: response.locals.requestId,
        });
        return;
      }

      console.error(
        JSON.stringify({
          level: "error",
          message: "request_failed",
          requestId: response.locals.requestId,
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
      response.status(500).json({
        error: {
          code: "internal_error",
          message: "An internal error occurred.",
        },
        requestId: response.locals.requestId,
      });
    },
  );

  return app;
};
