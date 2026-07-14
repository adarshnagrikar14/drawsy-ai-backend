import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("normalizes runtime configuration", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      APP_HOST: "0.0.0.0",
      APP_PORT: "8080",
      APP_ALLOWED_ORIGINS:
        "https://drawsy.example, https://app.drawsy.example ",
      APP_SCENE_SIZE_LIMIT_BYTES: "10485760",
      FIREBASE_PROJECT_ID: "drawsy-production",
      R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "drawsy",
      R2_REGION: "auto",
      R2_KEY_PREFIX: "/workspace/",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    });

    expect(config).toEqual({
      env: "production",
      host: "0.0.0.0",
      port: 8080,
      allowedOrigins: new Set([
        "https://drawsy.example",
        "https://app.drawsy.example",
      ]),
      sceneSizeLimitBytes: 10_485_760,
      firebaseProjectId: "drawsy-production",
      r2: {
        endpointUrl: "https://account.r2.cloudflarestorage.com",
        bucketName: "drawsy",
        region: "auto",
        keyPrefix: "workspace/",
        accessKeyId: "key",
        secretAccessKey: "secret",
        encryptionKey: Buffer.alloc(32, 1),
      },
      kanban: {
        encryptionKey: Buffer.alloc(32, 1),
        encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
        encryptionKeyVersion: 1,
        emailDigestKey: Buffer.alloc(32, 1),
        sseHeartbeatMs: 45_000,
        eventRetentionMs: 30 * 24 * 60 * 60 * 1000,
        operationRetentionMs: 30 * 24 * 60 * 60 * 1000,
        invitesPerHour: 20,
        recentAuthMs: 300_000,
      },
      connectors: {
        googleWorkspace: undefined,
        notion: undefined,
        slack: undefined,
        github: undefined,
        successUrl: "http://localhost:3001/connectors-oauth-complete.html",
        encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
        encryptionKeyVersion: 1,
        stateTtlMs: 600_000,
        httpTimeoutMs: 15_000,
        aiGrantTtlMs: 120_000,
        aiMaxOutputBytes: 256 * 1024,
      },
    });
  });

  it("fails at startup when the Firebase project is not configured", () => {
    expect(() => loadConfig({})).toThrow("Invalid environment configuration");
  });

  it("rejects invalid ports", () => {
    expect(() =>
      loadConfig({
        APP_PORT: "70000",
        FIREBASE_PROJECT_ID: "drawsy-ai-dev",
        R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
        R2_BUCKET_NAME: "drawsy",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      }),
    ).toThrow("Invalid environment configuration");
  });

  it("loads previous Kanban encryption keys for rotation", () => {
    const current = Buffer.alloc(32, 2);
    const previous = Buffer.alloc(32, 1);
    const config = loadConfig({
      FIREBASE_PROJECT_ID: "drawsy-ai-dev",
      R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "drawsy",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
      KANBAN_ENCRYPTION_KEY: current.toString("base64"),
      KANBAN_ENCRYPTION_KEY_VERSION: "2",
      KANBAN_ENCRYPTION_PREVIOUS_KEYS: `1:${previous.toString("base64")}`,
    });

    expect(config.kanban.encryptionKeys.get(1)).toEqual(previous);
    expect(config.kanban.encryptionKeys.get(2)).toEqual(current);
  });

  it("configures Google Workspace connectors as one optional unit", () => {
    const encryptionKey = Buffer.alloc(32, 5);
    const config = loadConfig({
      FIREBASE_PROJECT_ID: "drawsy-ai-dev",
      R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "drawsy",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      WORKSPACE_ENCRYPTION_KEY: encryptionKey.toString("base64"),
      GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "google-secret",
      GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI:
        "http://127.0.0.1:3004/v1/connectors/google-workspace/oauth/callback",
      CONNECTORS_OAUTH_SUCCESS_URL: "http://localhost:3001",
    });

    expect(config.connectors).toEqual({
      googleWorkspace: {
        clientId: "google-client",
        clientSecret: "google-secret",
        redirectUri:
          "http://127.0.0.1:3004/v1/connectors/google-workspace/oauth/callback",
      },
      notion: undefined,
      slack: undefined,
      github: undefined,
      successUrl: "http://localhost:3001",
      encryptionKeys: new Map([[1, encryptionKey]]),
      encryptionKeyVersion: 1,
      stateTtlMs: 600_000,
      httpTimeoutMs: 15_000,
      aiGrantTtlMs: 120_000,
      aiMaxOutputBytes: 256 * 1024,
    });
  });

  it("rejects partial Google Workspace connector OAuth configuration", () => {
    expect(() =>
      loadConfig({
        FIREBASE_PROJECT_ID: "drawsy-ai-dev",
        R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
        R2_BUCKET_NAME: "drawsy",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "google-client",
      }),
    ).toThrow("all Google Workspace connector OAuth values");
  });

  it("rejects insecure connector OAuth URLs in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        FIREBASE_PROJECT_ID: "drawsy-ai-dev",
        R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
        R2_BUCKET_NAME: "drawsy",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        GITHUB_OAUTH_CLIENT_ID: "github-client",
        GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
        GITHUB_OAUTH_REDIRECT_URI:
          "http://drawsy.example/v1/connectors/github/oauth/callback",
        CONNECTORS_OAUTH_SUCCESS_URL:
          "https://drawsy.example/connectors-oauth-complete.html",
      }),
    ).toThrow("connector OAuth URLs must use HTTPS");
  });
});
