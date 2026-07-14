import { z } from "zod";

import { ApiError } from "../http/apiError.js";
import { connectorAiResourceIdSchema } from "./aiSchemas.js";

import type {
  ConnectorAiExecutionRequest,
  ConnectorAiExecutionResult,
  ConnectorAiItem,
  ConnectorCapability,
  ConnectorProviderId,
} from "./types.js";

const GOOGLE_GMAIL_API = "https://gmail.googleapis.com";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com";
const GOOGLE_DRIVE_API = "https://www.googleapis.com";
const NOTION_API = "https://api.notion.com";
const SLACK_API = "https://slack.com";
const GITHUB_API = "https://api.github.com";
const NOTION_VERSION = "2026-03-11";
const GITHUB_VERSION = "2022-11-28";
const ALLOWED_PROVIDER_HOSTS = new Set([
  "gmail.googleapis.com",
  "www.googleapis.com",
  "api.notion.com",
  "slack.com",
  "api.github.com",
]);

type ResourceId = z.infer<typeof connectorAiResourceIdSchema>;

const gmailListSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).optional(),
  nextPageToken: z.string().optional(),
});
type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};
const gmailPartSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(gmailPartSchema).optional(),
  }),
);
const gmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  snippet: z.string().default(""),
  internalDate: z.string().optional(),
  payload: gmailPartSchema
    .and(
      z.object({
        headers: z
          .array(z.object({ name: z.string(), value: z.string() }))
          .optional(),
      }),
    )
    .optional(),
});
const calendarListSchema = z.object({
  items: z.array(z.unknown()).optional(),
  nextPageToken: z.string().optional(),
});
const calendarEventSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    htmlLink: z.string().url().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    creator: z
      .object({
        displayName: z.string().optional(),
        email: z.string().optional(),
      })
      .optional(),
    organizer: z
      .object({
        displayName: z.string().optional(),
        email: z.string().optional(),
      })
      .optional(),
    start: z
      .object({ dateTime: z.string().optional(), date: z.string().optional() })
      .optional(),
    end: z
      .object({ dateTime: z.string().optional(), date: z.string().optional() })
      .optional(),
    location: z.string().optional(),
    attendees: z
      .array(
        z.object({
          displayName: z.string().optional(),
          email: z.string().optional(),
          responseStatus: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();
const driveListSchema = z.object({
  files: z.array(z.unknown()).optional(),
  nextPageToken: z.string().optional(),
});
const driveFileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().min(1),
    webViewLink: z.string().url().optional(),
    description: z.string().optional(),
    createdTime: z.string().optional(),
    modifiedTime: z.string().optional(),
    size: z.string().optional(),
    owners: z
      .array(
        z.object({
          displayName: z.string().optional(),
          emailAddress: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();
const notionRichTextSchema = z.array(
  z.object({ plain_text: z.string() }).passthrough(),
);
const notionSearchResultSchema = z
  .object({
    object: z.enum(["page", "data_source"]),
    id: z.string().min(1),
    url: z.string().url().optional(),
    created_time: z.string().optional(),
    last_edited_time: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    title: notionRichTextSchema.optional(),
  })
  .passthrough();
const notionSearchSchema = z.object({
  results: z.array(notionSearchResultSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable().optional(),
});
const notionChildrenSchema = z.object({
  results: z.array(z.unknown()),
  has_more: z.boolean(),
  next_cursor: z.string().nullable().optional(),
});
const slackSearchSchema = z.object({
  ok: z.literal(true),
  messages: z.object({
    matches: z.array(
      z
        .object({
          ts: z.string().min(1),
          text: z.string().default(""),
          username: z.string().optional(),
          user_name: z.string().optional(),
          user: z.string().optional(),
          permalink: z.string().url().optional(),
          channel_id: z.string().optional(),
          channel_name: z.string().optional(),
          channel: z
            .object({ id: z.string().min(1), name: z.string().optional() })
            .optional(),
        })
        .passthrough(),
    ),
    paging: z
      .object({ page: z.number().int(), pages: z.number().int() })
      .optional(),
  }),
});
const slackRepliesSchema = z.object({
  ok: z.literal(true),
  messages: z.array(
    z
      .object({
        ts: z.string().min(1),
        text: z.string().default(""),
        user: z.string().optional(),
        username: z.string().optional(),
      })
      .passthrough(),
  ),
});
const githubSearchSchema = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z.array(z.unknown()),
});
const githubIssueSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string().nullable().optional(),
    html_url: z.string().url(),
    created_at: z.string(),
    updated_at: z.string(),
    state: z.string(),
    user: z
      .object({ login: z.string().min(1) })
      .nullable()
      .optional(),
    repository_url: z.string().url().optional(),
    pull_request: z.unknown().optional(),
    labels: z
      .array(z.union([z.string(), z.object({ name: z.string().optional() })]))
      .optional(),
  })
  .passthrough();

export class ConnectorAiExecutor {
  constructor(
    private readonly timeoutMs: number,
    private readonly maxOutputBytes: number,
  ) {}

  async execute(
    providerId: ConnectorProviderId,
    accessToken: string,
    request: ConnectorAiExecutionRequest,
  ): Promise<ConnectorAiExecutionResult> {
    this.assertProviderCapability(providerId, request.capability);
    const result =
      request.operation === "search"
        ? await this.search(providerId, accessToken, request)
        : await this.read(providerId, accessToken, request);
    return this.fitOutput(result);
  }

  private async search(
    providerId: ConnectorProviderId,
    accessToken: string,
    request: Extract<ConnectorAiExecutionRequest, { operation: "search" }>,
  ): Promise<ConnectorAiExecutionResult> {
    switch (request.capability) {
      case "mail":
        return this.searchMail(accessToken, request);
      case "calendar":
        return this.searchCalendar(accessToken, request);
      case "drive":
        return this.searchDrive(accessToken, request);
      case "notion":
        return this.searchNotion(accessToken, request);
      case "slack":
        return this.searchSlack(accessToken, request);
      case "github":
        return this.searchGitHub(accessToken, request);
      default:
        return this.unreachable(request.capability);
    }
  }

  private async read(
    providerId: ConnectorProviderId,
    accessToken: string,
    request: Extract<ConnectorAiExecutionRequest, { operation: "read" }>,
  ): Promise<ConnectorAiExecutionResult> {
    const resource = this.decodeResourceId(
      request.resourceId,
      providerId,
      request.capability,
    );
    switch (request.capability) {
      case "mail":
        return this.readMail(accessToken, resource);
      case "calendar":
        return this.readCalendar(accessToken, resource);
      case "drive":
        return this.readDrive(accessToken, resource);
      case "notion":
        return this.readNotion(accessToken, resource);
      case "slack":
        return this.readSlack(accessToken, resource);
      case "github":
        return this.readGitHub(accessToken, resource);
      default:
        return this.unreachable(request.capability);
    }
  }

  private async searchMail(
    accessToken: string,
    request: Extract<ConnectorAiExecutionRequest, { operation: "search" }>,
  ) {
    const limit = request.limit || 10;
    const target = new URL("/gmail/v1/users/me/messages", GOOGLE_GMAIL_API);
    target.searchParams.set("q", request.query);
    target.searchParams.set("maxResults", String(limit));
    if (request.cursor) target.searchParams.set("pageToken", request.cursor);
    const result = await this.json(
      target,
      this.googleHeaders(accessToken),
      gmailListSchema,
    );
    const items: ConnectorAiItem[] = [];
    for (const message of result.messages || []) {
      const detail = await this.gmailMessage(
        accessToken,
        message.id,
        "metadata",
      );
      items.push(this.mailItem(detail, false));
    }
    return {
      operation: "search" as const,
      capability: "mail" as const,
      items,
      nextCursor: result.nextPageToken || null,
    };
  }

  private async readMail(accessToken: string, resource: ResourceId) {
    const message = await this.gmailMessage(accessToken, resource.id, "full");
    return {
      operation: "read" as const,
      capability: "mail" as const,
      item: this.mailItem(message, true),
    };
  }

  private async gmailMessage(
    accessToken: string,
    messageId: string,
    format: "metadata" | "full",
  ) {
    const target = new URL(
      `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
      GOOGLE_GMAIL_API,
    );
    target.searchParams.set("format", format);
    if (format === "metadata") {
      for (const header of ["Subject", "From", "Date"]) {
        target.searchParams.append("metadataHeaders", header);
      }
    }
    return this.json(
      target,
      this.googleHeaders(accessToken),
      gmailMessageSchema,
    );
  }

  private mailItem(
    message: z.infer<typeof gmailMessageSchema>,
    includeContent: boolean,
  ) {
    const headers = new Map(
      (message.payload?.headers || []).map((header) => [
        header.name.toLowerCase(),
        header.value,
      ]),
    );
    const date =
      headers.get("date") ||
      (message.internalDate
        ? this.isoTimestamp(Number(message.internalDate))
        : null);
    return this.item({
      id: this.encodeResourceId({
        providerId: "google-workspace",
        capability: "mail",
        type: "message",
        id: message.id,
      }),
      type: "mail_message",
      title: headers.get("subject") || "(No subject)",
      summary: message.snippet || null,
      content: includeContent
        ? this.gmailText(message.payload) || message.snippet || null
        : null,
      url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}`,
      author: headers.get("from") || null,
      createdAt: date,
      updatedAt: null,
      metadata: { threadId: message.threadId || null },
    });
  }

  private async searchCalendar(
    accessToken: string,
    request: Extract<ConnectorAiExecutionRequest, { operation: "search" }>,
  ) {
    const target = new URL(
      "/calendar/v3/calendars/primary/events",
      GOOGLE_CALENDAR_API,
    );
    target.searchParams.set("q", request.query);
    target.searchParams.set("maxResults", String(request.limit || 10));
    target.searchParams.set("singleEvents", "true");
    if (request.cursor) target.searchParams.set("pageToken", request.cursor);
    const result = await this.json(
      target,
      this.googleHeaders(accessToken),
      calendarListSchema,
    );
    const items = (result.items || []).map((value) =>
      this.calendarItem(calendarEventSchema.parse(value), false),
    );
    return {
      operation: "search" as const,
      capability: "calendar" as const,
      items,
      nextCursor: result.nextPageToken || null,
    };
  }

  private async readCalendar(accessToken: string, resource: ResourceId) {
    const target = new URL(
      `/calendar/v3/calendars/primary/events/${encodeURIComponent(resource.id)}`,
      GOOGLE_CALENDAR_API,
    );
    const event = await this.json(
      target,
      this.googleHeaders(accessToken),
      calendarEventSchema,
    );
    return {
      operation: "read" as const,
      capability: "calendar" as const,
      item: this.calendarItem(event, true),
    };
  }

  private calendarItem(
    event: z.infer<typeof calendarEventSchema>,
    includeContent: boolean,
  ) {
    const attendees = (event.attendees || [])
      .map((attendee) => attendee.displayName || attendee.email)
      .filter((value): value is string => Boolean(value));
    return this.item({
      id: this.encodeResourceId({
        providerId: "google-workspace",
        capability: "calendar",
        type: "event",
        id: event.id,
      }),
      type: "calendar_event",
      title: event.summary || "Untitled event",
      summary: event.description || event.location || null,
      content: includeContent
        ? [
            event.description,
            event.location && `Location: ${event.location}`,
            attendees.length && `Attendees: ${attendees.join(", ")}`,
          ]
            .filter(Boolean)
            .join("\n\n") || null
        : null,
      url: event.htmlLink || null,
      author:
        event.organizer?.displayName ||
        event.organizer?.email ||
        event.creator?.displayName ||
        event.creator?.email ||
        null,
      createdAt:
        event.created || event.start?.dateTime || event.start?.date || null,
      updatedAt: event.updated || null,
      metadata: {
        status: event.status || null,
        startsAt: event.start?.dateTime || event.start?.date || null,
        endsAt: event.end?.dateTime || event.end?.date || null,
      },
    });
  }

  private async searchDrive(
    accessToken: string,
    request: Extract<ConnectorAiExecutionRequest, { operation: "search" }>,
  ) {
    const target = new URL("/drive/v3/files", GOOGLE_DRIVE_API);
    const query = request.query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    target.searchParams.set(
      "q",
      `trashed = false and (name contains '${query}' or fullText contains '${query}')`,
    );
    target.searchParams.set("pageSize", String(request.limit || 10));
    target.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,webViewLink,description,createdTime,modifiedTime,size,owners(displayName,emailAddress))",
    );
    if (request.cursor) target.searchParams.set("pageToken", request.cursor);
    const result = await this.json(
      target,
      this.googleHeaders(accessToken),
      driveListSchema,
    );
    return {
      operation: "search" as const,
      capability: "drive" as const,
      items: (result.files || []).map((value) =>
        this.driveItem(driveFileSchema.parse(value), null),
      ),
      nextCursor: result.nextPageToken || null,
    };
  }

  private async readDrive(accessToken: string, resource: ResourceId) {
    const target = new URL(
      `/drive/v3/files/${encodeURIComponent(resource.id)}`,
      GOOGLE_DRIVE_API,
    );
    target.searchParams.set(
      "fields",
      "id,name,mimeType,webViewLink,description,createdTime,modifiedTime,size,owners(displayName,emailAddress)",
    );
    const file = await this.json(
      target,
      this.googleHeaders(accessToken),
      driveFileSchema,
    );
    let content: string | null = null;
    const exportMime =
      file.mimeType === "application/vnd.google-apps.document"
        ? "text/plain"
        : file.mimeType === "application/vnd.google-apps.spreadsheet"
          ? "text/csv"
          : null;
    if (exportMime) {
      const exportTarget = new URL(
        `/drive/v3/files/${encodeURIComponent(resource.id)}/export`,
        GOOGLE_DRIVE_API,
      );
      exportTarget.searchParams.set("mimeType", exportMime);
      content = await this.text(exportTarget, this.googleHeaders(accessToken));
    } else if (this.isTextMime(file.mimeType)) {
      const contentTarget = new URL(
        `/drive/v3/files/${encodeURIComponent(resource.id)}`,
        GOOGLE_DRIVE_API,
      );
      contentTarget.searchParams.set("alt", "media");
      content = await this.text(contentTarget, this.googleHeaders(accessToken));
    }
    return {
      operation: "read" as const,
      capability: "drive" as const,
      item: this.driveItem(file, content),
    };
  }

  private driveItem(
    file: z.infer<typeof driveFileSchema>,
    content: string | null,
  ) {
    const owner = file.owners?.[0];
    return this.item({
      id: this.encodeResourceId({
        providerId: "google-workspace",
        capability: "drive",
        type: "file",
        id: file.id,
      }),
      type: "drive_file",
      title: file.name,
      summary: file.description || null,
      content,
      url: file.webViewLink || null,
      author: owner?.displayName || owner?.emailAddress || null,
      createdAt: file.createdTime || null,
      updatedAt: file.modifiedTime || null,
      metadata: { mimeType: file.mimeType, size: file.size || null },
    });
  }

  private async searchNotion(
    accessToken: string,
    request: Extract<ConnectorAiExecutionRequest, { operation: "search" }>,
  ) {
    const target = new URL("/v1/search", NOTION_API);
    const body = {
      query: request.query,
      page_size: request.limit || 10,
      ...(request.cursor ? { start_cursor: request.cursor } : {}),
    };
    const result = await this.json(
      target,
      this.notionHeaders(accessToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      notionSearchSchema,
    );
    return {
      operation: "search" as const,
      capability: "notion" as const,
      items: result.results.map((entry) => this.notionItem(entry, null)),
      nextCursor: result.has_more ? result.next_cursor || null : null,
    };
  }

  private async readNotion(accessToken: string, resource: ResourceId) {
    const basePath =
      resource.type === "page"
        ? `/v1/pages/${encodeURIComponent(resource.id)}`
        : resource.type === "data_source"
          ? `/v1/data_sources/${encodeURIComponent(resource.id)}`
          : null;
    if (!basePath) throw this.invalidResource();
    const entry = await this.json(
      new URL(basePath, NOTION_API),
      this.notionHeaders(accessToken),
      notionSearchResultSchema,
    );
    let content: string | null = null;
    if (resource.type === "page") {
      const children = await this.json(
        new URL(
          `/v1/blocks/${encodeURIComponent(resource.id)}/children?page_size=100`,
          NOTION_API,
        ),
        this.notionHeaders(accessToken),
        notionChildrenSchema,
      );
      content = this.notionBlockText(children.results) || null;
    }
    return {
      operation: "read" as const,
      capability: "notion" as const,
      item: this.notionItem(entry, content),
    };
  }

  private notionItem(
    entry: z.infer<typeof notionSearchResultSchema>,
    content: string | null,
  ) {
    return this.item({
      id: this.encodeResourceId({
        providerId: "notion",
        capability: "notion",
        type: entry.object,
        id: entry.id,
      }),
      type: `notion_${entry.object}`,
      title: this.notionTitle(entry),
      summary: null,
      content,
      url: entry.url || null,
      author: null,
      createdAt: entry.created_time || null,
      updatedAt: entry.last_edited_time || null,
      metadata: {},
    });
  }

  private async searchSlack(
    accessToken: string,
    request: Extract<ConnectorAiExecutionRequest, { operation: "search" }>,
  ) {
    const page = request.cursor ? Number(request.cursor) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 100)
      throw this.invalidCursor();
    const target = new URL("/api/search.messages", SLACK_API);
    target.searchParams.set("query", request.query);
    target.searchParams.set("count", String(request.limit || 10));
    target.searchParams.set("page", String(page));
    const result = await this.json(
      target,
      this.bearerHeaders(accessToken),
      slackSearchSchema,
    );
    const items = result.messages.matches
      .map((message) => {
        const channelId = message.channel_id || message.channel?.id;
        const channelName = message.channel_name || message.channel?.name;
        if (!channelId) return null;
        return this.item({
          id: this.encodeResourceId({
            providerId: "slack",
            capability: "slack",
            type: "message",
            id: message.ts,
            parentId: channelId,
          }),
          type: "slack_message",
          title: channelName ? `#${channelName}` : "Slack message",
          summary: message.text || null,
          content: null,
          url: message.permalink || null,
          author: message.username || message.user_name || message.user || null,
          createdAt: this.slackTimestamp(message.ts),
          updatedAt: null,
          metadata: { channelId },
        });
      })
      .filter((item): item is ConnectorAiItem => Boolean(item));
    const paging = result.messages.paging;
    return {
      operation: "search" as const,
      capability: "slack" as const,
      items,
      nextCursor:
        paging && paging.page < paging.pages ? String(paging.page + 1) : null,
    };
  }

  private async readSlack(accessToken: string, resource: ResourceId) {
    if (!resource.parentId) throw this.invalidResource();
    const target = new URL("/api/conversations.replies", SLACK_API);
    target.searchParams.set("channel", resource.parentId);
    target.searchParams.set("ts", resource.id);
    target.searchParams.set("limit", "100");
    const result = await this.json(
      target,
      this.bearerHeaders(accessToken),
      slackRepliesSchema,
    );
    const first = result.messages[0];
    if (!first)
      throw new ApiError(
        404,
        "connector_resource_not_found",
        "The connector resource was not found.",
      );
    const content = result.messages
      .map(
        (message) =>
          `${message.username || message.user || "Unknown"}: ${message.text}`,
      )
      .join("\n\n");
    return {
      operation: "read" as const,
      capability: "slack" as const,
      item: this.item({
        id: this.encodeResourceId(resource),
        type: "slack_message",
        title: "Slack thread",
        summary: first.text || null,
        content,
        url: null,
        author: first.username || first.user || null,
        createdAt: this.slackTimestamp(first.ts),
        updatedAt: null,
        metadata: {
          channelId: resource.parentId,
          replyCount: result.messages.length - 1,
        },
      }),
    };
  }

  private async searchGitHub(
    accessToken: string,
    request: Extract<ConnectorAiExecutionRequest, { operation: "search" }>,
  ) {
    const page = request.cursor ? Number(request.cursor) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 100)
      throw this.invalidCursor();
    const limit = request.limit || 10;
    const target = new URL("/search/issues", GITHUB_API);
    target.searchParams.set("q", request.query);
    target.searchParams.set("per_page", String(limit));
    target.searchParams.set("page", String(page));
    const result = await this.json(
      target,
      this.githubHeaders(accessToken),
      githubSearchSchema,
    );
    const items = result.items.map((value) =>
      this.githubItem(githubIssueSchema.parse(value), null),
    );
    return {
      operation: "search" as const,
      capability: "github" as const,
      items,
      nextCursor:
        page * limit < result.total_count && page < 100
          ? String(page + 1)
          : null,
    };
  }

  private async readGitHub(accessToken: string, resource: ResourceId) {
    if (!resource.parentId || !resource.number || resource.type !== "issue") {
      throw this.invalidResource();
    }
    const repository = resource.parentId.split("/");
    if (
      repository.length !== 2 ||
      repository.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part || ""))
    ) {
      throw this.invalidResource();
    }
    const target = new URL(
      `/repos/${encodeURIComponent(repository[0]!)}/${encodeURIComponent(repository[1]!)}/issues/${resource.number}`,
      GITHUB_API,
    );
    const issue = await this.json(
      target,
      this.githubHeaders(accessToken),
      githubIssueSchema,
    );
    return {
      operation: "read" as const,
      capability: "github" as const,
      item: this.githubItem(issue, issue.body || null),
    };
  }

  private githubItem(
    issue: z.infer<typeof githubIssueSchema>,
    content: string | null,
  ) {
    const repository = issue.repository_url
      ? new URL(issue.repository_url).pathname.replace(/^\/repos\//, "")
      : new URL(issue.html_url).pathname.split("/").slice(1, 3).join("/");
    const labels = (issue.labels || [])
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => Boolean(label));
    return this.item({
      id: this.encodeResourceId({
        providerId: "github",
        capability: "github",
        type: "issue",
        id: String(issue.number),
        parentId: repository,
        number: issue.number,
      }),
      type: issue.pull_request ? "github_pull_request" : "github_issue",
      title: issue.title,
      summary: issue.body || null,
      content,
      url: issue.html_url,
      author: issue.user?.login || null,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      metadata: {
        repository,
        state: issue.state,
        labels: labels.join(", ") || null,
      },
    });
  }

  private async json<T extends z.ZodTypeAny>(
    target: URL,
    init: RequestInit,
    schema: T,
  ): Promise<z.infer<T>> {
    const text = await this.request(target, init);
    try {
      return schema.parse(JSON.parse(text) as unknown) as z.infer<T>;
    } catch {
      throw new ApiError(
        502,
        "connector_upstream_invalid_response",
        "The connector provider returned an invalid response.",
      );
    }
  }

  private text(target: URL, init: RequestInit) {
    return this.request(target, init);
  }

  private async request(target: URL, init: RequestInit) {
    if (
      target.protocol !== "https:" ||
      !ALLOWED_PROVIDER_HOSTS.has(target.hostname)
    ) {
      throw new ApiError(
        500,
        "connector_provider_host_invalid",
        "The connector provider host is invalid.",
      );
    }
    let response: Response;
    try {
      response = await fetch(target, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ApiError(
        error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError")
          ? 504
          : 502,
        "connector_upstream_unavailable",
        "The connector provider is unavailable.",
      );
    }
    if (!response.ok) {
      const status =
        response.status === 404
          ? 404
          : response.status === 401
            ? 401
            : response.status === 403
              ? 403
              : response.status === 429
                ? 429
                : 502;
      const code =
        status === 404
          ? "connector_resource_not_found"
          : status === 401
            ? "connector_reauthorization_required"
            : status === 403
              ? "connector_resource_forbidden"
              : status === 429
                ? "connector_rate_limited"
                : "connector_upstream_failed";
      const message =
        status === 404
          ? "The connector resource was not found."
          : status === 401
            ? "The connector must be connected again."
            : status === 403
              ? "The connector does not have access to this resource."
              : status === 429
                ? "The connector provider rate limit was reached."
                : "The connector provider request failed.";
      throw new ApiError(status, code, message);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.maxOutputBytes) {
      throw this.outputTooLarge();
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxOutputBytes) {
        await reader.cancel();
        throw this.outputTooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }

  private item(item: ConnectorAiItem): ConnectorAiItem {
    return {
      ...item,
      title: this.truncate(item.title, 1_000),
      summary: item.summary ? this.truncate(item.summary, 4_000) : null,
      content: item.content
        ? this.truncate(item.content, this.maxOutputBytes)
        : null,
      author: item.author ? this.truncate(item.author, 500) : null,
    };
  }

  private fitOutput(
    result: ConnectorAiExecutionResult,
  ): ConnectorAiExecutionResult {
    if (result.operation === "search") {
      while (
        result.items.length > 0 &&
        Buffer.byteLength(JSON.stringify(result), "utf8") > this.maxOutputBytes
      ) {
        result.items.pop();
      }
    } else if (
      Buffer.byteLength(JSON.stringify(result), "utf8") > this.maxOutputBytes
    ) {
      const overhead = Buffer.byteLength(
        JSON.stringify({ ...result, item: { ...result.item, content: "" } }),
        "utf8",
      );
      result.item.content = result.item.content
        ? this.truncate(
            result.item.content,
            Math.max(0, this.maxOutputBytes - overhead),
          )
        : null;
    }
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") > this.maxOutputBytes
    ) {
      throw this.outputTooLarge();
    }
    return result;
  }

  private encodeResourceId(value: ResourceId) {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  }

  private decodeResourceId(
    value: string,
    providerId: ConnectorProviderId,
    capability: ConnectorCapability,
  ) {
    try {
      const decoded: unknown = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8"),
      );
      const resource = connectorAiResourceIdSchema.parse(decoded);
      if (
        resource.providerId !== providerId ||
        resource.capability !== capability
      ) {
        throw this.invalidResource();
      }
      return resource;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw this.invalidResource();
    }
  }

  private assertProviderCapability(
    providerId: ConnectorProviderId,
    capability: ConnectorCapability,
  ) {
    const expected =
      capability === "mail" ||
      capability === "calendar" ||
      capability === "drive"
        ? "google-workspace"
        : capability;
    if (providerId !== expected) {
      throw new ApiError(
        403,
        "connector_capability_forbidden",
        "The connection did not grant this capability.",
      );
    }
  }

  private googleHeaders(accessToken: string): RequestInit {
    return {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    };
  }

  private bearerHeaders(accessToken: string): RequestInit {
    return {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    };
  }

  private notionHeaders(
    accessToken: string,
    init: RequestInit = {},
  ): RequestInit {
    return {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
    };
  }

  private githubHeaders(accessToken: string): RequestInit {
    return {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": GITHUB_VERSION,
      },
    };
  }

  private gmailText(part: GmailPart | undefined): string {
    if (!part) return "";
    if (
      part.body?.data &&
      (part.mimeType === "text/plain" || part.mimeType === "text/html")
    ) {
      try {
        return Buffer.from(part.body.data, "base64url").toString("utf8");
      } catch {
        return "";
      }
    }
    return (part.parts || [])
      .map((child) => this.gmailText(child))
      .filter(Boolean)
      .join("\n\n");
  }

  private notionTitle(entry: z.infer<typeof notionSearchResultSchema>) {
    if (entry.title?.length)
      return entry.title.map((part) => part.plain_text).join("") || "Untitled";
    for (const property of Object.values(entry.properties || {})) {
      const parsed = z
        .object({
          title: notionRichTextSchema.optional(),
          rich_text: notionRichTextSchema.optional(),
        })
        .passthrough()
        .safeParse(property);
      const text = parsed.success
        ? (parsed.data.title || parsed.data.rich_text || [])
            .map((part) => part.plain_text)
            .join("")
        : "";
      if (text) return text;
    }
    return "Untitled";
  }

  private notionBlockText(blocks: unknown[]) {
    const lines: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const child of value) walk(child);
        return;
      }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (typeof record.plain_text === "string") lines.push(record.plain_text);
      for (const child of Object.values(record)) walk(child);
    };
    walk(blocks);
    return lines.join(" ").replace(/\s+/g, " ").trim();
  }

  private slackTimestamp(timestamp: string) {
    const seconds = Number(timestamp.split(".")[0]);
    return this.isoTimestamp(seconds * 1000);
  }

  private isoTimestamp(milliseconds: number) {
    if (!Number.isFinite(milliseconds)) return null;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private isTextMime(mimeType: string) {
    return (
      mimeType.startsWith("text/") ||
      mimeType === "application/json" ||
      mimeType === "application/xml" ||
      mimeType === "application/javascript"
    );
  }

  private truncate(value: string, maxBytes: number) {
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes)
        low = middle;
      else high = middle - 1;
    }
    return value.slice(0, low);
  }

  private invalidResource() {
    return new ApiError(
      400,
      "connector_resource_id_invalid",
      "The connector resource ID is invalid.",
    );
  }

  private invalidCursor() {
    return new ApiError(
      400,
      "connector_cursor_invalid",
      "The connector cursor is invalid.",
    );
  }

  private outputTooLarge() {
    return new ApiError(
      502,
      "connector_output_too_large",
      "The connector provider response is too large.",
    );
  }

  private unreachable(value: never): never {
    throw new Error(`Unsupported connector provider: ${String(value)}`);
  }
}
