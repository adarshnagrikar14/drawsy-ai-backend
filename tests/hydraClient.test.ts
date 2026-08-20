import { describe, expect, it } from "vitest";

import { hydraIndexingStatusIsSearchable } from "../src/hydra/client.js";

describe("Hydra v2 indexing lifecycle", () => {
  it("treats graph creation as searchable", () => {
    expect(hydraIndexingStatusIsSearchable("graph_creation")).toBe(true);
    expect(hydraIndexingStatusIsSearchable("completed")).toBe(true);
  });

  it("keeps queued and processing sources pending", () => {
    expect(hydraIndexingStatusIsSearchable("queued")).toBe(false);
    expect(hydraIndexingStatusIsSearchable("processing")).toBe(false);
    expect(hydraIndexingStatusIsSearchable("failed")).toBe(false);
    expect(hydraIndexingStatusIsSearchable(undefined)).toBe(false);
  });
});
