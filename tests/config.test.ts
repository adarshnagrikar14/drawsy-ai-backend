import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("normalizes runtime configuration", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      APP_HOST: "0.0.0.0",
      APP_PORT: "8080",
      APP_ALLOWED_ORIGINS:
        "https://drawsy.example, https://app.drawsy.example ",
      FIREBASE_PROJECT_ID: "drawsy-production",
    });

    expect(config).toEqual({
      env: "production",
      host: "0.0.0.0",
      port: 8080,
      allowedOrigins: new Set([
        "https://drawsy.example",
        "https://app.drawsy.example",
      ]),
      firebaseProjectId: "drawsy-production",
    });
  });

  it("fails at startup when the Firebase project is not configured", () => {
    expect(() => loadConfig({})).toThrow("Invalid environment configuration");
  });

  it("rejects invalid ports", () => {
    expect(() =>
      loadConfig({
        APP_PORT: "70000",
        FIREBASE_PROJECT_ID: "drawsy-ai-dev",
      }),
    ).toThrow("Invalid environment configuration");
  });
});
