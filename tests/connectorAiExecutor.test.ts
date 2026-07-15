import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectorAiExecutor } from "../src/connectors/aiExecutor.js";

import type {
  ConnectorAiExecutionResult,
  ConnectorCapability,
  ConnectorProviderId,
} from "../src/connectors/types.js";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const issue = {
  number: 7,
  title: "Fix connector context",
  body: "Issue details",
  html_url: "https://github.com/drawsy/app/issues/7",
  repository_url: "https://api.github.com/repos/drawsy/app",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  state: "open",
  user: { login: "ada" },
  labels: [{ name: "ai" }],
};

describe("ConnectorAiExecutor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes search and read across every read-only connector capability", async () => {
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const target = new URL(String(input));
      const path = target.pathname;

      if (path === "/gmail/v1/users/me/messages") {
        return Promise.resolve(json({ messages: [{ id: "mail-1" }] }));
      }
      if (path === "/gmail/v1/users/me/messages/mail-1") {
        const full = target.searchParams.get("format") === "full";
        return Promise.resolve(
          json({
            id: "mail-1",
            threadId: "thread-1",
            snippet: "Project update",
            internalDate: "1782864000000",
            payload: {
              headers: [
                { name: "Subject", value: "Status" },
                { name: "From", value: "Ada <ada@example.com>" },
              ],
              ...(full
                ? {
                    mimeType: "text/plain",
                    body: {
                      data: Buffer.from("Full mail").toString("base64url"),
                    },
                  }
                : {}),
            },
          }),
        );
      }
      if (path === "/calendar/v3/calendars/primary/events") {
        return Promise.resolve(
          json({
            items: [
              {
                id: "event-1",
                summary: "Planning",
                description: "Roadmap planning",
                htmlLink: "https://calendar.google.com/event?eid=one",
                created: "2026-07-01T00:00:00Z",
                updated: "2026-07-02T00:00:00Z",
                start: { dateTime: "2026-07-15T09:00:00Z" },
                end: { dateTime: "2026-07-15T10:00:00Z" },
              },
            ],
          }),
        );
      }
      if (path === "/calendar/v3/calendars/primary/events/event-1") {
        return Promise.resolve(
          json({
            id: "event-1",
            summary: "Planning",
            description: "Roadmap planning",
            start: { dateTime: "2026-07-15T09:00:00Z" },
            end: { dateTime: "2026-07-15T10:00:00Z" },
          }),
        );
      }
      if (path === "/drive/v3/files" && !target.searchParams.has("alt")) {
        return Promise.resolve(
          json({
            files: [
              {
                id: "file-1",
                name: "Roadmap.txt",
                mimeType: "text/plain",
                webViewLink: "https://drive.google.com/file/d/file-1/view",
                modifiedTime: "2026-07-02T00:00:00Z",
              },
            ],
          }),
        );
      }
      if (
        path === "/drive/v3/files/file-1" &&
        target.searchParams.get("alt") === "media"
      ) {
        return Promise.resolve(
          new Response("Roadmap content", { status: 200 }),
        );
      }
      if (path === "/drive/v3/files/file-1") {
        return Promise.resolve(
          json({
            id: "file-1",
            name: "Roadmap.txt",
            mimeType: "text/plain",
            webViewLink: "https://drive.google.com/file/d/file-1/view",
            modifiedTime: "2026-07-02T00:00:00Z",
          }),
        );
      }
      if (path === "/v1/search") {
        expect(init?.method).toBe("POST");
        return Promise.resolve(
          json({
            results: [
              {
                object: "page",
                id: "page-1",
                url: "https://notion.so/page-1",
                created_time: "2026-07-01T00:00:00Z",
                last_edited_time: "2026-07-02T00:00:00Z",
                properties: {
                  Name: { title: [{ plain_text: "Product brief" }] },
                },
              },
            ],
            has_more: false,
          }),
        );
      }
      if (path === "/v1/pages/page-1") {
        return Promise.resolve(
          json({
            object: "page",
            id: "page-1",
            url: "https://notion.so/page-1",
            properties: {
              Name: { title: [{ plain_text: "Product brief" }] },
            },
          }),
        );
      }
      if (path === "/v1/blocks/page-1/children") {
        return Promise.resolve(
          json({
            results: [
              {
                id: "block-1",
                type: "paragraph",
                has_children: true,
                paragraph: { rich_text: [{ plain_text: "Brief body" }] },
              },
            ],
            has_more: false,
          }),
        );
      }
      if (path === "/v1/blocks/block-1/children") {
        return Promise.resolve(
          json({
            results: [
              {
                id: "block-2",
                type: "to_do",
                has_children: false,
                to_do: { rich_text: [{ plain_text: "Nested task" }] },
              },
            ],
            has_more: false,
          }),
        );
      }
      if (path === "/api/search.messages") {
        return Promise.resolve(
          json({
            ok: true,
            messages: {
              matches: [
                {
                  ts: "1782864000.000100",
                  text: "Launch update",
                  username: "ada",
                  channel: { id: "C1", name: "launch" },
                  permalink: "https://drawsy.slack.com/archives/C1/p1",
                },
              ],
              paging: { page: 1, pages: 1 },
            },
          }),
        );
      }
      if (path === "/api/conversations.replies") {
        return Promise.resolve(
          json({
            ok: true,
            messages: [
              {
                ts: "1782864000.000100",
                text: "Launch update",
                username: "ada",
              },
            ],
          }),
        );
      }
      if (path === "/search/issues") {
        return Promise.resolve(
          json({ total_count: 1, incomplete_results: false, items: [issue] }),
        );
      }
      if (path === "/installation/repositories") {
        return Promise.resolve(
          json({
            total_count: 1,
            repositories: [
              {
                id: 1,
                name: "app",
                full_name: "drawsy/app",
                html_url: "https://github.com/drawsy/app",
                description: "Drawsy app",
                private: true,
                default_branch: "main",
                owner: { login: "drawsy" },
              },
            ],
          }),
        );
      }
      if (path === "/repos/drawsy/app/issues/7") {
        return Promise.resolve(json(issue));
      }
      throw new Error(`Unexpected provider request: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const executor = new ConnectorAiExecutor(15_000, 256 * 1024);
    const cases: Array<{
      capability: ConnectorCapability;
      providerId: ConnectorProviderId;
      query: string;
      expectedType: string;
    }> = [
      {
        capability: "mail",
        providerId: "google-workspace",
        query: "status",
        expectedType: "mail_message",
      },
      {
        capability: "calendar",
        providerId: "google-workspace",
        query: "planning",
        expectedType: "calendar_event",
      },
      {
        capability: "drive",
        providerId: "google-workspace",
        query: "roadmap",
        expectedType: "drive_file",
      },
      {
        capability: "notion",
        providerId: "notion",
        query: "brief",
        expectedType: "notion_page",
      },
      {
        capability: "slack",
        providerId: "slack",
        query: "launch",
        expectedType: "slack_message",
      },
      {
        capability: "github",
        providerId: "github",
        query: "connector",
        expectedType: "github_issue",
      },
    ];

    for (const testCase of cases) {
      const search = await executor.execute(
        testCase.providerId,
        "provider-secret",
        {
          sessionId: "session-1",
          turnId: "turn-1",
          connectionId: "connection-1",
          capability: testCase.capability,
          operation: "search",
          query: testCase.query,
        },
      );
      expect(search.operation).toBe("search");
      const item = (
        search as Extract<ConnectorAiExecutionResult, { operation: "search" }>
      ).items[0];
      expect(item?.type).toBe(testCase.expectedType);
      expect(item?.id).toBeTruthy();
      expect(JSON.stringify(search)).not.toContain("provider-secret");

      const read = await executor.execute(
        testCase.providerId,
        "provider-secret",
        {
          sessionId: "session-1",
          turnId: "turn-1",
          connectionId: "connection-1",
          capability: testCase.capability,
          operation: "read",
          resourceId: item!.id,
        },
      );
      expect(read.operation).toBe("read");
      expect(
        (read as Extract<ConnectorAiExecutionResult, { operation: "read" }>)
          .item.type,
      ).toBe(testCase.expectedType);
      if (testCase.capability === "notion") {
        expect(
          (read as Extract<ConnectorAiExecutionResult, { operation: "read" }>)
            .item.content,
        ).toContain("Nested task");
      }
      expect(JSON.stringify(read)).not.toContain("provider-secret");
    }

    expect(fetchMock).toHaveBeenCalled();
    for (const [input, init] of fetchMock.mock.calls) {
      const target = new URL(String(input));
      expect(target.protocol).toBe("https:");
      expect([
        "gmail.googleapis.com",
        "www.googleapis.com",
        "api.notion.com",
        "slack.com",
        "api.github.com",
      ]).toContain(target.hostname);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer provider-secret");
    }
  });

  it("uses provider-native list semantics for recent mail, calendar ranges, Drive files, and repositories", async () => {
    const requested: URL[] = [];
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const target = new URL(String(input));
      requested.push(target);
      if (target.pathname === "/gmail/v1/users/me/messages") {
        return Promise.resolve(
          json({ messages: [{ id: "older" }, { id: "newer" }] }),
        );
      }
      if (target.pathname.startsWith("/gmail/v1/users/me/messages/")) {
        const id = target.pathname.split("/").at(-1);
        return Promise.resolve(
          json({
            id,
            internalDate: id === "newer" ? "1784073600000" : "1783987200000",
            payload: {
              headers: [{ name: "Subject", value: id }],
            },
          }),
        );
      }
      if (target.pathname === "/calendar/v3/users/me/calendarList") {
        return Promise.resolve(
          json({
            items: [
              {
                id: "primary@example.com",
                summary: "Primary",
                timeZone: "Asia/Kolkata",
                primary: true,
              },
            ],
          }),
        );
      }
      if (
        target.pathname ===
        "/calendar/v3/calendars/primary%40example.com/events/event-1"
      ) {
        return Promise.resolve(
          json({
            id: "event-1",
            summary: "Project review",
            start: { dateTime: "2026-07-18T12:00:00+05:30" },
            end: { dateTime: "2026-07-18T13:00:00+05:30" },
          }),
        );
      }
      if (
        target.pathname ===
        "/calendar/v3/calendars/primary%40example.com/events"
      ) {
        return Promise.resolve(
          json({
            items: [
              {
                id: "event-1",
                summary: "Project review",
                start: { dateTime: "2026-07-18T12:00:00+05:30" },
                end: { dateTime: "2026-07-18T13:00:00+05:30" },
                attendees: [{ self: true, responseStatus: "accepted" }],
                hangoutLink: "https://meet.google.com/abc-defg-hij",
                recurringEventId: "series-1",
              },
            ],
          }),
        );
      }
      if (target.pathname === "/drive/v3/files") {
        return Promise.resolve(
          json({
            files: [
              {
                id: "drawio-1",
                name: "Architecture.drawio",
                mimeType: "application/octet-stream",
                modifiedTime: "2026-07-14T12:00:00Z",
              },
            ],
          }),
        );
      }
      if (
        target.pathname === "/drive/v3/files/drawio-1" &&
        target.searchParams.get("alt") === "media"
      ) {
        return Promise.resolve(new Response("<mxfile />", { status: 200 }));
      }
      if (target.pathname === "/drive/v3/files/drawio-1") {
        return Promise.resolve(
          json({
            id: "drawio-1",
            name: "Architecture.drawio",
            mimeType: "application/octet-stream",
          }),
        );
      }
      if (target.pathname === "/api/conversations.list") {
        return Promise.resolve(
          json({
            ok: true,
            channels: [
              {
                id: "C1",
                name: "launch",
                is_member: true,
                topic: { value: "Launch decisions" },
              },
            ],
            response_metadata: { next_cursor: "" },
          }),
        );
      }
      if (target.pathname === "/api/conversations.history") {
        return Promise.resolve(
          json({
            ok: true,
            messages: [
              {
                ts: "1784043000.000100",
                text: "Launch is ready",
                user: "U1",
              },
            ],
            response_metadata: { next_cursor: "" },
          }),
        );
      }
      if (target.pathname === "/v1/search") {
        const body: unknown =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        expect(body).toMatchObject({
          sort: {
            direction: "descending",
            timestamp: "last_edited_time",
          },
          page_size: 50,
        });
        expect(body).not.toHaveProperty("query");
        return Promise.resolve(
          json({
            results: [
              {
                object: "page",
                id: "notion-recent",
                url: "https://notion.so/notion-recent",
                last_edited_time: "2026-07-14T12:00:00Z",
                properties: {
                  Name: { title: [{ plain_text: "Latest brief" }] },
                },
              },
            ],
            has_more: false,
          }),
        );
      }
      if (target.pathname === "/installation/repositories") {
        return Promise.resolve(
          json({
            total_count: 2,
            repositories: [
              {
                id: 1,
                name: "drawsy",
                full_name: "adarsh/drawsy",
                html_url: "https://github.com/adarsh/drawsy",
                description: "Canvas agent",
                private: true,
                visibility: "private",
                updated_at: "2026-07-14T12:00:00Z",
                pushed_at: "2026-07-14T12:00:00Z",
                default_branch: "main",
                owner: { login: "adarsh" },
              },
              {
                id: 2,
                name: "drawsy-ai-wss",
                full_name: "adarsh/drawsy-ai-wss",
                html_url: "https://github.com/adarsh/drawsy-ai-wss",
                description: "Drawsy collaboration server",
                private: true,
                visibility: "private",
                updated_at: "2026-07-14T13:00:00Z",
                pushed_at: "2026-07-14T13:00:00Z",
                default_branch: "main",
                owner: { login: "adarsh" },
              },
            ],
          }),
        );
      }
      if (target.pathname === "/repos/adarsh/drawsy") {
        return Promise.resolve(
          json({
            id: 1,
            name: "drawsy",
            full_name: "adarsh/drawsy",
            html_url: "https://github.com/adarsh/drawsy",
            description: "Canvas agent",
            private: true,
            visibility: "private",
            updated_at: "2026-07-14T12:00:00Z",
            default_branch: "main",
            owner: { login: "adarsh" },
          }),
        );
      }
      if (target.pathname === "/repos/adarsh/drawsy/readme") {
        expect(new Headers(init?.headers).get("accept")).toBe(
          "application/vnd.github.raw+json",
        );
        return Promise.resolve(new Response("# Drawsy", { status: 200 }));
      }
      throw new Error(`Unexpected provider request: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const executor = new ConnectorAiExecutor(15_000, 256 * 1024);
    const context = {
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
    };

    const mail = await executor.execute("google-workspace", "secret", {
      ...context,
      operation: "list",
      capability: "mail",
      kind: "mail_messages",
      after: "2026-07-14T00:00:00+05:30",
      limit: 2,
    });
    expect(mail.operation).toBe("list");
    expect(mail.operation === "list" && mail.items[0]?.title).toBe("newer");

    await executor.execute("google-workspace", "secret", {
      ...context,
      operation: "list",
      capability: "calendar",
      kind: "calendars",
    });
    const calendar = await executor.execute("google-workspace", "secret", {
      ...context,
      operation: "list",
      capability: "calendar",
      kind: "calendar_events",
      calendarId: "primary@example.com",
      startTime: "2026-07-13T00:00:00+05:30",
      endTime: "2026-07-20T00:00:00+05:30",
      timeZone: "Asia/Kolkata",
    });
    expect(
      calendar.operation === "list" && calendar.items[0]?.metadata,
    ).toMatchObject({
      selfResponse: "accepted",
      recurring: true,
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
    });
    const calendarItem =
      calendar.operation === "list" ? calendar.items[0] : undefined;
    const calendarRead = await executor.execute("google-workspace", "secret", {
      ...context,
      operation: "read",
      capability: "calendar",
      resourceId: calendarItem!.id,
    });
    expect(calendarRead.operation === "read" && calendarRead.item.title).toBe(
      "Project review",
    );

    const drive = await executor.execute("google-workspace", "secret", {
      ...context,
      operation: "list",
      capability: "drive",
      kind: "drive_files",
    });
    const driveItem = drive.operation === "list" ? drive.items[0] : undefined;
    const driveRead = await executor.execute("google-workspace", "secret", {
      ...context,
      operation: "read",
      capability: "drive",
      resourceId: driveItem!.id,
    });
    expect(driveRead.operation === "read" && driveRead.item.content).toBe(
      "<mxfile />",
    );

    const repositories = await executor.execute("github", "secret", {
      ...context,
      operation: "list",
      capability: "github",
      kind: "github_repositories",
      visibility: "all",
    });
    const searchedRepositories = await executor.execute("github", "secret", {
      ...context,
      operation: "list",
      capability: "github",
      kind: "github_repositories",
      query: "drawsy-wss",
      owner: "adarsh",
      visibility: "private",
    });
    expect(
      searchedRepositories.operation === "list" &&
        searchedRepositories.items[0]?.title,
    ).toBe("adarsh/drawsy-ai-wss");
    const repository =
      repositories.operation === "list" ? repositories.items[0] : undefined;
    const repositoryRead = await executor.execute("github", "secret", {
      ...context,
      operation: "read",
      capability: "github",
      resourceId: repository!.id,
    });
    expect(
      repositoryRead.operation === "read" && repositoryRead.item.content,
    ).toBe("# Drawsy");

    const channels = await executor.execute("slack", "secret", {
      ...context,
      operation: "list",
      capability: "slack",
      kind: "slack_channels",
    });
    expect(channels.operation === "list" && channels.items[0]?.title).toBe(
      "#launch",
    );
    const messages = await executor.execute("slack", "secret", {
      ...context,
      operation: "list",
      capability: "slack",
      kind: "slack_messages",
      channelId: "C1",
      startTime: "2026-07-14T00:00:00+05:30",
      endTime: "2026-07-15T00:00:00+05:30",
    });
    expect(messages.operation === "list" && messages.items[0]?.summary).toBe(
      "Launch is ready",
    );
    const notion = await executor.execute("notion", "secret", {
      ...context,
      operation: "list",
      capability: "notion",
      kind: "notion_content",
    });
    expect(notion.operation === "list" && notion.items[0]?.title).toBe(
      "Latest brief",
    );

    const calendarRequest = requested.find((target) =>
      target.pathname.endsWith("/events"),
    );
    expect(calendarRequest?.searchParams.get("timeMin")).toBe(
      "2026-07-13T00:00:00+05:30",
    );
    expect(calendarRequest?.searchParams.get("timeMax")).toBe(
      "2026-07-20T00:00:00+05:30",
    );
    expect(calendarRequest?.searchParams.get("q")).toBeNull();
    expect(calendarRequest?.searchParams.get("singleEvents")).toBe("true");
    expect(calendarRequest?.searchParams.get("orderBy")).toBe("startTime");
    const slackHistoryRequest = requested.find(
      (target) => target.pathname === "/api/conversations.history",
    );
    expect(slackHistoryRequest?.searchParams.get("channel")).toBe("C1");
    expect(slackHistoryRequest?.searchParams.get("oldest")).toBe(
      "1783967400.000000",
    );
    expect(slackHistoryRequest?.searchParams.get("latest")).toBe(
      "1784053800.000000",
    );
    expect(slackHistoryRequest?.searchParams.get("limit")).toBe("15");
    const repositoryRequests = requested.filter(
      (target) => target.pathname === "/installation/repositories",
    );
    expect(repositoryRequests.length).toBeGreaterThanOrEqual(3);
    expect(
      repositoryRequests.every((target) => !target.searchParams.has("q")),
    ).toBe(true);
    expect(
      repositoryRequests.every(
        (target) => target.searchParams.get("per_page") === "10",
      ),
    ).toBe(true);
  });

  it("rejects provider/capability mismatches before making a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const executor = new ConnectorAiExecutor(15_000, 256 * 1024);

    await expect(
      executor.execute("github", "secret", {
        sessionId: "session-1",
        turnId: "turn-1",
        connectionId: "connection-1",
        capability: "drive",
        operation: "search",
        query: "roadmap",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "connector_capability_forbidden",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("browses and reads selected GitHub repository files, issues, and pull requests", async () => {
    const repository = {
      id: 1,
      name: "drawsy",
      full_name: "adarsh/drawsy",
      html_url: "https://github.com/adarsh/drawsy",
      description: "Canvas agent",
      private: true,
      default_branch: "main",
      owner: { login: "adarsh" },
    };
    const pullRequest = {
      number: 12,
      title: "Improve connector tools",
      body: "Pull request details",
      html_url: "https://github.com/adarsh/drawsy/pull/12",
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-14T00:00:00Z",
      state: "open",
      draft: false,
      user: { login: "adarsh" },
      head: { ref: "github-tools", sha: "head-sha" },
      base: { ref: "main", sha: "base-sha" },
      labels: [{ name: "connectors" }],
      comments: 2,
      review_comments: 3,
      commits: 4,
      additions: 120,
      deletions: 10,
      changed_files: 5,
      merged: false,
      mergeable: true,
    };
    const requested: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const target = new URL(String(input));
        requested.push(target);
        if (target.pathname === "/installation/repositories") {
          return Promise.resolve(
            json({ total_count: 1, repositories: [repository] }),
          );
        }
        if (target.pathname === "/repos/adarsh/drawsy/contents/src") {
          expect(target.searchParams.get("ref")).toBe("feature/connectors");
          return Promise.resolve(
            json([
              {
                name: "connectors",
                path: "src/connectors",
                sha: "tree-sha",
                type: "dir",
                html_url:
                  "https://github.com/adarsh/drawsy/tree/feature/connectors/src/connectors",
              },
              {
                name: "index.ts",
                path: "src/index.ts",
                sha: "file-sha",
                size: 42,
                type: "file",
                html_url:
                  "https://github.com/adarsh/drawsy/blob/feature/connectors/src/index.ts",
              },
            ]),
          );
        }
        if (target.pathname === "/repos/adarsh/drawsy/contents/src/index.ts") {
          expect(target.searchParams.get("ref")).toBe("feature/connectors");
          expect(new Headers(init?.headers).get("accept")).toBe(
            "application/vnd.github.raw+json",
          );
          return Promise.resolve(
            new Response("export const drawsy = true;\n", { status: 200 }),
          );
        }
        if (target.pathname === "/repos/adarsh/drawsy/issues") {
          expect(target.searchParams.get("labels")).toBe("bug,connectors");
          expect(target.searchParams.get("state")).toBe("all");
          return Promise.resolve(
            json([
              {
                ...issue,
                repository_url: "https://api.github.com/repos/adarsh/drawsy",
                html_url: "https://github.com/adarsh/drawsy/issues/7",
                assignees: [{ login: "ada" }],
                comments: 4,
              },
              {
                ...issue,
                number: 12,
                title: pullRequest.title,
                repository_url: "https://api.github.com/repos/adarsh/drawsy",
                html_url: pullRequest.html_url,
                pull_request: {},
              },
            ]),
          );
        }
        if (target.pathname === "/repos/adarsh/drawsy/issues/7") {
          return Promise.resolve(
            json({
              ...issue,
              repository_url: "https://api.github.com/repos/adarsh/drawsy",
              html_url: "https://github.com/adarsh/drawsy/issues/7",
            }),
          );
        }
        if (target.pathname === "/repos/adarsh/drawsy/pulls") {
          expect(target.searchParams.get("head")).toBe("adarsh:github-tools");
          expect(target.searchParams.get("base")).toBe("main");
          return Promise.resolve(json([pullRequest]));
        }
        if (target.pathname === "/repos/adarsh/drawsy/pulls/12") {
          return Promise.resolve(json(pullRequest));
        }
        throw new Error(`Unexpected provider request: ${target}`);
      }),
    );
    const executor = new ConnectorAiExecutor(15_000, 256 * 1024);
    const context = {
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      capability: "github" as const,
    };

    const contents = await executor.execute("github", "secret", {
      ...context,
      operation: "list",
      kind: "github_repository_contents",
      repository: "adarsh/drawsy",
      path: "src",
      ref: "feature/connectors",
    });
    expect(contents.operation === "list" && contents.items).toHaveLength(2);
    const file =
      contents.operation === "list"
        ? contents.items.find((item) => item.type === "github_file")
        : undefined;
    const fileRead = await executor.execute("github", "secret", {
      ...context,
      operation: "read",
      resourceId: file!.id,
    });
    expect(fileRead.operation === "read" && fileRead.item.content).toBe(
      "export const drawsy = true;\n",
    );

    const issues = await executor.execute("github", "secret", {
      ...context,
      operation: "list",
      kind: "github_issues",
      repository: "adarsh/drawsy",
      state: "all",
      labels: ["bug", "connectors"],
    });
    expect(issues.operation === "list" && issues.items).toHaveLength(1);
    const issueRead = await executor.execute("github", "secret", {
      ...context,
      operation: "read",
      resourceId: issues.operation === "list" ? issues.items[0]!.id : "",
    });
    expect(issueRead.operation === "read" && issueRead.item.content).toBe(
      "Issue details",
    );

    const pullRequests = await executor.execute("github", "secret", {
      ...context,
      operation: "list",
      kind: "github_pull_requests",
      repository: "adarsh/drawsy",
      head: "adarsh:github-tools",
      base: "main",
    });
    const pullRequestRead = await executor.execute("github", "secret", {
      ...context,
      operation: "read",
      resourceId:
        pullRequests.operation === "list" ? pullRequests.items[0]!.id : "",
    });
    expect(
      pullRequestRead.operation === "read" && pullRequestRead.item.metadata,
    ).toMatchObject({
      repository: "adarsh/drawsy",
      additions: 120,
      deletions: 10,
      changedFiles: 5,
      head: "github-tools",
      base: "main",
    });
    expect(
      requested.every((target) => target.hostname === "api.github.com"),
    ).toBe(true);
  });

  it("rejects binary GitHub files instead of returning corrupt text", async () => {
    const repository = {
      id: 1,
      name: "drawsy",
      full_name: "adarsh/drawsy",
      html_url: "https://github.com/adarsh/drawsy",
      private: true,
      owner: { login: "adarsh" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const target = new URL(String(input));
        if (target.pathname === "/installation/repositories") {
          return Promise.resolve(
            json({ total_count: 1, repositories: [repository] }),
          );
        }
        if (target.pathname === "/repos/adarsh/drawsy/contents") {
          return Promise.resolve(
            json([
              {
                name: "logo.png",
                path: "logo.png",
                sha: "file-sha",
                size: 4,
                type: "file",
                html_url: "https://github.com/adarsh/drawsy/blob/main/logo.png",
              },
            ]),
          );
        }
        if (target.pathname === "/repos/adarsh/drawsy/contents/logo.png") {
          return Promise.resolve(
            new Response(new Uint8Array([0x89, 0x50, 0x00, 0x47]), {
              status: 200,
            }),
          );
        }
        throw new Error(`Unexpected provider request: ${target}`);
      }),
    );
    const executor = new ConnectorAiExecutor(15_000, 256 * 1024);
    const context = {
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      capability: "github" as const,
    };
    const contents = await executor.execute("github", "secret", {
      ...context,
      operation: "list",
      kind: "github_repository_contents",
      repository: "adarsh/drawsy",
    });

    await expect(
      executor.execute("github", "secret", {
        ...context,
        operation: "read",
        resourceId: contents.operation === "list" ? contents.items[0]!.id : "",
      }),
    ).rejects.toMatchObject({
      status: 415,
      code: "connector_resource_unsupported",
    });
  });

  it("enforces the provider response byte limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("x".repeat(20_000), {
          status: 200,
          headers: { "content-length": "20000" },
        }),
      ),
    );
    const executor = new ConnectorAiExecutor(15_000, 16 * 1024);

    await expect(
      executor.execute("google-workspace", "secret", {
        sessionId: "session-1",
        turnId: "turn-1",
        connectionId: "connection-1",
        capability: "mail",
        operation: "search",
        query: "roadmap",
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "connector_output_too_large",
    });
  });

  it("streams and marks an oversized GitHub README instead of failing", async () => {
    const repository = {
      id: 1,
      name: "drawsy",
      full_name: "adarsh/drawsy",
      html_url: "https://github.com/adarsh/drawsy",
      description: "Canvas agent",
      private: true,
      default_branch: "main",
      owner: { login: "adarsh" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const target = new URL(String(input));
        if (target.pathname === "/installation/repositories") {
          return Promise.resolve(
            json({ total_count: 1, repositories: [repository] }),
          );
        }
        if (target.pathname === "/repos/adarsh/drawsy") {
          return Promise.resolve(json(repository));
        }
        if (target.pathname === "/repos/adarsh/drawsy/readme") {
          return Promise.resolve(
            new Response("# Drawsy\n" + "large readme line\n".repeat(2_000), {
              status: 200,
              headers: { "content-length": "36009" },
            }),
          );
        }
        throw new Error(`Unexpected provider request: ${target}`);
      }),
    );
    const executor = new ConnectorAiExecutor(15_000, 16 * 1024);
    const listed = await executor.execute("github", "secret", {
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      capability: "github",
      operation: "list",
      kind: "github_repositories",
    });
    const resourceId = listed.operation === "list" ? listed.items[0]!.id : "";

    const read = await executor.execute("github", "secret", {
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      capability: "github",
      operation: "read",
      resourceId,
    });

    expect(read.operation).toBe("read");
    expect(read.operation === "read" && read.item.content).toContain(
      "[Content truncated by Drawsy.]",
    );
    expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(
      16 * 1024,
    );
  });
});
