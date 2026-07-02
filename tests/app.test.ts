import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";

import type { AppConfig } from "../src/config.js";
import type { TokenVerifier } from "../src/auth/types.js";

const config: AppConfig = {
  env: "test",
  host: "127.0.0.1",
  port: 3004,
  allowedOrigins: new Set(["http://localhost:3001"]),
  firebaseProjectId: "drawsy-ai-test",
};

const createVerifier = () => {
  const verify = vi.fn((token: string) => {
    if (token !== "valid-token") {
      return Promise.reject(new Error("Invalid token"));
    }

    return Promise.resolve({
      id: "user-1",
      email: "user@example.com",
      emailVerified: true,
      name: "Drawsy User",
      picture: null,
    });
  });

  return {
    verifier: { verify } satisfies TokenVerifier,
    verify,
  };
};

describe("Drawsy backend API", () => {
  it("reports service health without authentication", async () => {
    const { verifier } = createVerifier();
    const response = await request(
      createApp({ config, tokenVerifier: verifier }),
    ).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "drawsy-ai-backend",
    });
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it.each([undefined, "Basic credentials", "Bearer", "Bearer token extra"])(
    "rejects a missing or malformed authorization header: %s",
    async (authorization) => {
      const { verifier } = createVerifier();
      const call = request(createApp({ config, tokenVerifier: verifier })).get(
        "/v1/me",
      );
      if (authorization) {
        call.set("authorization", authorization);
      }

      const response = await call;

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: { code: "authentication_required" },
        requestId: response.get("x-request-id"),
      });
    },
  );

  it("rejects an invalid or expired token without leaking verifier details", async () => {
    const { verifier } = createVerifier();
    const response = await request(
      createApp({ config, tokenVerifier: verifier }),
    )
      .get("/v1/me")
      .set("authorization", "Bearer invalid-token");

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: {
        code: "invalid_token",
        message: "The authentication token is invalid or expired.",
      },
    });
    expect(response.text).not.toContain("Invalid token");
  });

  it("returns the verified user for a valid Firebase ID token", async () => {
    const { verifier, verify } = createVerifier();
    const response = await request(
      createApp({ config, tokenVerifier: verifier }),
    )
      .get("/v1/me")
      .set("authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      user: {
        id: "user-1",
        email: "user@example.com",
        emailVerified: true,
        name: "Drawsy User",
        picture: null,
      },
    });
    expect(verify).toHaveBeenCalledWith("valid-token");
  });

  it("allows configured browser origins and omits CORS for unknown origins", async () => {
    const { verifier } = createVerifier();
    const app = createApp({ config, tokenVerifier: verifier });
    const allowed = await request(app)
      .get("/health")
      .set("origin", "http://localhost:3001");
    const unknown = await request(app)
      .get("/health")
      .set("origin", "https://unknown.example");

    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3001",
    );
    expect(unknown.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns a stable not-found error", async () => {
    const { verifier } = createVerifier();
    const response = await request(
      createApp({ config, tokenVerifier: verifier }),
    ).get("/missing");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: { code: "not_found" },
      requestId: response.get("x-request-id"),
    });
  });

  it("reports malformed JSON as a client error with a request ID", async () => {
    const { verifier } = createVerifier();
    const response = await request(
      createApp({ config, tokenVerifier: verifier }),
    )
      .post("/missing")
      .set("content-type", "application/json")
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "invalid_json" },
      requestId: response.get("x-request-id"),
    });
  });
});
