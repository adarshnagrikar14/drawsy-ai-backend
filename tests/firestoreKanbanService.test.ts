import { describe, expect, it, vi } from "vitest";

import { KanbanCrypto } from "../src/kanban/crypto.js";

const { getFirestore } = vi.hoisted(() => ({ getFirestore: vi.fn() }));

vi.mock("firebase-admin/firestore", () => ({ getFirestore }));

import { FirestoreKanbanService } from "../src/kanban/firestoreKanbanService.js";

type RecordValue = Record<string, unknown>;

class FakeSnapshot {
  constructor(
    readonly ref: FakeReference,
    private readonly value: RecordValue | undefined,
  ) {}

  get id() {
    return this.ref.id;
  }

  get exists() {
    return !!this.value;
  }

  data() {
    return this.value;
  }
}

class FakeQuery {
  private filters: Array<[string, string, unknown]> = [];
  private order: [string, "asc" | "desc"] | null = null;
  private maximum = Number.POSITIVE_INFINITY;

  constructor(
    private readonly firestore: FakeFirestore,
    private readonly path: string,
  ) {}

  where(field: string, operator: string, value: unknown) {
    this.filters.push([field, operator, value]);
    return this;
  }

  orderBy(field: string, direction: "asc" | "desc" = "asc") {
    this.order = [field, direction];
    return this;
  }

  limit(maximum: number) {
    this.maximum = maximum;
    return this;
  }

  get() {
    let docs = this.firestore.children(this.path);
    for (const [field, operator, value] of this.filters) {
      docs = docs.filter((snapshot) => {
        const current = snapshot.data()?.[field];
        if (operator === "==") {
          return current === value;
        }
        if (operator === ">") {
          return Number(current) > Number(value);
        }
        throw new Error(`Unsupported fake operator: ${operator}`);
      });
    }
    if (this.order) {
      const [field, direction] = this.order;
      docs.sort((first, second) => {
        const comparison =
          Number(first.data()?.[field]) - Number(second.data()?.[field]);
        return direction === "asc" ? comparison : -comparison;
      });
    }
    docs = docs.slice(0, this.maximum);
    return Promise.resolve({
      docs,
      empty: docs.length === 0,
      size: docs.length,
    });
  }
}

class FakeCollection extends FakeQuery {
  constructor(
    private readonly database: FakeFirestore,
    readonly collectionPath: string,
  ) {
    super(database, collectionPath);
  }

  doc(id = `auto-${this.database.nextId++}`) {
    return new FakeReference(this.database, `${this.collectionPath}/${id}`);
  }
}

class FakeReference {
  constructor(
    private readonly firestore: FakeFirestore,
    readonly path: string,
  ) {}

  get id() {
    return this.path.split("/").at(-1)!;
  }

  collection(name: string) {
    return new FakeCollection(this.firestore, `${this.path}/${name}`);
  }

  get() {
    return Promise.resolve(this.firestore.snapshot(this));
  }
}

class FakeTransaction {
  constructor(private readonly firestore: FakeFirestore) {}

  get(reference: FakeReference | FakeQuery) {
    return reference.get();
  }

  getAll(...references: FakeReference[]) {
    return this.firestore.getAll(...references);
  }

  create(reference: FakeReference, value: RecordValue) {
    if (this.firestore.values.has(reference.path)) {
      throw new Error(`Document already exists: ${reference.path}`);
    }
    this.firestore.values.set(reference.path, value);
  }

  set(reference: FakeReference, value: RecordValue) {
    this.firestore.values.set(reference.path, value);
  }

  update(reference: FakeReference, value: RecordValue) {
    const current = this.firestore.values.get(reference.path);
    if (!current) {
      throw new Error(`Missing document: ${reference.path}`);
    }
    this.firestore.values.set(reference.path, { ...current, ...value });
  }

  delete(reference: FakeReference) {
    this.firestore.values.delete(reference.path);
  }
}

class FakeFirestore {
  readonly values = new Map<string, RecordValue>();
  nextId = 1;

  collection(name: string) {
    return new FakeCollection(this, name);
  }

  snapshot(reference: FakeReference) {
    return new FakeSnapshot(reference, this.values.get(reference.path));
  }

