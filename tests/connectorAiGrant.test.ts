import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectorAiGrantSigner } from "../src/connectors/aiGrant.js";

describe("ConnectorAiGrantSigner", () => {
  afterEach(() => vi.useRealTimers());

  it("expires a signed grant after its short lifetime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00Z"));
    const signer = new ConnectorAiGrantSigner(Buffer.alloc(32, 3), 120_000);
    const { grant } = signer.issue("user-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      capabilities: ["mail"],
    });

    expect(signer.verify(grant)).toMatchObject({
      subject: "user-1",
      sessionId: "session-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      capabilities: ["mail"],
    });
    vi.advanceTimersByTime(120_001);
    expect(() => signer.verify(grant)).toThrowError(
      expect.objectContaining({
        status: 401,
        code: "connector_ai_grant_expired",
      }),
    );
  });
});
