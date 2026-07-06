import { describe, expect, it } from "vitest";

import { KanbanCrypto, normalizeEmail } from "../src/kanban/crypto.js";
import { createRankBetween, initialRank } from "../src/kanban/rank.js";

describe("KanbanCrypto", () => {
  it("encrypts board-bound payloads and detects tampering or relocation", () => {
    const crypto = new KanbanCrypto(Buffer.alloc(32, 7), 3);
    const dataKey = crypto.createDataKey();
    const encrypted = crypto.encryptJson(
      dataKey,
      "board-001",
      "card",
      "card-001",
      {
        title: "Private title",
      },
    );

    expect(
      crypto.decryptJson(dataKey, "board-001", "card", "card-001", encrypted),
    ).toEqual({ title: "Private title" });
    expect(encrypted.ciphertext).not.toContain("Private title");
    expect(() =>
      crypto.decryptJson(dataKey, "board-002", "card", "card-001", encrypted),
    ).toThrow();
    expect(() =>
      crypto.decryptJson(dataKey, "board-001", "card", "card-002", encrypted),
    ).toThrow();
  });

  it("wraps board data keys and binds the envelope to its board", () => {
    const crypto = new KanbanCrypto(Buffer.alloc(32, 8));
    const dataKey = crypto.createDataKey();
    const wrapped = crypto.wrapDataKey("board-001", dataKey);

    expect(crypto.unwrapDataKey("board-001", wrapped)).toEqual(dataKey);
    expect(() => crypto.unwrapDataKey("board-002", wrapped)).toThrow();
  });

  it("normalizes email before producing a stable keyed digest", () => {
    const crypto = new KanbanCrypto(Buffer.alloc(32, 9));
    expect(normalizeEmail(" User@Example.COM ")).toBe("user@example.com");
    expect(crypto.emailDigest(" User@Example.COM ")).toBe(
      crypto.emailDigest("user@example.com"),
    );
  });

  it("reads data keys wrapped by a previous master-key version", () => {
    const oldKey = Buffer.alloc(32, 10);
    const nextKey = Buffer.alloc(32, 11);
    const digestKey = Buffer.alloc(32, 12);
    const oldCrypto = new KanbanCrypto(oldKey, 1, digestKey);
    const dataKey = oldCrypto.createDataKey();
    const wrapped = oldCrypto.wrapDataKey("board-001", dataKey);
    const encrypted = oldCrypto.encryptJson(
      dataKey,
      "board-001",
      "card",
      "card-001",
      { title: "Before rotation" },
    );
    const rotatedCrypto = new KanbanCrypto(
      new Map([
        [1, oldKey],
        [2, nextKey],
      ]),
      2,
      digestKey,
    );

    expect(rotatedCrypto.unwrapDataKey("board-001", wrapped)).toEqual(dataKey);
    expect(
      rotatedCrypto.decryptJson(
        dataKey,
        "board-001",
        "card",
        "card-001",
        encrypted,
      ),
    ).toEqual({ title: "Before rotation" });
    expect(rotatedCrypto.emailDigest("user@example.com")).toBe(
      oldCrypto.emailDigest("user@example.com"),
    );
  });
});

describe("Kanban ranks", () => {
  it("creates stable sortable ranks without rewriting siblings", () => {
    const middle = initialRank();
    const before = createRankBetween(null, middle);
    const after = createRankBetween(middle, null);
    const nested = createRankBetween(before, middle);

    expect(before < nested).toBe(true);
    expect(nested < middle).toBe(true);
    expect(middle < after).toBe(true);
    expect(new Set([before, nested, middle, after]).size).toBe(4);
  });

  it("rejects invalid neighbor order", () => {
    const middle = initialRank();
    const lower = createRankBetween(null, middle);
    expect(() => createRankBetween(middle, lower)).toThrow(
      "Rank neighbors are not ordered",
    );
  });

  it("keeps creating ranks in a repeatedly edited gap", () => {
    let after = initialRank();
    for (let index = 0; index < 1_000; index += 1) {
      const next = createRankBetween(null, after);
      expect(next < after).toBe(true);
      after = next;
    }
  });
});
