import { describe, expect, it } from "vitest";

import { hydraAppKindFor } from "../src/hydra/service.js";

describe("hydraAppKindFor", () => {
  it("maps connector content to Hydra's accepted app-source families", () => {
    expect(hydraAppKindFor("mail", "mail_message")).toBe("email");
    expect(hydraAppKindFor("slack", "slack_message")).toBe("message");
    expect(hydraAppKindFor("notion", "notion_page")).toBe("knowledge_base");
    expect(hydraAppKindFor("github", "github_issue")).toBe("ticket");
  });

  it("uses custom for connector objects without a safe built-in family", () => {
    expect(hydraAppKindFor("read-ai", "meeting_transcript")).toBe("custom");
    expect(hydraAppKindFor("calendar", "calendar_event")).toBe("custom");
  });
});
