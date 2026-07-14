import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubProvider } from "../src/connectors/githubProvider.js";

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
})
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const config = {
  appId: 4_298_788,
  appSlug: "drawsy-ai-connector",
  privateKey,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const installation = (permissions: Record<string, "read" | "write">) => ({
  id: 42,
  app_slug: "drawsy-ai-connector",
  html_url: "https://github.com/settings/installations/42",
  suspended_at: null,
  repository_selection: "selected",
  permissions,
  account: {
    id: 14,
    login: "adarsh",
    avatar_url: "https://avatars.githubusercontent.com/u/14",
  },
});

const readPermissions = {
  contents: "read",
  issues: "read",
  metadata: "read",
  pull_requests: "read",
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHubProvider", () => {
  it("starts GitHub's user-controlled installation picker", () => {
    const provider = new GitHubProvider(config, 15_000);

    expect(provider.getAuthorizationUrl("signed-state")).toBe(
      "https://github.com/apps/drawsy-ai-connector/installations/new?state=signed-state",
    );
  });

  it("verifies an installation and creates a short-lived token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((_input, init) => {
        expect(init?.headers).toMatchObject({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        });
        expect(
          String((init?.headers as Record<string, string>).Authorization),
        ).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
        return Promise.resolve(json(installation(readPermissions)));
      })
      .mockImplementationOnce((input, init) => {
        expect(
          input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : input,
        ).toBe("https://api.github.com/app/installations/42/access_tokens");
        expect(init?.method).toBe("POST");
        expect(typeof init?.body).toBe("string");
        const body = typeof init?.body === "string" ? init.body : "null";
        expect(JSON.parse(body)).toEqual({
          permissions: readPermissions,
        });
        return Promise.resolve(
          json({
            token: "installation-token",
            expires_at: "2026-07-15T18:30:00Z",
            permissions: readPermissions,
          }),
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GitHubProvider(
      config,
      15_000,
    ).completeInstallation(42);

    expect(result).toMatchObject({
      account: {
        id: "14",
        name: "adarsh",
        manageUrl: "https://github.com/settings/installations/42",
      },
      tokens: {
        accessToken: "installation-token",
        refreshToken: null,
        installationId: 42,
      },
      capabilities: ["github"],
    });
  });

  it("fails closed if the GitHub App is granted write permission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        json(
          installation({
            ...readPermissions,
            contents: "write",
          }),
        ),
      ),
    );

    await expect(
      new GitHubProvider(config, 15_000).completeInstallation(42),
    ).rejects.toMatchObject({
      status: 409,
      code: "connector_installation_permissions_invalid",
    });
  });

  it("uninstalls the GitHub App when the connection is disconnected", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await new GitHubProvider(config, 15_000).revoke({
      accessToken: "installation-token",
      refreshToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: ["contents:read"],
      installationId: 42,
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe("https://api.github.com/app/installations/42");
    expect(init?.method).toBe("DELETE");
    expect(
      String((init?.headers as Record<string, string>).Authorization),
    ).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
  });
});
