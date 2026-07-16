import { describe, expect, it } from "vitest";

import { connectorAiExecutionRequestSchema } from "../src/connectors/aiSchemas.js";

const context = {
  sessionId: "session-1",
  turnId: "turn-1",
  connectionId: "connection-1",
};

describe("connector AI request schema", () => {
  it("accepts an empty AWS inventory query with the AWS result limit", () => {
    expect(
      connectorAiExecutionRequestSchema.parse({
        ...context,
        operation: "search",
        capability: "aws",
        region: "ap-south-1",
        query: "",
        limit: 100,
      }),
    ).toMatchObject({ capability: "aws", query: "", limit: 100 });
  });

  it("keeps generic provider searches bounded separately from AWS", () => {
    expect(
      connectorAiExecutionRequestSchema.safeParse({
        ...context,
        operation: "search",
        capability: "mail",
        query: "project",
        limit: 50,
      }).success,
    ).toBe(false);
  });

  it("uses the AWS Resource Explorer query-length contract", () => {
    expect(
      connectorAiExecutionRequestSchema.safeParse({
        ...context,
        operation: "search",
        capability: "aws",
        region: "ap-south-1",
        query: "x".repeat(1_281),
      }).success,
    ).toBe(false);
  });
});
