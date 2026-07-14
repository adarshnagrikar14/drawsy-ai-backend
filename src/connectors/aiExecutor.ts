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
const GITHUB_VERSION = "2026-03-10";
const GITHUB_REPOSITORY_PAGE_SIZE = 10;
const TRUNCATED_SOURCE_MARKER = "\n\n[Content truncated by Drawsy.]";
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
const calendarCatalogSchema = z.object({
  items: z
    .array(
      z
        .object({
          id: z.string().min(1),
          summary: z.string().min(1),
          description: z.string().optional(),
          timeZone: z.string().optional(),
          accessRole: z.string().optional(),
          primary: z.boolean().optional(),
          selected: z.boolean().optional(),
        })
        .passthrough(),
    )
    .optional(),
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
          self: z.boolean().optional(),
        }),
      )
      .optional(),
    hangoutLink: z.string().url().optional(),
    recurringEventId: z.string().optional(),
    originalStartTime: z
      .object({ dateTime: z.string().optional(), date: z.string().optional() })
      .optional(),
    conferenceData: z
      .object({
        entryPoints: z
          .array(z.object({ uri: z.string().url().optional() }).passthrough())
          .optional(),
      })
      .passthrough()
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
const slackChannelsSchema = z.object({
  ok: z.literal(true),
  channels: z.array(
    z
      .object({
        id: z.string().min(1),
        name: z.string().optional(),
        user: z.string().optional(),
        created: z.number().optional(),
        updated: z.number().optional(),
        is_im: z.boolean().optional(),
        is_mpim: z.boolean().optional(),
        is_private: z.boolean().optional(),
        is_member: z.boolean().optional(),
        num_members: z.number().int().nonnegative().optional(),
        topic: z.object({ value: z.string().optional() }).optional(),
        purpose: z.object({ value: z.string().optional() }).optional(),
      })
      .passthrough(),
  ),
  response_metadata: z
    .object({ next_cursor: z.string().optional() })
    .optional(),
});
const slackHistorySchema = z.object({
  ok: z.literal(true),
  messages: z.array(
    z
      .object({
        ts: z.string().min(1),
        text: z.string().default(""),
        user: z.string().optional(),
        username: z.string().optional(),
        thread_ts: z.string().optional(),
        reply_count: z.number().int().nonnegative().optional(),
      })
      .passthrough(),
  ),
  response_metadata: z
    .object({ next_cursor: z.string().optional() })
    .optional(),
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
const githubRepositorySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    full_name: z.string().min(3),
    html_url: z.string().url(),
    description: z.string().nullable().optional(),
    private: z.boolean(),
    visibility: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    pushed_at: z.string().nullable().optional(),
    default_branch: z.string().optional(),
    language: z.string().nullable().optional(),
    stargazers_count: z.number().int().nonnegative().optional(),
    owner: z.object({ login: z.string().min(1) }).optional(),
  })
  .passthrough();
const githubInstallationRepositoriesSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(githubRepositorySchema),
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
        : request.operation === "list"
          ? await this.list(providerId, accessToken, request)
          : await this.read(providerId, accessToken, request);
    return this.fitOutput(result);
  }

  private async list(
    providerId: ConnectorProviderId,
    accessToken: string,
    request: Extract<ConnectorAiExecutionRequest, { operation: "list" }>,
  ): Promise<ConnectorAiExecutionResult> {
    switch (request.kind) {
      case "mail_messages":
        return this.listMailMessages(accessToken, request);
      case "calendars":
        return this.listCalendars(accessToken, request);
      case "calendar_events":
        return this.listCalendarEvents(accessToken, request);
      case "drive_files":
        return this.listDriveFiles(accessToken, request);
      case "notion_content":
        return this.listNotionContent(accessToken, request);
      case "github_repositories":
        return this.listGitHubRepositories(accessToken, request);
      case "slack_channels":
        return this.listSlackChannels(accessToken, request);
      case "slack_messages":
        return this.listSlackMessages(accessToken, request);
      default:
        return this.unreachable(request);
    }
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

  private async listMailMessages(
    accessToken: string,
    request: Extract<
      ConnectorAiExecutionRequest,
      { operation: "list"; kind: "mail_messages" }
    >,
  ) {
    const target = new URL("/gmail/v1/users/me/messages", GOOGLE_GMAIL_API);
    const query = [
      request.query,
      request.after && `after:${this.gmailTimestamp(request.after)}`,
      request.before && `before:${this.gmailTimestamp(request.before)}`,
      request.from && `from:${this.gmailSearchValue(request.from)}`,
      request.to && `to:${this.gmailSearchValue(request.to)}`,
      request.subject && `subject:${this.gmailSearchValue(request.subject)}`,
      request.label && `label:${this.gmailSearchValue(request.label)}`,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    if (query) target.searchParams.set("q", query);
    target.searchParams.set("maxResults", String(request.limit || 20));
    if (request.includeSpamTrash) {
      target.searchParams.set("includeSpamTrash", "true");
    }
    if (request.cursor) target.searchParams.set("pageToken", request.cursor);
    const result = await this.json(
      target,
      this.googleHeaders(accessToken),
      gmailListSchema,
    );
    const messages = await Promise.all(
      (result.messages || []).map((message) =>
        this.gmailMessage(accessToken, message.id, "metadata"),
      ),
    );
    messages.sort(
      (left, right) =>
        Number(right.internalDate || 0) - Number(left.internalDate || 0),
    );
    return {
      operation: "list" as const,
      capability: "mail" as const,
      kind: "mail_messages" as const,
      items: messages.map((message) => this.mailItem(message, false)),
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

  private async listCalendars(
    accessToken: string,
    request: Extract<
      ConnectorAiExecutionRequest,
      { operation: "list"; kind: "calendars" }
    >,
  ) {
    const target = new URL(
      "/calendar/v3/users/me/calendarList",
      GOOGLE_CALENDAR_API,
    );
    target.searchParams.set("maxResults", String(request.limit || 100));
    target.searchParams.set("showDeleted", "false");
    if (request.cursor) target.searchParams.set("pageToken", request.cursor);
    const result = await this.json(
      target,
      this.googleHeaders(accessToken),
      calendarCatalogSchema,
    );
    return {
      operation: "list" as const,
      capability: "calendar" as const,
      kind: "calendars" as const,
      items: (result.items || []).map((calendar) =>
        this.item({
          id: this.encodeResourceId({
            providerId: "google-workspace",
            capability: "calendar",
            type: "calendar",
            id: calendar.id,
          }),
          type: "calendar",
          title: calendar.summary,
          summary: calendar.description || null,
          content: null,
          url: null,
          author: null,
          createdAt: null,
          updatedAt: null,
          metadata: {
            calendarId: calendar.id,
            timeZone: calendar.timeZone || null,
            accessRole: calendar.accessRole || null,
            primary: calendar.primary || false,
            selected: calendar.selected ?? true,
          },
        }),
      ),
      nextCursor: result.nextPageToken || null,
    };
  }

  private async listCalendarEvents(
    accessToken: string,
    request: Extract<
      ConnectorAiExecutionRequest,
      { operation: "list"; kind: "calendar_events" }
    >,
  ) {
    if (Date.parse(request.endTime) <= Date.parse(request.startTime)) {
      throw new ApiError(
        400,
        "connector_time_range_invalid",
        "The calendar end time must be after the start time.",
      );
    }
    const calendarId = request.calendarId || "primary";
    const target = new URL(
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      GOOGLE_CALENDAR_API,
    );
    target.searchParams.set("timeMin", request.startTime);
    target.searchParams.set("timeMax", request.endTime);
    target.searchParams.set("singleEvents", "true");
    target.searchParams.set("showDeleted", "false");
    target.searchParams.set("orderBy", "startTime");
    target.searchParams.set("maxResults", String(request.limit || 100));
    if (request.timeZone) target.searchParams.set("timeZone", request.timeZone);
    if (request.query) target.searchParams.set("q", request.query);
    if (request.cursor) target.searchParams.set("pageToken", request.cursor);
    const result = await this.json(
      target,
      this.googleHeaders(accessToken),
      calendarListSchema,
    );
    return {
      operation: "list" as const,
      capability: "calendar" as const,
      kind: "calendar_events" as const,
      items: (result.items || []).map((value) =>
        this.calendarItem(calendarEventSchema.parse(value), true, calendarId),
      ),
      nextCursor: result.nextPageToken || null,
    };
  }

  private async readCalendar(accessToken: string, resource: ResourceId) {
    const calendarId = resource.parentId || "primary";
    const target = new URL(
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(resource.id)}`,
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
    calendarId = "primary",
  ) {
    const attendees = (event.attendees || [])
      .map((attendee) => attendee.displayName || attendee.email)
      .filter((value): value is string => Boolean(value));
    const selfResponse = event.attendees?.find(
      (attendee) => attendee.self,
    )?.responseStatus;
    const conferenceUrl =
      event.hangoutLink ||
      event.conferenceData?.entryPoints?.find((entry) => entry.uri)?.uri ||
      null;
    return this.item({
      id: this.encodeResourceId({
        providerId: "google-workspace",
        capability: "calendar",
        type: "event",
        id: event.id,
        parentId: calendarId,
      }),
      type: "calendar_event",
      title: event.summary || "Untitled event",
      summary: event.description || event.location || null,
      content: includeContent
        ? [
            event.description,
            event.location && `Location: ${event.location}`,
            attendees.length && `Attendees: ${attendees.join(", ")}`,
            conferenceUrl && `Conference: ${conferenceUrl}`,
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
        selfResponse: selfResponse || null,
        conferenceUrl,
        recurring: Boolean(event.recurringEventId),
        recurringEventId: event.recurringEventId || null,
        originalStartsAt:
          event.originalStartTime?.dateTime ||
          event.originalStartTime?.date ||
          null,
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

  private async listDriveFiles(
    accessToken: string,
    request: Extract<
      ConnectorAiExecutionRequest,
      { operation: "list"; kind: "drive_files" }
    >,
  ) {
    const target = new URL("/drive/v3/files", GOOGLE_DRIVE_API);
    const conditions = ["trashed = false"];
    if (request.query) {
      const query = this.driveQueryValue(request.query);
      conditions.push(
        `(name contains '${query}' or fullText contains '${query}')`,
      );
    }
    if (request.mimeType) {
      conditions.push(`mimeType = '${this.driveQueryValue(request.mimeType)}'`);
    }
    target.searchParams.set("q", conditions.join(" and "));
    target.searchParams.set("pageSize", String(request.limit || 50));
    target.searchParams.set("orderBy", request.orderBy || "modifiedTime desc");
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
      operation: "list" as const,
      capability: "drive" as const,
      kind: "drive_files" as const,
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
    } else if (this.isTextFile(file.name, file.mimeType)) {
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

  private async listNotionContent(
    accessToken: string,
    request: Extract<
      ConnectorAiExecutionRequest,
      { operation: "list"; kind: "notion_content" }
    >,
  ) {
    const target = new URL("/v1/search", NOTION_API);
    const body = {
      ...(request.query ? { query: request.query } : {}),
      ...(request.object
        ? { filter: { property: "object", value: request.object } }
        : {}),
      sort: {
        direction: request.sortDirection || "descending",
        timestamp: "last_edited_time",
      },
      page_size: request.limit || 50,
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
      operation: "list" as const,
      capability: "notion" as const,
      kind: "notion_content" as const,
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
      content =
        (await this.notionBlockContent(accessToken, resource.id)) || null;
    } else if (resource.type === "data_source") {
      content =
        (await this.notionDataSourceContent(accessToken, resource.id)) || null;
    }
    return {
      operation: "read" as const,
      capability: "notion" as const,
      item: this.notionItem(entry, content),
    };
  }

  private async notionBlockContent(accessToken: string, blockId: string) {
    const budget = { remaining: 1_000 };
    const readChildren = async (
      id: string,
      depth: number,
    ): Promise<string[]> => {
      if (depth > 12 || budget.remaining <= 0) return [];
      const lines: string[] = [];
      let cursor: string | null = null;
      do {
        const target = new URL(
          `/v1/blocks/${encodeURIComponent(id)}/children`,
          NOTION_API,
        );
        target.searchParams.set("page_size", "100");
        if (cursor) target.searchParams.set("start_cursor", cursor);
        const page = await this.json(
          target,
          this.notionHeaders(accessToken),
          notionChildrenSchema,
        );
        const available = page.results.slice(0, budget.remaining);
        budget.remaining -= available.length;
        const ownText = this.notionBlockText(available);
        if (ownText) lines.push(ownText);
        for (const block of available) {
          const parsed = z
            .object({
              id: z.string().min(1),
              has_children: z.boolean().optional(),
            })
            .passthrough()
            .safeParse(block);
          if (
            parsed.success &&
            parsed.data.has_children &&
            budget.remaining > 0
          ) {
            lines.push(...(await readChildren(parsed.data.id, depth + 1)));
          }
        }
        cursor = page.has_more ? page.next_cursor || null : null;
      } while (cursor && budget.remaining > 0);
      return lines;
    };
    return (await readChildren(blockId, 0)).filter(Boolean).join("\n");
  }

  private async notionDataSourceContent(
    accessToken: string,
    dataSourceId: string,
  ) {
    const lines: string[] = [];
    let cursor: string | null = null;
    let remaining = 500;
    do {
      const body: { page_size: number; start_cursor?: string } = {
        page_size: Math.min(100, remaining),
        ...(cursor ? { start_cursor: cursor } : {}),
      };
      const page: z.infer<typeof notionSearchSchema> = await this.json(
        new URL(
          `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
          NOTION_API,
        ),
        this.notionHeaders(accessToken, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        notionSearchSchema,
      );
      for (const entry of page.results) {
        if (entry.object !== "page") continue;
        const title = this.notionTitle(entry);
        const properties = this.notionPropertiesText(entry.properties || {});
        lines.push(properties ? `- ${title} — ${properties}` : `- ${title}`);
      }
      remaining -= page.results.length;
      cursor = page.has_more ? page.next_cursor || null : null;
    } while (cursor && remaining > 0);
    return lines.join("\n");
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

  private async listSlackChannels(
    accessToken: string,
    request: Extract<
      ConnectorAiExecutionRequest,
      { operation: "list"; kind: "slack_channels" }
    >,
  ) {
    const target = new URL("/api/conversations.list", SLACK_API);
    target.searchParams.set("types", "public_channel,private_channel,mpim,im");
    target.searchParams.set("exclude_archived", "true");
    target.searchParams.set("limit", String(request.limit || 100));
    if (request.cursor) target.searchParams.set("cursor", request.cursor);
    const result = await this.json(
      target,
      this.bearerHeaders(accessToken),
      slackChannelsSchema,
    );
    return {
      operation: "list" as const,
      capability: "slack" as const,
      kind: "slack_channels" as const,
      items: result.channels.map((channel) => {
        const title = channel.name
          ? `#${channel.name}`
          : channel.is_im && channel.user
            ? `Direct message · ${channel.user}`
            : "Slack conversation";
        return this.item({
          id: this.encodeResourceId({
            providerId: "slack",
            capability: "slack",
            type: "channel",
            id: channel.id,
          }),
          type: "slack_channel",
          title,
          summary: channel.topic?.value || channel.purpose?.value || null,
          content: null,
          url: null,
          author: null,
          createdAt: channel.created
            ? this.isoTimestamp(channel.created * 1_000)
            : null,
          updatedAt: channel.updated
            ? this.isoTimestamp(channel.updated)
            : null,
          metadata: {
            channelId: channel.id,
            directMessage: channel.is_im || false,
            multiPartyDirectMessage: channel.is_mpim || false,
            private: channel.is_private || false,
            member: channel.is_member ?? true,
            memberCount: channel.num_members ?? null,
          },
        });
      }),
      nextCursor: result.response_metadata?.next_cursor || null,
    };
  }

  private async listSlackMessages(
    accessToken: string,
    request: Extract<
      ConnectorAiExecutionRequest,
      { operation: "list"; kind: "slack_messages" }
    >,
  ) {
    if (
      request.startTime &&
      request.endTime &&
      Date.parse(request.endTime) <= Date.parse(request.startTime)
    ) {
      throw new ApiError(
        400,
        "connector_time_range_invalid",
        "The Slack end time must be after the start time.",
      );
    }
    const target = new URL("/api/conversations.history", SLACK_API);
    target.searchParams.set("channel", request.channelId);
    target.searchParams.set("limit", String(request.limit || 15));
    if (request.startTime) {
      target.searchParams.set(
        "oldest",
        this.slackApiTimestamp(request.startTime),
      );
    }
    if (request.endTime) {
      target.searchParams.set(
        "latest",
        this.slackApiTimestamp(request.endTime),
      );
    }
    if (request.startTime || request.endTime) {
      target.searchParams.set("inclusive", "true");
    }
    if (request.cursor) target.searchParams.set("cursor", request.cursor);
    const result = await this.json(
      target,
      this.bearerHeaders(accessToken),
      slackHistorySchema,
    );
    return {
      operation: "list" as const,
      capability: "slack" as const,
      kind: "slack_messages" as const,
      items: result.messages.map((message) =>
        this.item({
          id: this.encodeResourceId({
            providerId: "slack",
            capability: "slack",
            type: "message",
            id: message.thread_ts || message.ts,
            parentId: request.channelId,
          }),
          type: "slack_message",
          title: "Slack message",
          summary: message.text || null,
          content: null,
          url: null,
          author: message.username || message.user || null,
          createdAt: this.slackTimestamp(message.ts),
          updatedAt: null,
          metadata: {
            channelId: request.channelId,
            messageTimestamp: message.ts,
            threadTimestamp: message.thread_ts || null,
            replyCount: message.reply_count || 0,
          },
        }),
      ),
      nextCursor: result.response_metadata?.next_cursor || null,
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
    const installedRepositories =
      await this.githubInstallationRepositoryNames(accessToken);
    const items = result.items
      .map((value) => githubIssueSchema.parse(value))
      .filter((issue) => {
        if (!issue.repository_url) return false;
        const match = new URL(issue.repository_url).pathname.match(
          /^\/repos\/([^/]+)\/([^/]+)$/,
        );
        return Boolean(
          match &&
          installedRepositories.has(
            `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`.toLowerCase(),
          ),
        );
      })
      .map((issue) => this.githubItem(issue, null));
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

  private async listGitHubRepositories(
    accessToken: string,
    request: Extract<
      ConnectorAiExecutionRequest,
      { operation: "list"; kind: "github_repositories" }
    >,
  ) {
    const page = request.cursor ? Number(request.cursor) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 100) {
      throw this.invalidCursor();
    }
    const limit = request.limit || 30;
    const pageSize = Math.min(limit, GITHUB_REPOSITORY_PAGE_SIZE);
    let currentPage = page;
    let hasMore = false;
    const matched: z.infer<typeof githubRepositorySchema>[] = [];
    do {
      const result = await this.listGitHubInstallationPage(
        accessToken,
        currentPage,
        pageSize,
      );
      matched.push(
        ...result.repositories.filter((repository) => {
          const owner = repository.full_name.split("/")[0] || "";
          return (
            (!request.query ||
              this.githubRepositoryMatchesQuery(repository, request.query)) &&
            (!request.owner ||
              owner.toLowerCase() === request.owner.toLowerCase()) &&
            (!request.visibility ||
              request.visibility === "all" ||
              (request.visibility === "private") === repository.private)
          );
        }),
      );
      hasMore =
        result.repositories.length === pageSize &&
        currentPage * pageSize < result.total_count &&
        currentPage < 100;
      currentPage += 1;
    } while (matched.length === 0 && hasMore);
    const items = matched.map((repository) =>
      this.githubRepositoryItem(repository, null),
    );
    return {
      operation: "list" as const,
      capability: "github" as const,
      kind: "github_repositories" as const,
      items,
      nextCursor: hasMore ? String(currentPage) : null,
    };
  }

  private async readGitHub(accessToken: string, resource: ResourceId) {
    if (resource.type === "repository") {
      const repository = this.githubRepositoryName(resource.id);
      await this.assertGitHubRepositoryAccess(accessToken, repository);
      const target = new URL(
        `/repos/${encodeURIComponent(repository[0])}/${encodeURIComponent(repository[1])}`,
        GITHUB_API,
      );
      const details = await this.json(
        target,
        this.githubHeaders(accessToken),
        githubRepositorySchema,
      );
      let readme: string | null = null;
      try {
        readme = await this.text(
          new URL(
            `/repos/${encodeURIComponent(repository[0])}/${encodeURIComponent(repository[1])}/readme`,
            GITHUB_API,
          ),
          this.githubHeaders(accessToken, "application/vnd.github.raw+json"),
          true,
        );
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }
      return {
        operation: "read" as const,
        capability: "github" as const,
        item: this.githubRepositoryItem(details, readme),
      };
    }
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
    await this.assertGitHubRepositoryAccess(accessToken, [
      repository[0]!,
      repository[1]!,
    ]);
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

  private githubRepositoryItem(
    repository: z.infer<typeof githubRepositorySchema>,
    content: string | null,
  ) {
    return this.item({
      id: this.encodeResourceId({
        providerId: "github",
        capability: "github",
        type: "repository",
        id: repository.full_name,
      }),
      type: "github_repository",
      title: repository.full_name,
      summary: repository.description || null,
      content,
      url: repository.html_url,
      author:
        repository.owner?.login || repository.full_name.split("/")[0] || null,
      createdAt: repository.created_at || null,
      updatedAt: repository.pushed_at || repository.updated_at || null,
      metadata: {
        private: repository.private,
        visibility:
          repository.visibility || (repository.private ? "private" : "public"),
        defaultBranch: repository.default_branch || null,
        language: repository.language || null,
        stars: repository.stargazers_count || 0,
      },
    });
  }

  private githubRepositoryMatchesQuery(
    repository: z.infer<typeof githubRepositorySchema>,
    query: string,
  ) {
    const searchable =
      `${repository.full_name} ${repository.description || ""}`.toLowerCase();
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return terms.length > 0 && terms.every((term) => searchable.includes(term));
  }

  private async listGitHubInstallationPage(
    accessToken: string,
    page: number,
    limit: number,
  ) {
    const target = new URL("/installation/repositories", GITHUB_API);
    target.searchParams.set("per_page", String(limit));
    target.searchParams.set("page", String(page));
    return this.json(
      target,
      this.githubHeaders(accessToken),
      githubInstallationRepositoriesSchema,
    );
  }

  private async githubInstallationRepositoryNames(accessToken: string) {
    const repositories = new Set<string>();
    for (let page = 1; ; page += 1) {
      const result = await this.listGitHubInstallationPage(
        accessToken,
        page,
        GITHUB_REPOSITORY_PAGE_SIZE,
      );
      result.repositories.forEach((repository) =>
        repositories.add(repository.full_name.toLowerCase()),
      );
      if (
        result.repositories.length < GITHUB_REPOSITORY_PAGE_SIZE ||
        page * GITHUB_REPOSITORY_PAGE_SIZE >= result.total_count
      ) {
        break;
      }
    }
    return repositories;
  }

  private async assertGitHubRepositoryAccess(
    accessToken: string,
    repository: [string, string],
  ) {
    const installed = await this.githubInstallationRepositoryNames(accessToken);
    if (!installed.has(`${repository[0]}/${repository[1]}`.toLowerCase())) {
      throw new ApiError(
        403,
        "connector_resource_forbidden",
        "That repository is not selected for this GitHub connection.",
      );
    }
  }

  private githubRepositoryName(value: string): [string, string] {
    const parts = value.split("/");
    if (
      parts.length !== 2 ||
      parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part || ""))
    ) {
      throw this.invalidResource();
    }
    return [parts[0]!, parts[1]!];
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

  private text(
    target: URL,
    init: RequestInit,
    truncateOversizedResponse = false,
  ) {
    return this.request(target, init, truncateOversizedResponse);
  }

  private async request(
    target: URL,
    init: RequestInit,
    truncateOversizedResponse = false,
  ) {
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
    if (
      !truncateOversizedResponse &&
      Number.isFinite(contentLength) &&
      contentLength > this.maxOutputBytes
    ) {
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
        if (truncateOversizedResponse) {
          const combined = Buffer.concat([...chunks, value]);
          return `${this.truncate(
            combined.toString("utf8"),
            Math.max(
              0,
              this.maxOutputBytes -
                Buffer.byteLength(TRUNCATED_SOURCE_MARKER, "utf8"),
            ),
          )}${TRUNCATED_SOURCE_MARKER}`;
        }
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
    if (result.operation === "search" || result.operation === "list") {
      while (
        result.items.length > 0 &&
        Buffer.byteLength(JSON.stringify(result), "utf8") > this.maxOutputBytes
      ) {
        result.items.pop();
      }
    } else if (
      Buffer.byteLength(JSON.stringify(result), "utf8") > this.maxOutputBytes
    ) {
      const content = result.item.content;
      if (content) {
        let low = 0;
        let high = Buffer.byteLength(content, "utf8");
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          result.item.content = this.truncateSourceContent(content, middle);
          if (
            Buffer.byteLength(JSON.stringify(result), "utf8") <=
            this.maxOutputBytes
          ) {
            low = middle;
          } else {
            high = middle - 1;
          }
        }
        result.item.content = this.truncateSourceContent(content, low);
      }
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

  private githubHeaders(
    accessToken: string,
    accept = "application/vnd.github+json",
  ): RequestInit {
    return {
      headers: {
        Accept: accept,
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

  private gmailTimestamp(value: string) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
      throw new ApiError(
        400,
        "connector_time_range_invalid",
        "The mail time range is invalid.",
      );
    }
    return Math.floor(timestamp / 1_000);
  }

  private gmailSearchValue(value: string) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

  private notionPropertiesText(properties: Record<string, unknown>) {
    const values: string[] = [];
    for (const [name, value] of Object.entries(properties)) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        this.notionRichText((value as Record<string, unknown>).title)
      ) {
        continue;
      }
      const text = this.notionPropertyText(value);
      if (text) {
        values.push(`${name}: ${text}`);
      }
    }
    return values.join(" · ");
  }

  private notionPropertyText(value: unknown): string {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const property = value as Record<string, unknown>;
    const richText = this.notionRichText(property.title || property.rich_text);
    if (richText) return richText;
    for (const key of ["status", "select"]) {
      const selected = property[key];
      if (
        selected &&
        typeof selected === "object" &&
        !Array.isArray(selected) &&
        typeof (selected as Record<string, unknown>).name === "string"
      ) {
        return String((selected as Record<string, unknown>).name);
      }
    }
    if (Array.isArray(property.multi_select)) {
      return property.multi_select
        .map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>).name
            : null,
        )
        .filter((entry): entry is string => typeof entry === "string")
        .join(", ");
    }
    if (Array.isArray(property.people)) {
      return property.people
        .map((person) => {
          if (!person || typeof person !== "object" || Array.isArray(person)) {
            return null;
          }
          const record = person as Record<string, unknown>;
          const detail =
            record.person &&
            typeof record.person === "object" &&
            !Array.isArray(record.person)
              ? (record.person as Record<string, unknown>)
              : null;
          return typeof record.name === "string"
            ? record.name
            : typeof detail?.email === "string"
              ? detail.email
              : null;
        })
        .filter((entry): entry is string => Boolean(entry))
        .join(", ");
    }
    if (
      property.date &&
      typeof property.date === "object" &&
      !Array.isArray(property.date)
    ) {
      const date = property.date as Record<string, unknown>;
      return [date.start, date.end]
        .filter((part) => typeof part === "string")
        .join(" – ");
    }
    for (const key of [
      "number",
      "checkbox",
      "url",
      "email",
      "phone_number",
      "created_time",
      "last_edited_time",
    ]) {
      if (
        typeof property[key] === "string" ||
        typeof property[key] === "number" ||
        typeof property[key] === "boolean"
      ) {
        return String(property[key]);
      }
    }
    return "";
  }

  private notionRichText(value: unknown) {
    const parsed = notionRichTextSchema.safeParse(value);
    return parsed.success
      ? parsed.data
          .map((part) => part.plain_text)
          .join("")
          .trim()
      : "";
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

  private slackApiTimestamp(value: string) {
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) {
      throw new ApiError(
        400,
        "connector_time_range_invalid",
        "The Slack time range is invalid.",
      );
    }
    return (milliseconds / 1_000).toFixed(6);
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

  private isTextFile(name: string, mimeType: string) {
    return (
      this.isTextMime(mimeType) ||
      /\.(?:drawio|xml|svg|md|markdown|txt|csv|tsv|json|ya?ml)$/i.test(name)
    );
  }

  private driveQueryValue(value: string) {
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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

  private truncateSourceContent(value: string, maxBytes: number) {
    if (!value.endsWith(TRUNCATED_SOURCE_MARKER)) {
      return this.truncate(value, maxBytes);
    }
    const markerBytes = Buffer.byteLength(TRUNCATED_SOURCE_MARKER, "utf8");
    if (maxBytes <= markerBytes) {
      return this.truncate(TRUNCATED_SOURCE_MARKER, maxBytes);
    }
    return `${this.truncate(
      value.slice(0, -TRUNCATED_SOURCE_MARKER.length),
      maxBytes - markerBytes,
    )}${TRUNCATED_SOURCE_MARKER}`;
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
