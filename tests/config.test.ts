import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const githubPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
})
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

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
        readAi: undefined,
        fireflies: undefined,
        aws: undefined,
        successUrl: "http://localhost:3001/connectors-oauth-complete.html",
        encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
        encryptionKeyVersion: 1,
        stateTtlMs: 600_000,
        httpTimeoutMs: 15_000,
        aiGrantTtlMs: 600_000,
        aiMaxOutputBytes: 256 * 1024,
      },
    });
  });

  it("fails at startup when the Firebase project is not configured", () => {
    expect(() => loadConfig({})).toThrow("Invalid environment configuration");
  });

  it("requires HydraDB credentials when Hydra is enabled", () => {
    expect(() =>
      loadConfig({
        FIREBASE_PROJECT_ID: "drawsy-ai-dev",
        R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
        R2_BUCKET_NAME: "drawsy",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        HYDRA_ENABLED: "true",
      }),
    ).toThrow(
      "configure hosted HydraDB credentials and/or the local HydraDB memory token",
    );
  });

  it("normalizes the current HydraDB v2 configuration", () => {
    const config = loadConfig({
      FIREBASE_PROJECT_ID: "drawsy-ai-dev",
      R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "drawsy",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      HYDRA_ENABLED: "true",
      HYDRA_DB_API_KEY: "hydra-key",
      HYDRA_DB_DATABASE: "drawsy-production",
      HYDRA_SYNC_INTERVAL_SECONDS: "120",
      HYDRA_SYNC_PAGE_SIZE: "25",
      HYDRA_QUERY_MAX_RESULTS: "7",
    });

    expect(config.hydra).toEqual({
      enabled: true,
      hosted: {
        apiKey: "hydra-key",
        database: "drawsy-production",
        baseUrl: "https://api.hydradb.com",
        timeoutSeconds: 30,
        maxRetries: 2,
        queryMaxResults: 7,
      },
      timeoutSeconds: 30,
      maxRetries: 2,
      syncIntervalMs: 120_000,
      syncPageSize: 25,
      queryMaxResults: 7,
    });
  });

  it("loads the self-hosted HydraDB OSS graph configuration", () => {
    const config = loadConfig({
      FIREBASE_PROJECT_ID: "drawsy-ai-dev",
      R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "drawsy",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      HYDRA_ENABLED: "true",
      HYDRA_DB_PROVIDER: "oss",
      HYDRA_DB_AUTH_TOKEN: "local-graph-token",
      HYDRA_DB_BASE_URL: "http://127.0.0.1:18443",
      HYDRA_DB_NAMESPACE: "drawsy",
      HYDRA_DB_GRAPH_ID: "default",
      HYDRA_DB_CELL_ID: "cell-0",
    });

    expect(config.hydra).toEqual({
      enabled: true,
      memory: {
        authToken: "local-graph-token",
        baseUrl: "http://127.0.0.1:18443",
        namespace: "drawsy",
        graphId: "default",
        cellId: "cell-0",
        timeoutSeconds: 30,
        maxRetries: 2,
        queryMaxResults: 10,
      },
      timeoutSeconds: 30,
      maxRetries: 2,
      syncIntervalMs: 300_000,
      syncPageSize: 50,
      queryMaxResults: 10,
    });
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
      readAi: undefined,
      fireflies: undefined,
      aws: undefined,
      successUrl: "http://localhost:3001",
      encryptionKeys: new Map([[1, encryptionKey]]),
      encryptionKeyVersion: 1,
      stateTtlMs: 600_000,
      httpTimeoutMs: 15_000,
      aiGrantTtlMs: 600_000,
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

  it("configures official remote MCP OAuth clients as public PKCE clients", () => {
    const config = loadConfig({
      FIREBASE_PROJECT_ID: "drawsy-ai-dev",
      R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "drawsy",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      READ_AI_MCP_OAUTH_CLIENT_ID: "read-client",
      READ_AI_MCP_OAUTH_REDIRECT_URI:
        "http://127.0.0.1:3004/v1/connectors/read-ai/oauth/callback",
      FIREFLIES_MCP_OAUTH_CLIENT_ID: "fireflies-client",
      FIREFLIES_MCP_OAUTH_REDIRECT_URI:
        "http://127.0.0.1:3004/v1/connectors/fireflies/oauth/callback",
    });

    expect(config.connectors?.readAi).toEqual({
      clientId: "read-client",
      redirectUri: "http://127.0.0.1:3004/v1/connectors/read-ai/oauth/callback",
    });
    expect(config.connectors?.fireflies).toEqual({
      clientId: "fireflies-client",
      redirectUri:
        "http://127.0.0.1:3004/v1/connectors/fireflies/oauth/callback",
    });
  });

  it("rejects partial remote MCP connector OAuth configuration", () => {
    expect(() =>
      loadConfig({
        FIREBASE_PROJECT_ID: "drawsy-ai-dev",
        R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
        R2_BUCKET_NAME: "drawsy",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        READ_AI_MCP_OAUTH_CLIENT_ID: "read-client",
      }),
    ).toThrow("all Read AI connector OAuth values");
  });

  it("configures the AWS cross-account connector as one unit", () => {
    const config = loadConfig({
      FIREBASE_PROJECT_ID: "drawsy-ai-dev",
      R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "drawsy",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      AWS_CONNECTOR_PRINCIPAL_ARN:
        "arn:aws:iam::123456789012:role/DrawsyBackendRole",
      AWS_CONNECTOR_TEMPLATE_URL:
        "https://drawsy-templates.s3.ap-south-1.amazonaws.com/aws/read-role.yaml",
      AWS_CONNECTOR_ROLE_NAME: "DrawsyReadRole",
      AWS_CONNECTOR_SETUP_REGION: "ap-south-1",
    });

    expect(config.connectors?.aws).toEqual({
      principalArn: "arn:aws:iam::123456789012:role/DrawsyBackendRole",
      templateUrl:
        "https://drawsy-templates.s3.ap-south-1.amazonaws.com/aws/read-role.yaml",
      templateS3: undefined,
      roleName: "DrawsyReadRole",
      setupRegion: "ap-south-1",
    });
  });

  it("rejects partial or insecure AWS connector configuration", () => {
    const base = {
      FIREBASE_PROJECT_ID: "drawsy-ai-dev",
      R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "drawsy",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    };
    expect(() =>
      loadConfig({
        ...base,
        AWS_CONNECTOR_PRINCIPAL_ARN:
          "arn:aws:iam::123456789012:role/DrawsyBackendRole",
      }),
    ).toThrow("principal ARN and exactly one template source");
    expect(() =>
      loadConfig({
        ...base,
        AWS_CONNECTOR_PRINCIPAL_ARN:
          "arn:aws:iam::123456789012:role/DrawsyBackendRole",
        AWS_CONNECTOR_TEMPLATE_URL: "http://assets.example/read-role.yaml",
      }),
    ).toThrow("AWS_CONNECTOR_TEMPLATE_URL must be a supported Amazon S3 URL");
  });

  it("configures a private S3 template signed by the backend", () => {
    const config = loadConfig({
      FIREBASE_PROJECT_ID: "drawsy-ai-dev",
      R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "drawsy",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      AWS_CONNECTOR_PRINCIPAL_ARN:
        "arn:aws:iam::123456789012:role/DrawsyBackendRole",
      AWS_CONNECTOR_TEMPLATE_S3_BUCKET: "drawsy-templates",
      AWS_CONNECTOR_TEMPLATE_S3_KEY: "aws/read-role.yaml",
      AWS_CONNECTOR_TEMPLATE_S3_REGION: "ap-south-1",
    });

    expect(config.connectors?.aws).toMatchObject({
      templateUrl: undefined,
      templateS3: {
        bucket: "drawsy-templates",
        key: "aws/read-role.yaml",
        region: "ap-south-1",
      },
    });
  });

  it("configures a GitHub App installation connector", () => {
    const config = loadConfig({
      FIREBASE_PROJECT_ID: "drawsy-ai-dev",
      R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
      R2_BUCKET_NAME: "drawsy",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      GITHUB_APP_ID: "4298788",
      GITHUB_APP_SLUG: "drawsy-ai-connector",
      GITHUB_APP_PRIVATE_KEY_BASE64:
        Buffer.from(githubPrivateKey).toString("base64"),
    });

    expect(config.connectors?.github).toEqual({
      appId: 4_298_788,
      appSlug: "drawsy-ai-connector",
      privateKey: githubPrivateKey,
    });
  });

  it("rejects partial GitHub App configuration", () => {
    expect(() =>
      loadConfig({
        FIREBASE_PROJECT_ID: "drawsy-ai-dev",
        R2_ENDPOINT_URL: "https://account.r2.cloudflarestorage.com",
        R2_BUCKET_NAME: "drawsy",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        WORKSPACE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        GITHUB_APP_ID: "4298788",
      }),
    ).toThrow("GITHUB_APP_ID");
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
        GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "google-client",
        GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "google-secret",
        GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI:
          "http://drawsy.example/v1/connectors/google-workspace/oauth/callback",
        CONNECTORS_OAUTH_SUCCESS_URL:
          "https://drawsy.example/connectors-oauth-complete.html",
      }),
    ).toThrow("connector OAuth URLs must use HTTPS");
  });
});
