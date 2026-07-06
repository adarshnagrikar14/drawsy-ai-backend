import { describe, expect, it, vi } from "vitest";

import { KanbanCrypto } from "../src/kanban/crypto.js";

const { getFirestore } = vi.hoisted(() => ({ getFirestore: vi.fn() }));

vi.mock("firebase-admin/firestore", () => ({ getFirestore }));

import { FirestoreKanbanService } from "../src/kanban/firestoreKanbanService.js";

describe("Kanban realtime listener multiplexing", () => {
  it("shares board and membership listeners across matching subscribers", () => {
    const boardUnsubscribe = vi.fn();
    const memberUnsubscribe = vi.fn();
    const boardOnSnapshot = vi.fn(() => boardUnsubscribe);
    const memberOnSnapshot = vi.fn(() => memberUnsubscribe);
    const memberDocument = { onSnapshot: memberOnSnapshot };
    const boardDocument = {
      onSnapshot: boardOnSnapshot,
      collection: (name: string) => {
        expect(name).toBe("members");
        return { doc: () => memberDocument };
      },
    };
    getFirestore.mockReturnValue({
      collection: (name: string) => {
        expect(name).toBe("kanbanBoards");
        return { doc: () => boardDocument };
      },
    });
    const service = new FirestoreKanbanService(
      {} as never,
      new KanbanCrypto(Buffer.alloc(32, 1)),
      { eventMs: 1, operationMs: 1, invitesPerHour: 1 },
    );

    const stopFirst = service.subscribeToRealtime(
      "user-0001",
      "board-0001",
      vi.fn(),
      vi.fn(),
    );
    const stopSecond = service.subscribeToRealtime(
      "user-0001",
      "board-0001",
      vi.fn(),
      vi.fn(),
    );

    expect(boardOnSnapshot).toHaveBeenCalledTimes(1);
    expect(memberOnSnapshot).toHaveBeenCalledTimes(1);
    stopFirst();
    expect(boardUnsubscribe).not.toHaveBeenCalled();
    expect(memberUnsubscribe).not.toHaveBeenCalled();
    stopSecond();
    expect(boardUnsubscribe).toHaveBeenCalledTimes(1);
    expect(memberUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
