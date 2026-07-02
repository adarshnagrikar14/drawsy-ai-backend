import type { NextFunction, Request, Response } from "express";
import type { TokenVerifier } from "../auth/types.js";

const getBearerToken = (authorization: string | undefined): string | null => {
  if (!authorization) {
    return null;
  }

  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    return null;
  }

  return parts[1] || null;
};

export const createAuthenticate =
  (tokenVerifier: TokenVerifier) =>
  async (request: Request, response: Response, next: NextFunction) => {
    const token = getBearerToken(request.header("authorization"));
    if (!token) {
      response.status(401).json({
        error: {
          code: "authentication_required",
          message: "A valid Bearer token is required.",
        },
        requestId: response.locals.requestId,
      });
      return;
    }

    try {
      response.locals.user = await tokenVerifier.verify(token);
      next();
    } catch {
      response.status(401).json({
        error: {
          code: "invalid_token",
          message: "The authentication token is invalid or expired.",
        },
        requestId: response.locals.requestId,
      });
    }
  };
