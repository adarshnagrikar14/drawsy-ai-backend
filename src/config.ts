import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";

const optionalText = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);
const optionalUrl = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.url().optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_HOST: z.string().trim().min(1).default("127.0.0.1"),
  APP_PORT: z.coerce.number().int().min(1).max(65_535).default(3004),
  APP_ALLOWED_ORIGINS: z.string().default(""),
  APP_SCENE_SIZE_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(50 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  FIREBASE_PROJECT_ID: z.string().trim().min(1),
  R2_ENDPOINT_URL: z.url(),
  R2_BUCKET_NAME: z.string().trim().min(1),
  R2_REGION: z.string().trim().min(1).default("auto"),
  R2_KEY_PREFIX: z.string().trim().default("workspace/"),
  R2_ACCESS_KEY_ID: z.string().trim().min(1),
  R2_SECRET_ACCESS_KEY: z.string().trim().min(1),
  WORKSPACE_ENCRYPTION_KEY: z
    .string()
    .trim()
    .transform((value, context) => {
      const key = Buffer.from(value, "base64");
      if (key.byteLength !== 32) {
        context.addIssue({
          code: "custom",
          message: "must decode to exactly 32 bytes",
        });
        return z.NEVER;
      }
      return key;
    }),
  KANBAN_ENCRYPTION_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value, context) => {
      if (!value) {
        return undefined;
      }
      const key = Buffer.from(value, "base64");
      if (key.byteLength !== 32) {
        context.addIssue({
          code: "custom",
          message: "must decode to exactly 32 bytes",
        });
        return z.NEVER;
      }
      return key;
    }),
  KANBAN_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  KANBAN_ENCRYPTION_PREVIOUS_KEYS: z.string().trim().default(""),
  KANBAN_EMAIL_DIGEST_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value, context) => {
      if (!value) {
        return undefined;
      }
      const key = Buffer.from(value, "base64");
      if (key.byteLength !== 32) {
        context.addIssue({
          code: "custom",
          message: "must decode to exactly 32 bytes",
        });
        return z.NEVER;
      }
      return key;
    }),
  KANBAN_SSE_HEARTBEAT_MS: z.coerce
    .number()
    .int()
    .min(15_000)
    .max(120_000)
    .default(45_000),
  KANBAN_EVENT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(7)
    .max(90)
    .default(30),
  KANBAN_OPERATION_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(7)
    .max(90)
    .default(30),
  KANBAN_INVITES_PER_HOUR: z.coerce.number().int().min(1).max(100).default(20),
  KANBAN_RECENT_AUTH_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(300),
  ATLASSIAN_OAUTH_CLIENT_ID: optionalText,
  ATLASSIAN_OAUTH_CLIENT_SECRET: optionalText,
  ATLASSIAN_OAUTH_REDIRECT_URI: optionalUrl,
  JIRA_OAUTH_SUCCESS_URL: optionalUrl,
  JIRA_ENCRYPTION_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value, context) => {
      if (!value) {
        return undefined;
      }
      const key = Buffer.from(value, "base64");
      if (key.byteLength !== 32) {
        context.addIssue({
          code: "custom",
          message: "must decode to exactly 32 bytes",
        });
        return z.NEVER;
      }
      return key;
    }),
  JIRA_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  JIRA_ENCRYPTION_PREVIOUS_KEYS: z.string().trim().default(""),
  JIRA_OAUTH_STATE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(1800)
    .default(600),
  JIRA_HTTP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60_000)
    .default(15_000),
  GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: optionalText,
  GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: optionalText,
  GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI: optionalUrl,
  NOTION_OAUTH_CLIENT_ID: optionalText,
  NOTION_OAUTH_CLIENT_SECRET: optionalText,
  NOTION_OAUTH_REDIRECT_URI: optionalUrl,
  SLACK_OAUTH_CLIENT_ID: optionalText,
  SLACK_OAUTH_CLIENT_SECRET: optionalText,
  SLACK_OAUTH_REDIRECT_URI: optionalUrl,
  READ_AI_MCP_OAUTH_CLIENT_ID: optionalText,
  READ_AI_MCP_OAUTH_REDIRECT_URI: optionalUrl,
  FIREFLIES_MCP_OAUTH_CLIENT_ID: optionalText,
  FIREFLIES_MCP_OAUTH_REDIRECT_URI: optionalUrl,
  AWS_CONNECTOR_PRINCIPAL_ARN: optionalText,
  AWS_CONNECTOR_TEMPLATE_URL: optionalUrl,
  AWS_CONNECTOR_ROLE_NAME: optionalText,
  AWS_CONNECTOR_SETUP_REGION: optionalText,
  GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
  GITHUB_APP_SLUG: optionalText,
  GITHUB_APP_PRIVATE_KEY_BASE64: optionalText,
  GITHUB_APP_PRIVATE_KEY_PATH: optionalText,
  CONNECTORS_OAUTH_SUCCESS_URL: optionalUrl,
  CONNECTOR_ENCRYPTION_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value, context) => {
      if (!value) {
        return undefined;
      }
      const key = Buffer.from(value, "base64");
      if (key.byteLength !== 32) {
        context.addIssue({
          code: "custom",
          message: "must decode to exactly 32 bytes",
        });
        return z.NEVER;
      }
      return key;
    }),
  CONNECTOR_ENCRYPTION_KEY_VERSION: z.coerce
    .number()
    .int()
    .positive()
    .default(1),
  CONNECTOR_ENCRYPTION_PREVIOUS_KEYS: z.string().trim().default(""),
  CONNECTOR_OAUTH_STATE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(1800)
    .default(600),
  CONNECTOR_HTTP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60_000)
    .default(15_000),
  CONNECTOR_AI_GRANT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(1800)
    .default(600),
  CONNECTOR_AI_MAX_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(16 * 1024)
    .max(1024 * 1024)
    .default(256 * 1024),
});

