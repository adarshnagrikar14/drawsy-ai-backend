import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { ApiError } from "../http/apiError.js";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorProviderId } from "./types.js";

type RemoteMcpProviderId = Extract<
  ConnectorProviderId,
  "read-ai" | "fireflies"
>;

const REMOTE_MCP_SERVERS: Record<RemoteMcpProviderId, string> = {
  "read-ai": "https://api.read.ai/mcp",
  fireflies: "https://api.fireflies.ai/mcp",
};

const safeRemoteError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /([?&](?:access_token|refresh_token|token)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .slice(0, 240);
};

const isReadOnlyTool = (
  providerId: RemoteMcpProviderId,
  tool: { name: string; annotations?: { readOnlyHint?: boolean } },
) => {
  if (tool.annotations?.readOnlyHint === true) {
    return true;
  }
  if (providerId === "read-ai") {
    return /^(?:read(?:[_-]ai)?[_:.-]?)?(?:get|list)[_:.-]?meetings?\b/i.test(
      tool.name,
    );
  }
  return /^(?:fireflies_)?(?:get_|list_|search$|fetch$|search_|fetch_)/.test(
    tool.name,
  );
};

export class RemoteMcpClient {
  constructor(
    private readonly timeoutMs: number,
    private readonly maxOutputBytes: number,
  ) {}

  async listReadOnlyTools(
    providerId: RemoteMcpProviderId,
    accessToken: string,
  ) {
    return this.withClient(providerId, accessToken, async (client) => {
      const response = await client.listTools(undefined, {
        timeout: this.timeoutMs,
      });
      return response.tools.filter((tool) => isReadOnlyTool(providerId, tool));
    });
  }

  async callReadOnlyTool(
    providerId: RemoteMcpProviderId,
    accessToken: string,
    toolName: string,
    args: Record<string, unknown>,
  ) {
    return this.withClient(providerId, accessToken, async (client) => {
      const tools = await client.listTools(undefined, {
        timeout: this.timeoutMs,
      });
      const tool = tools.tools.find((candidate) => candidate.name === toolName);
      if (!tool || !isReadOnlyTool(providerId, tool)) {
        throw new ApiError(
          403,
          "connector_mcp_tool_forbidden",
          "This connector exposes only read-only MCP tools.",
        );
      }
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: this.timeoutMs },
      );
      if (!("content" in result)) {
        throw new ApiError(
          502,
          "connector_mcp_task_unsupported",
          "This remote MCP tool requires an unsupported asynchronous task.",
        );
      }
      const callResult = result as CallToolResult;
      this.assertOutputSize(callResult);
      if (callResult.isError) {
        throw new ApiError(
          502,
          "connector_mcp_tool_failed",
          this.errorText(callResult),
        );
      }
      return callResult;
    });
  }

  private async withClient<T>(
    providerId: RemoteMcpProviderId,
    accessToken: string,
    operation: (client: Client) => Promise<T>,
  ) {
    const client = new Client({ name: "drawsy-ai", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(REMOTE_MCP_SERVERS[providerId]),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      },
    );
    try {
      await client.connect(transport);
      return await operation(client);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "connector_mcp_request_failed",
          providerId,
          error:
            error instanceof Error
              ? { name: error.name, message: safeRemoteError(error) }
              : safeRemoteError(error),
        }),
      );
      const detail = safeRemoteError(error);
      throw new ApiError(
        502,
        "connector_mcp_unavailable",
        `${providerId === "read-ai" ? "Read AI" : "Fireflies"} could not be reached${detail ? ` (${detail})` : "."}`,
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private assertOutputSize(value: unknown) {
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") > this.maxOutputBytes
    ) {
      throw new ApiError(
        413,
        "connector_response_too_large",
        "The connector provider response is too large.",
      );
    }
  }

  private errorText(result: CallToolResult) {
    const text = result.content.find(
      (
        content,
      ): content is Extract<
        (typeof result.content)[number],
        { type: "text" }
      > => content.type === "text",
    );
    return text?.text.slice(0, 500) || "The remote MCP tool failed.";
  }
}

export type { RemoteMcpProviderId };
