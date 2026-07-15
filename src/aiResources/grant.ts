import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { ApiError } from "../http/apiError.js";
import { aiResourceGrantClaimsSchema } from "./schemas.js";

import type { AiResourceGrantRequest } from "./types.js";

export type AiResourceGrantClaims = ReturnType<
  typeof aiResourceGrantClaimsSchema.parse
>;

export class AiResourceGrantSigner {
  private readonly signingKey: Buffer;

  constructor(
    key: Buffer,
    private readonly ttlMs: number,
  ) {
    this.signingKey = createHmac("sha256", key)
      .update("drawsy-resource-ai-grant:v1", "utf8")
      .digest();
  }

  issue(userId: string, request: AiResourceGrantRequest) {
    const issuedAt = Date.now();
    const claims: AiResourceGrantClaims = {
      version: 1,
      audience: "drawsy-resource-ai",
      subject: userId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      resources: request.resources,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      grantId: randomBytes(18).toString("base64url"),
    };
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
      "base64url",
    );
    return { grant: `${payload}.${this.sign(payload)}`, claims };
  }

  verify(grant: string) {
    const [payload, suppliedSignature, extra] = grant.split(".");
    if (!payload || !suppliedSignature || extra) {
      throw this.invalidGrant();
    }
    const expectedSignature = this.sign(payload);
    const supplied = Buffer.from(suppliedSignature, "utf8");
    const expected = Buffer.from(expectedSignature, "utf8");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw this.invalidGrant();
    }
    try {
      const claims = aiResourceGrantClaimsSchema.parse(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      );
      if (
        claims.expiresAt <= Date.now() ||
        claims.issuedAt > Date.now() + 5_000
      ) {
        throw new ApiError(
          401,
          "resource_ai_grant_expired",
          "The Drawsy resource grant has expired.",
        );
      }
      return claims;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw this.invalidGrant();
    }
  }

  private sign(payload: string) {
    return createHmac("sha256", this.signingKey)
      .update(payload, "utf8")
      .digest("base64url");
  }

  private invalidGrant() {
    return new ApiError(
      401,
      "resource_ai_grant_invalid",
      "A valid Drawsy resource grant is required.",
    );
  }
}
