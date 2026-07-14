import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { ApiError } from "../http/apiError.js";
import { connectorAiGrantClaimsSchema } from "./aiSchemas.js";

import type { ConnectorAiGrantRequest } from "./types.js";

export type ConnectorAiGrantClaims = ReturnType<
  typeof connectorAiGrantClaimsSchema.parse
>;

export class ConnectorAiGrantSigner {
  private readonly signingKey: Buffer;

  constructor(
    key: Buffer,
    private readonly ttlMs: number,
  ) {
    this.signingKey = createHmac("sha256", key)
      .update("drawsy-connector-ai-grant:v1", "utf8")
      .digest();
  }

  issue(userId: string, request: ConnectorAiGrantRequest) {
    const issuedAt = Date.now();
    const claims: ConnectorAiGrantClaims = {
      version: 1,
      audience: "drawsy-connector-ai",
      subject: userId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      connectionId: request.connectionId,
      capabilities: request.capabilities,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      grantId: randomBytes(18).toString("base64url"),
    };
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
      "base64url",
    );
    return {
      grant: `${payload}.${this.sign(payload)}`,
      claims,
    };
  }

  verify(grant: string) {
    const parts = grant.split(".");
    const payload = parts[0];
    const suppliedSignature = parts[1];
    if (!payload || !suppliedSignature || parts.length !== 2) {
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
      const decoded: unknown = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      );
      const claims = connectorAiGrantClaimsSchema.parse(decoded);
      if (
        claims.expiresAt <= Date.now() ||
        claims.issuedAt > Date.now() + 5_000
      ) {
        throw new ApiError(
          401,
          "connector_ai_grant_expired",
          "The connector grant has expired.",
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
      "connector_ai_grant_invalid",
      "A valid connector grant is required.",
    );
  }
}