  children(collectionPath: string) {
    const prefix = `${collectionPath}/`;
    const expectedParts = collectionPath.split("/").length + 1;
    return [...this.values.entries()]
      .filter(
        ([path]) =>
          path.startsWith(prefix) && path.split("/").length === expectedParts,
      )
      .map(
        ([path, value]) =>
          new FakeSnapshot(new FakeReference(this, path), value),
      );
  }

  getAll(...references: FakeReference[]) {
    return Promise.resolve(
      references.map((reference) => this.snapshot(reference)),
    );
  }

  runTransaction<T>(operation: (transaction: FakeTransaction) => Promise<T>) {
    return operation(new FakeTransaction(this));
  }
}

const commandBase = {
  clientSequence: 1,
  knownBoardRevision: 1,
};

describe("FirestoreKanbanService", () => {
  it("commits encrypted commands, deltas, and idempotent retries", async () => {
    const firestore = new FakeFirestore();
    getFirestore.mockReturnValue(firestore);
    const service = new FirestoreKanbanService(
      {} as never,
      new KanbanCrypto(Buffer.alloc(32, 4)),
      { eventMs: 1000, operationMs: 1000, invitesPerHour: 10 },
    );
    const created = await service.createBoard("user-0001", {
      id: "board-0001",
      title: "Roadmap",
      initialColumnId: "column-0001",
      initialColumnTitle: "Not started",
    });

    expect(created.board.title).toBe("Roadmap");
    expect(created.columns.map((column) => column.title)).toEqual([
      "Not started",
      "In progress",
      "Done",
      "In review",
    ]);
    expect(
      JSON.stringify(firestore.values.get("kanbanBoards/board-0001")),
    ).not.toContain("Roadmap");

    const createCard = {
      ...commandBase,
      operationId: "operation-0001",
      type: "createCard" as const,
      entityId: "card-0001",
      payload: {
        title: "Private task",
        description: "Secret",
        priority: "high" as const,
        progress: 20,
        dueDate: "2026-07-10",
        legacyAssigneeText: "You",
        legacyCanvasTags: [],
        columnId: "column-0001",
        assigneeIds: [],
        beforeId: null,
        afterId: null,
      },
    };
    const first = await service.applyCommands(
      "user-0001",
      "board-0001",
      "client-0001",
      [createCard],
    );
    const duplicate = await service.applyCommands(
      "user-0001",
      "board-0001",
      "client-0001",
      [createCard],
    );

    expect(first[0]).toMatchObject({ status: "applied", revision: 2 });
    expect(duplicate[0]).toEqual({
      operationId: "operation-0001",
      status: "duplicate",
      revision: 2,
    });
    expect(
      JSON.stringify(
        firestore.values.get("kanbanBoards/board-0001/cards/card-0001"),
      ),
    ).not.toContain("Private task");
    await expect(
      service.getChanges("user-0001", "board-0001", 1),
    ).resolves.toMatchObject({
      latestRevision: 2,
      changes: [
        {
          revision: 2,
          entityType: "card",
          entityId: "card-0001",
          value: { title: "Private task", description: "Secret" },
        },
      ],
    });
  });

  it("enforces board lock inside the command transaction", async () => {
    const firestore = new FakeFirestore();
    getFirestore.mockReturnValue(firestore);
    const service = new FirestoreKanbanService(
      {} as never,
      new KanbanCrypto(Buffer.alloc(32, 5)),
      { eventMs: 1000, operationMs: 1000, invitesPerHour: 10 },
    );
    await service.createBoard("user-0001", {
      id: "board-0001",
      title: "Roadmap",
      initialColumnId: "column-0001",
      initialColumnTitle: "Not started",
    });
    await service.applyCommands("user-0001", "board-0001", "client-0001", [
      {
        ...commandBase,
        operationId: "operation-lock",
        type: "updateBoard",
        payload: { isLocked: true },
      },
    ]);
    const result = await service.applyCommands(
      "user-0001",
      "board-0001",
      "client-0001",
      [
        {
          ...commandBase,
          operationId: "operation-create",
          type: "createColumn",
          entityId: "column-0002",
          payload: { title: "Done", beforeId: null, afterId: null },
        },
      ],
    );

    expect(result[0]).toMatchObject({
      status: "rejected",
      code: "board_locked",
    });
  });
});
