import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FirefliesProvider,
  ReadAiProvider,
} from "../src/connectors/remoteMcpProvider.js";
import { RemoteMcpClient } from "../src/connectors/remoteMcpClient.js";
import { ApiError } from "../src/http/apiError.js";

const readProvider = () =>
  new ReadAiProvider(
    {
      clientId: "read-client",
      redirectUri: "http://127.0.0.1:3004/v1/connectors/read-ai/oauth/callback",
    },
    15_000,
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("official remote MCP OAuth providers", () => {
  it("uses PKCE, the MCP resource, and Read AI's documented scopes", () => {
    const target = new URL(
      readProvider().getAuthorizationUrl("state", "challenge"),
    );

    expect(`${target.origin}${target.pathname}`).toBe(
      "https://authn.read.ai/oauth2/auth",
    );
    expect(target.searchParams.get("client_id")).toBe("read-client");
    expect(target.searchParams.get("code_challenge")).toBe("challenge");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("resource")).toBe("https://api.read.ai/mcp");
    expect(target.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "meeting:read",
      "mcp:execute",
    ]);
  });

  it("exchanges a Read AI authorization code and loads the connected account", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 600,
            scope:
              "openid profile email offline_access meeting:read mcp:execute",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sub: "read-user",
            email: "user@example.com",
            name: "Read User",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await readProvider().exchangeAuthorizationCode(
      "authorization-code",
      "verifier",
    );

    const tokenRequest = fetchMock.mock.calls[0]!;
    const body = tokenRequest[1]?.body as URLSearchParams;
    expect(tokenRequest[0]).toBe("https://authn.read.ai/oauth2/token");
    expect(body.get("client_id")).toBe("read-client");
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("resource")).toBe("https://api.read.ai/mcp");
    expect(result.account).toEqual({
      id: "read-user",
      name: "Read User",
      email: "user@example.com",
      avatarUrl: null,
    });
    expect(result.capabilities).toEqual(["read-ai"]);
    expect(result.tokens.refreshToken).toBe("refresh-token");
  });

  it("uses Fireflies' official OAuth and MCP endpoints", () => {
    const provider = new FirefliesProvider(
      {
        clientId: "fireflies-client",
        redirectUri:
          "http://127.0.0.1:3004/v1/connectors/fireflies/oauth/callback",
      },
      15_000,
    );
    const target = new URL(provider.getAuthorizationUrl("state", "challenge"));

    expect(`${target.origin}${target.pathname}`).toBe(
      "https://api.fireflies.ai/authorize",
    );
    expect(target.searchParams.get("client_id")).toBe("fireflies-client");
    expect(target.searchParams.get("scope")).toBe("profile email");
    expect(target.searchParams.get("resource")).toBe(
      "https://api.fireflies.ai/mcp",
    );
  });

  it("keeps a valid Fireflies authorization when profile lookup is temporarily unavailable", async () => {
    const provider = new FirefliesProvider(
      {
        clientId: "fireflies-client",
        redirectUri:
          "http://127.0.0.1:3004/v1/connectors/fireflies/oauth/callback",
      },
      15_000,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 600,
            scope: "profile email",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.spyOn(
      RemoteMcpClient.prototype,
      "callReadOnlyTool",
    ).mockRejectedValueOnce(
      new ApiError(
        502,
        "connector_mcp_unavailable",
        "Fireflies could not be reached.",
      ),
    );

    const result = await provider.exchangeAuthorizationCode(
      "authorization-code",
      "verifier",
    );

    expect(result.account).toEqual({
      id: "fireflies-account",
      name: "Fireflies",
      email: null,
      avatarUrl: null,
    });
  });
});
