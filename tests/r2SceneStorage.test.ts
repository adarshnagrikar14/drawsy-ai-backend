import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptScene, encryptScene } from "../src/workspace/r2SceneStorage.js";
import { hashScene } from "../src/workspace/sceneCodec.js";

describe("R2 scene encryption envelope", () => {
  it("hashes semantically identical object key order consistently", () => {
    expect(hashScene({ appState: {}, elements: [] })).toBe(
      hashScene({ elements: [], appState: {} }),
    );
  });

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

  it("compresses repetitive scene data before encryption", () => {
    const key = Buffer.alloc(32, 7);
    const scene = { elements: [{ text: "drawsy ".repeat(1000) }] };

    const encrypted = encryptScene(scene, key);

    expect(encrypted.byteLength).toBeLessThan(
      Buffer.byteLength(JSON.stringify(scene)),
    );
  });

  it("continues to read version-one uncompressed envelopes", () => {
    const key = Buffer.alloc(32, 7);
    const scene = { elements: [], appState: { name: "Legacy" }, files: {} };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(scene), "utf8"),
      cipher.final(),
    ]);
    const legacyEnvelope = Buffer.concat([
      Buffer.from([1]),
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]);

    expect(decryptScene(legacyEnvelope, key)).toEqual(scene);
  });
});
