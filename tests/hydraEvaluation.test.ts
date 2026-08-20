import { describe, expect, it } from "vitest";

import { evaluateHydraMemory } from "../src/hydra/evaluation.js";
import type { HydraQueryResult } from "../src/hydra/types.js";

const result = (
  chunks: Array<{ id: string; text: string }>,
): HydraQueryResult => ({
  context: chunks.map((chunk) => chunk.text).join("\n"),
  chunks,
  sources: [],
  graphContext: null,
  availability: { memory: true, connectorKnowledge: false },
});

describe("Hydra memory evaluation", () => {
  it("recognizes evidence returned from multiple sessions", async () => {
    const summary = await evaluateHydraMemory(
      {
        queryMemory: () =>
          Promise.resolve(
            result([
              {
                id: "session-1",
                text: "The problem is continuity across sessions.",
              },
              {
                id: "session-2",
                text: "Use local HydraDB OSS memory and hosted HydraDB connectors.",
              },
            ]),
          ),
      },
      "evaluation-user",
      [
        {
          id: "synthesis",
          label: "cross-session synthesis",
          query: "How should the system work?",
          expectedRecordIds: ["session-1", "session-2"],
          requiredText: ["local HydraDB OSS", "hosted HydraDB"],
        },
      ],
    );

    expect(summary).toMatchObject({
      passed: true,
      passedCases: 1,
      totalCases: 1,
    });
  });

  it("fails when an abstention case returns an unrelated record", async () => {
    const summary = await evaluateHydraMemory(
      {
        queryMemory: () =>
          Promise.resolve(
            result([{ id: "unrelated", text: "A recorded product decision." }]),
          ),
      },
      "evaluation-user",
      [
        {
          id: "abstention",
          label: "unknown fact",
          query: "What is not recorded?",
          expectNoResults: true,
        },
      ],
    );

    expect(summary.passed).toBe(false);
    expect(summary.results[0]?.reason).toContain(
      "returned context for an unknown fact",
    );
  });

  it("detects duplicate record ids in a retrieval result", async () => {
    const summary = await evaluateHydraMemory(
      {
        queryMemory: () =>
          Promise.resolve(
            result([
              { id: "same-record", text: "one" },
              { id: "same-record", text: "one" },
            ]),
          ),
      },
      "evaluation-user",
      [
        {
          id: "idempotency",
          label: "duplicate write check",
          query: "one",
          expectedRecordIds: ["same-record"],
          expectUniqueRecordIds: true,
        },
      ],
    );

    expect(summary.passed).toBe(false);
    expect(summary.results[0]?.reason).toContain("duplicate record ids");
  });
});
