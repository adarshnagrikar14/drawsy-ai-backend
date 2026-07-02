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
  };
};
