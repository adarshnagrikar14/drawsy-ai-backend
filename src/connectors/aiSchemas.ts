import { z } from "zod";

import { connectorProviderIds } from "./types.js";

const boundedId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
      }),
    {
      message: "must not contain control characters",
    },
  );
const capability = z.enum([
  "mail",
  "calendar",
  "drive",
  "notion",
  "slack",
  "github",
  "read-ai",
  "fireflies",
  "aws",
]);
const remoteMcpCapability = z.enum(["read-ai", "fireflies"]);
const providerApiCapability = z.enum([
  "mail",
  "calendar",
  "drive",
  "notion",
  "slack",
  "github",
  "aws",
]);
const searchableProviderApiCapability = z.enum([
  "mail",
  "calendar",
  "drive",
  "notion",
  "slack",
  "github",
]);

export const connectorAiGrantRequestSchema = z
  .object({
    sessionId: boundedId,
    turnId: boundedId,
    connectionId: boundedId,
    capabilities: z
      .array(capability)
      .min(1)
      .max(6)
      .refine((values) => new Set(values).size === values.length, {
        message: "must not contain duplicate capabilities",
      }),
  })
  .strict();

const executionContextSchema = {
  sessionId: boundedId,
  turnId: boundedId,
  connectionId: boundedId,
};

const cursor = z.string().trim().min(1).max(4_096).optional();
const limit = z.number().int().min(1).max(100).optional();
const optionalText = z.string().trim().min(1).max(2_000).optional();
const isoTimestamp = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "must be an ISO 8601 timestamp",
  });
const githubRepository = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const githubPath = z
  .string()
  .trim()
  .max(2_048)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      value.split("/").every((segment) => segment && segment !== "..") &&
      [...value].every((character) => character.charCodeAt(0) > 31),
    { message: "must be a repository-relative path" },
  );
const githubRef = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
      }),
    { message: "must not contain control characters" },
  );
const githubPageCursor = z
  .string()
  .trim()
  .regex(/^\d{1,6}$/)
  .optional();
const awsRegion = z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/);
const remoteMcpToolName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const remoteMcpArguments = z
  .record(z.string().trim().min(1).max(128), z.unknown())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 64 * 1024,
    {
      message: "MCP tool arguments exceed the 64 KiB limit",
    },
  );

export const connectorAiExecutionRequestSchema = z.union([
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("aws"),
      kind: z.literal("aws_regions"),
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("aws"),
      kind: z.literal("aws_cloudformation_stacks"),
      region: awsRegion,
      cursor,
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("search"),
      capability: z.literal("aws"),
      query: z.string().trim().max(1_280),
      region: awsRegion,
      cursor,
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("search"),
      capability: searchableProviderApiCapability,
      query: z.string().trim().min(1).max(2_000),
      cursor,
      limit: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("github"),
      kind: z.literal("github_repository_contents"),
      repository: githubRepository,
      path: githubPath.optional(),
      ref: githubRef.optional(),
      cursor: githubPageCursor,
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("github"),
      kind: z.literal("github_issues"),
      repository: githubRepository,
      state: z.enum(["open", "closed", "all"]).optional(),
      labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      since: isoTimestamp.optional(),
      sort: z.enum(["created", "updated", "comments"]).optional(),
      direction: z.enum(["asc", "desc"]).optional(),
      cursor: githubPageCursor,
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("github"),
      kind: z.literal("github_pull_requests"),
      repository: githubRepository,
      state: z.enum(["open", "closed", "all"]).optional(),
      head: z.string().trim().min(1).max(256).optional(),
      base: z.string().trim().min(1).max(256).optional(),
      sort: z
        .enum(["created", "updated", "popularity", "long-running"])
        .optional(),
      direction: z.enum(["asc", "desc"]).optional(),
      cursor: githubPageCursor,
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("mail"),
      kind: z.literal("mail_messages"),
      query: optionalText,
      after: isoTimestamp.optional(),
      before: isoTimestamp.optional(),
      from: z.string().trim().min(1).max(320).optional(),
      to: z.string().trim().min(1).max(320).optional(),
      subject: z.string().trim().min(1).max(1_000).optional(),
      label: z.string().trim().min(1).max(256).optional(),
      includeSpamTrash: z.boolean().optional(),
      cursor,
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("calendar"),
      kind: z.literal("calendars"),
      cursor,
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("slack"),
      kind: z.literal("slack_channels"),
      cursor,
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("slack"),
      kind: z.literal("slack_messages"),
      channelId: z.string().trim().min(1).max(256),
      startTime: isoTimestamp.optional(),
      endTime: isoTimestamp.optional(),
      cursor,
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("calendar"),
      kind: z.literal("calendar_events"),
      calendarId: z.string().trim().min(1).max(1_024).optional(),
      startTime: isoTimestamp,
      endTime: isoTimestamp,
      timeZone: z.string().trim().min(1).max(128).optional(),
      query: optionalText,
      cursor,
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("drive"),
      kind: z.literal("drive_files"),
      query: optionalText,
      mimeType: z.string().trim().min(1).max(256).optional(),
      orderBy: z
        .enum(["modifiedTime desc", "createdTime desc", "name"])
        .optional(),
      cursor,
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("notion"),
      kind: z.literal("notion_content"),
      query: optionalText,
      object: z.enum(["page", "data_source"]).optional(),
      sortDirection: z.enum(["ascending", "descending"]).optional(),
      cursor,
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("list"),
      capability: z.literal("github"),
      kind: z.literal("github_repositories"),
      query: z.string().trim().min(1).max(256).optional(),
      owner: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)
        .optional(),
      visibility: z.enum(["all", "public", "private"]).optional(),
      cursor: z
        .string()
        .trim()
        .regex(/^\d{1,3}$/)
        .optional(),
      limit,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("read"),
      capability: providerApiCapability,
      resourceId: z.string().trim().min(1).max(4_096),
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("mcp_tools"),
      capability: remoteMcpCapability,
    })
    .strict(),
  z
    .object({
      ...executionContextSchema,
      operation: z.literal("mcp_call"),
      capability: remoteMcpCapability,
      toolName: remoteMcpToolName,
      arguments: remoteMcpArguments,
    })
    .strict(),
]);

export const connectorAiGrantClaimsSchema = z
  .object({
    version: z.literal(1),
    audience: z.literal("drawsy-connector-ai"),
    subject: boundedId,
    sessionId: boundedId,
    turnId: boundedId,
    connectionId: boundedId,
    capabilities: z.array(capability).min(1).max(6),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    grantId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  })
  .strict();

export const connectorAiResourceIdSchema = z
  .object({
    providerId: z.enum(connectorProviderIds),
    capability,
    type: z.string().min(1).max(64),
    id: z.string().min(1).max(2_048),
    parentId: z.string().min(1).max(2_048).optional(),
    number: z.number().int().positive().optional(),
    ref: z.string().min(1).max(256).optional(),
  })
  .strict();
