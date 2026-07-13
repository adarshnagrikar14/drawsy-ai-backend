import { z } from "zod";

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
  ATLASSIAN_OAUTH_CLIENT_ID: z.string().trim().min(1).optional(),
  ATLASSIAN_OAUTH_CLIENT_SECRET: z.string().trim().min(1).optional(),
  ATLASSIAN_OAUTH_REDIRECT_URI: z.url().optional(),
  JIRA_OAUTH_SUCCESS_URL: z.url().optional(),
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
  };
};
