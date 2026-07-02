import { describe, expect, it } from "vitest";

import { decryptScene, encryptScene } from "../src/workspace/r2SceneStorage.js";

describe("R2 scene encryption envelope", () => {
  it("round-trips scene data without storing readable JSON", () => {
    const key = Buffer.alloc(32, 7);
    const scene = {
      elements: [{ id: "element-1", type: "rectangle" }],
      appState: { name: "Private canvas" },
      files: {},
    };

    const encrypted = encryptScene(scene, key);

    expect(encrypted.toString("utf8")).not.toContain("Private canvas");
    expect(decryptScene(encrypted, key)).toEqual(scene);
  });

  it("rejects tampered ciphertext", () => {
    const key = Buffer.alloc(32, 7);
    const encrypted = encryptScene({ elements: [] }, key);
    const lastIndex = encrypted.length - 1;
    encrypted[lastIndex] = encrypted[lastIndex]! ^ 1;

    expect(() => decryptScene(encrypted, key)).toThrow();
  });
});
