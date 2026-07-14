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
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "Brief body" }] },
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
});