export type AppConfig = {
  env: z.infer<typeof environmentSchema>["NODE_ENV"];
  host: string;
  port: number;
  allowedOrigins: ReadonlySet<string>;
  sceneSizeLimitBytes: number;
  firebaseProjectId: string;
  r2: {
    endpointUrl: string;
    bucketName: string;
    region: string;
    keyPrefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    encryptionKey: Buffer;
  };
  kanban: {
    encryptionKey: Buffer;
    encryptionKeys: ReadonlyMap<number, Buffer>;
    encryptionKeyVersion: number;
    emailDigestKey: Buffer;
    sseHeartbeatMs: number;
    eventRetentionMs: number;
    operationRetentionMs: number;
    invitesPerHour: number;
    recentAuthMs: number;
  };
  jira?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    successUrl: string;
    encryptionKeys: ReadonlyMap<number, Buffer>;
    encryptionKeyVersion: number;
    stateTtlMs: number;
    httpTimeoutMs: number;
  };
  connectors?: {
    googleWorkspace?: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    };
    notion?: { clientId: string; clientSecret: string; redirectUri: string };
    slack?: { clientId: string; clientSecret: string; redirectUri: string };
    github?: { appId: number; appSlug: string; privateKey: string };
    readAi?: { clientId: string; redirectUri: string };
    fireflies?: { clientId: string; redirectUri: string };
    aws?: {
      principalArn: string;
      templateUrl: string;
      roleName: string;
      setupRegion: string;
    };
    successUrl: string;
    encryptionKeys: ReadonlyMap<number, Buffer>;
    encryptionKeyVersion: number;
    stateTtlMs: number;
    httpTimeoutMs: number;
    aiGrantTtlMs: number;
    aiMaxOutputBytes: number;
  };
};

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig => {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration: ${z.prettifyError(parsed.error)}`,
    );
  }

  const currentKanbanKey =
    parsed.data.KANBAN_ENCRYPTION_KEY || parsed.data.WORKSPACE_ENCRYPTION_KEY;
  const kanbanEncryptionKeys = new Map<number, Buffer>([
    [parsed.data.KANBAN_ENCRYPTION_KEY_VERSION, currentKanbanKey],
  ]);
  for (const entry of parsed.data.KANBAN_ENCRYPTION_PREVIOUS_KEYS.split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(":");
    const version = Number(entry.slice(0, separator));
    const key = Buffer.from(entry.slice(separator + 1), "base64");
    if (
      separator <= 0 ||
      !Number.isInteger(version) ||
      version <= 0 ||
      key.byteLength !== 32 ||
      kanbanEncryptionKeys.has(version)
    ) {
      throw new Error("Invalid KANBAN_ENCRYPTION_PREVIOUS_KEYS configuration");
    }
    kanbanEncryptionKeys.set(version, key);
  }

  const jiraOAuthValues = [
    parsed.data.ATLASSIAN_OAUTH_CLIENT_ID,
    parsed.data.ATLASSIAN_OAUTH_CLIENT_SECRET,
    parsed.data.ATLASSIAN_OAUTH_REDIRECT_URI,
    parsed.data.JIRA_OAUTH_SUCCESS_URL,
  ];
  const hasAnyJiraOAuthValue = jiraOAuthValues.some(Boolean);
  const hasAllJiraOAuthValues = jiraOAuthValues.every(Boolean);
  if (hasAnyJiraOAuthValue && !hasAllJiraOAuthValues) {
    throw new Error(
      "Invalid environment configuration: all Jira OAuth values must be configured together",
    );
  }
  const jiraCurrentKey =
    parsed.data.JIRA_ENCRYPTION_KEY || parsed.data.WORKSPACE_ENCRYPTION_KEY;
  const jiraEncryptionKeys = new Map<number, Buffer>([
    [parsed.data.JIRA_ENCRYPTION_KEY_VERSION, jiraCurrentKey],
  ]);
  for (const entry of parsed.data.JIRA_ENCRYPTION_PREVIOUS_KEYS.split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(":");
    const version = Number(entry.slice(0, separator));
    const key = Buffer.from(entry.slice(separator + 1), "base64");
    if (
      separator <= 0 ||
      !Number.isInteger(version) ||
      version <= 0 ||
      key.byteLength !== 32 ||
      jiraEncryptionKeys.has(version)
    ) {
      throw new Error("Invalid JIRA_ENCRYPTION_PREVIOUS_KEYS configuration");
    }
    jiraEncryptionKeys.set(version, key);
  }

  const googleWorkspaceOAuthValues = [
    parsed.data.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
    parsed.data.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
    parsed.data.GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI,
  ];
  const notionOAuthValues = [
    parsed.data.NOTION_OAUTH_CLIENT_ID,
    parsed.data.NOTION_OAUTH_CLIENT_SECRET,
    parsed.data.NOTION_OAUTH_REDIRECT_URI,
  ];
  const slackOAuthValues = [
    parsed.data.SLACK_OAUTH_CLIENT_ID,
    parsed.data.SLACK_OAUTH_CLIENT_SECRET,
    parsed.data.SLACK_OAUTH_REDIRECT_URI,
  ];
  const readAiOAuthValues = [
    parsed.data.READ_AI_MCP_OAUTH_CLIENT_ID,
    parsed.data.READ_AI_MCP_OAUTH_REDIRECT_URI,
  ];
  const firefliesOAuthValues = [
    parsed.data.FIREFLIES_MCP_OAUTH_CLIENT_ID,
    parsed.data.FIREFLIES_MCP_OAUTH_REDIRECT_URI,
  ];
  const awsConnectorValues = [
    parsed.data.AWS_CONNECTOR_PRINCIPAL_ARN,
    parsed.data.AWS_CONNECTOR_TEMPLATE_URL,
  ];
  const validateProviderOAuth = (name: string, values: unknown[]) => {
    if (values.some(Boolean) && !values.every(Boolean)) {
      throw new Error(
        `Invalid environment configuration: all ${name} connector OAuth values must be configured together`,
      );
    }
    return values.every(Boolean);
  };
  const hasGoogleWorkspaceOAuth = validateProviderOAuth(
    "Google Workspace",
    googleWorkspaceOAuthValues,
  );
  const hasNotionOAuth = validateProviderOAuth("Notion", notionOAuthValues);
  const hasSlackOAuth = validateProviderOAuth("Slack", slackOAuthValues);
  const hasReadAiOAuth = validateProviderOAuth("Read AI", readAiOAuthValues);
  const hasFirefliesOAuth = validateProviderOAuth(
    "Fireflies",
    firefliesOAuthValues,
  );
  if (awsConnectorValues.some(Boolean) && !awsConnectorValues.every(Boolean)) {
    throw new Error(
      "Invalid environment configuration: all AWS connector values must be configured together",
    );
  }
  const hasAwsConnector = awsConnectorValues.every(Boolean);
  if (
    parsed.data.AWS_CONNECTOR_TEMPLATE_URL &&
    new URL(parsed.data.AWS_CONNECTOR_TEMPLATE_URL).protocol !== "https:"
  ) {
    throw new Error(
      "Invalid environment configuration: AWS_CONNECTOR_TEMPLATE_URL must use HTTPS",
    );
  }
  if (
    parsed.data.AWS_CONNECTOR_PRINCIPAL_ARN &&
    !/^arn:aws(?:-[a-z]+)?:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/.test(
      parsed.data.AWS_CONNECTOR_PRINCIPAL_ARN,
    )
  ) {
    throw new Error(
      "Invalid environment configuration: AWS_CONNECTOR_PRINCIPAL_ARN must be an IAM role ARN",
    );
  }
  const awsRoleName =
    parsed.data.AWS_CONNECTOR_ROLE_NAME || "DrawsyInfrastructureReadRole";
  if (!/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(awsRoleName)) {
    throw new Error(
      "Invalid environment configuration: AWS_CONNECTOR_ROLE_NAME is invalid",
    );
  }
  const awsSetupRegion = parsed.data.AWS_CONNECTOR_SETUP_REGION || "us-east-1";
  if (!/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/.test(awsSetupRegion)) {
    throw new Error(
      "Invalid environment configuration: AWS_CONNECTOR_SETUP_REGION is invalid",
    );
  }
  const githubPrivateKeySources = [
    parsed.data.GITHUB_APP_PRIVATE_KEY_BASE64,
    parsed.data.GITHUB_APP_PRIVATE_KEY_PATH,
  ].filter(Boolean);
  const hasAnyGithubAppValue = Boolean(
    parsed.data.GITHUB_APP_ID ||
    parsed.data.GITHUB_APP_SLUG ||
    githubPrivateKeySources.length,
  );
  if (
    hasAnyGithubAppValue &&
    (!parsed.data.GITHUB_APP_ID ||
      !parsed.data.GITHUB_APP_SLUG ||
      githubPrivateKeySources.length !== 1)
  ) {
    throw new Error(
      "Invalid environment configuration: GITHUB_APP_ID, GITHUB_APP_SLUG, and exactly one GitHub App private key source are required together",
    );
  }
  const hasGithubApp = hasAnyGithubAppValue;
  let githubPrivateKey: string | undefined;
  if (hasGithubApp) {
    try {
      githubPrivateKey = parsed.data.GITHUB_APP_PRIVATE_KEY_BASE64
        ? Buffer.from(
            parsed.data.GITHUB_APP_PRIVATE_KEY_BASE64,
            "base64",
          ).toString("utf8")
        : readFileSync(parsed.data.GITHUB_APP_PRIVATE_KEY_PATH!, "utf8");
      createPrivateKey(githubPrivateKey);
    } catch {
      throw new Error(
        "Invalid environment configuration: GitHub App private key is unreadable or invalid",
      );
    }
  }
  const hasAnyConnectorProvider =
    hasGoogleWorkspaceOAuth ||
    hasNotionOAuth ||
    hasSlackOAuth ||
    hasGithubApp ||
    hasReadAiOAuth ||
    hasFirefliesOAuth ||
    hasAwsConnector;
  if (
    hasAnyConnectorProvider &&
    parsed.data.NODE_ENV === "production" &&
    !parsed.data.CONNECTORS_OAUTH_SUCCESS_URL
  ) {
    throw new Error(
      "Invalid environment configuration: CONNECTORS_OAUTH_SUCCESS_URL is required when connectors are enabled in production",
    );
  }
  if (hasAnyConnectorProvider && parsed.data.NODE_ENV === "production") {
    const oauthUrls = [
      parsed.data.CONNECTORS_OAUTH_SUCCESS_URL,
      parsed.data.GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI,
      parsed.data.NOTION_OAUTH_REDIRECT_URI,
      parsed.data.SLACK_OAUTH_REDIRECT_URI,
      parsed.data.READ_AI_MCP_OAUTH_REDIRECT_URI,
      parsed.data.FIREFLIES_MCP_OAUTH_REDIRECT_URI,
    ].filter((value): value is string => Boolean(value));
    if (oauthUrls.some((value) => new URL(value).protocol !== "https:")) {
      throw new Error(
        "Invalid environment configuration: connector OAuth URLs must use HTTPS in production",
      );
    }
  }
  const connectorCurrentKey =
    parsed.data.CONNECTOR_ENCRYPTION_KEY ||
    parsed.data.WORKSPACE_ENCRYPTION_KEY;
  const connectorEncryptionKeys = new Map<number, Buffer>([
    [parsed.data.CONNECTOR_ENCRYPTION_KEY_VERSION, connectorCurrentKey],
  ]);
  for (const entry of parsed.data.CONNECTOR_ENCRYPTION_PREVIOUS_KEYS.split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(":");
    const version = Number(entry.slice(0, separator));
    const key = Buffer.from(entry.slice(separator + 1), "base64");
    if (
      separator <= 0 ||
      !Number.isInteger(version) ||
      version <= 0 ||
      key.byteLength !== 32 ||
      connectorEncryptionKeys.has(version)
    ) {
      throw new Error(
        "Invalid CONNECTOR_ENCRYPTION_PREVIOUS_KEYS configuration",
      );
    }
    connectorEncryptionKeys.set(version, key);
  }

  return {
    env: parsed.data.NODE_ENV,
    host: parsed.data.APP_HOST,
    port: parsed.data.APP_PORT,
    allowedOrigins: new Set(
      parsed.data.APP_ALLOWED_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
    sceneSizeLimitBytes: parsed.data.APP_SCENE_SIZE_LIMIT_BYTES,
    firebaseProjectId: parsed.data.FIREBASE_PROJECT_ID,
    r2: {
      endpointUrl: parsed.data.R2_ENDPOINT_URL.replace(/\/$/, ""),
      bucketName: parsed.data.R2_BUCKET_NAME,
      region: parsed.data.R2_REGION,
      keyPrefix: parsed.data.R2_KEY_PREFIX
        ? `${parsed.data.R2_KEY_PREFIX.replace(/^\/+|\/+$/g, "")}/`
        : "",
      accessKeyId: parsed.data.R2_ACCESS_KEY_ID,
      secretAccessKey: parsed.data.R2_SECRET_ACCESS_KEY,
      encryptionKey: parsed.data.WORKSPACE_ENCRYPTION_KEY,
    },
    kanban: {
      encryptionKey: currentKanbanKey,
      encryptionKeys: kanbanEncryptionKeys,
      encryptionKeyVersion: parsed.data.KANBAN_ENCRYPTION_KEY_VERSION,
      emailDigestKey:
        parsed.data.KANBAN_EMAIL_DIGEST_KEY ||
        parsed.data.WORKSPACE_ENCRYPTION_KEY,
      sseHeartbeatMs: parsed.data.KANBAN_SSE_HEARTBEAT_MS,
      eventRetentionMs:
        parsed.data.KANBAN_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      operationRetentionMs:
        parsed.data.KANBAN_OPERATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      invitesPerHour: parsed.data.KANBAN_INVITES_PER_HOUR,
      recentAuthMs: parsed.data.KANBAN_RECENT_AUTH_SECONDS * 1000,
    },
    jira: hasAllJiraOAuthValues
      ? {
          clientId: parsed.data.ATLASSIAN_OAUTH_CLIENT_ID!,
          clientSecret: parsed.data.ATLASSIAN_OAUTH_CLIENT_SECRET!,
          redirectUri: parsed.data.ATLASSIAN_OAUTH_REDIRECT_URI!,
          successUrl: parsed.data.JIRA_OAUTH_SUCCESS_URL!,
          encryptionKeys: jiraEncryptionKeys,
          encryptionKeyVersion: parsed.data.JIRA_ENCRYPTION_KEY_VERSION,
          stateTtlMs: parsed.data.JIRA_OAUTH_STATE_TTL_SECONDS * 1000,
          httpTimeoutMs: parsed.data.JIRA_HTTP_TIMEOUT_MS,
        }
      : undefined,
    connectors: {
      googleWorkspace: hasGoogleWorkspaceOAuth
        ? {
            clientId: parsed.data.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID!,
            clientSecret: parsed.data.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET!,
            redirectUri: parsed.data.GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI!,
          }
        : undefined,
      notion: hasNotionOAuth
        ? {
            clientId: parsed.data.NOTION_OAUTH_CLIENT_ID!,
            clientSecret: parsed.data.NOTION_OAUTH_CLIENT_SECRET!,
            redirectUri: parsed.data.NOTION_OAUTH_REDIRECT_URI!,
          }
        : undefined,
      slack: hasSlackOAuth
        ? {
            clientId: parsed.data.SLACK_OAUTH_CLIENT_ID!,
            clientSecret: parsed.data.SLACK_OAUTH_CLIENT_SECRET!,
            redirectUri: parsed.data.SLACK_OAUTH_REDIRECT_URI!,
          }
        : undefined,
      github: hasGithubApp
        ? {
            appId: parsed.data.GITHUB_APP_ID!,
            appSlug: parsed.data.GITHUB_APP_SLUG!,
            privateKey: githubPrivateKey!,
          }
        : undefined,
      readAi: hasReadAiOAuth
        ? {
            clientId: parsed.data.READ_AI_MCP_OAUTH_CLIENT_ID!,
            redirectUri: parsed.data.READ_AI_MCP_OAUTH_REDIRECT_URI!,
          }
        : undefined,
      fireflies: hasFirefliesOAuth
        ? {
            clientId: parsed.data.FIREFLIES_MCP_OAUTH_CLIENT_ID!,
            redirectUri: parsed.data.FIREFLIES_MCP_OAUTH_REDIRECT_URI!,
          }
        : undefined,
      aws: hasAwsConnector
        ? {
            principalArn: parsed.data.AWS_CONNECTOR_PRINCIPAL_ARN!,
            templateUrl: parsed.data.AWS_CONNECTOR_TEMPLATE_URL!,
            roleName: awsRoleName,
            setupRegion: awsSetupRegion,
          }
        : undefined,
      successUrl:
        parsed.data.CONNECTORS_OAUTH_SUCCESS_URL ||
        "http://localhost:3001/connectors-oauth-complete.html",
      encryptionKeys: connectorEncryptionKeys,
      encryptionKeyVersion: parsed.data.CONNECTOR_ENCRYPTION_KEY_VERSION,
      stateTtlMs: parsed.data.CONNECTOR_OAUTH_STATE_TTL_SECONDS * 1000,
      httpTimeoutMs: parsed.data.CONNECTOR_HTTP_TIMEOUT_MS,
      aiGrantTtlMs: parsed.data.CONNECTOR_AI_GRANT_TTL_SECONDS * 1000,
      aiMaxOutputBytes: parsed.data.CONNECTOR_AI_MAX_OUTPUT_BYTES,
    },
  };
};
