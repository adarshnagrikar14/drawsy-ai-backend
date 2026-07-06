import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { KanbanEncryptedPayload } from "./types.js";

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const encode = (value: Buffer) => value.toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url");

const aadFor = (
  boardId: string,
  entityType: string,
  entityId: string,
  keyVersion: number,
) =>
  Buffer.from(`${boardId}:${entityType}:${entityId}:v1:k${keyVersion}`, "utf8");

export class KanbanCrypto {
  private readonly masterKeys: ReadonlyMap<number, Buffer>;
  private readonly digestKey: Buffer;

  constructor(
    masterKeyOrKeys: Buffer | ReadonlyMap<number, Buffer>,
    readonly keyVersion = 1,
    digestKey?: Buffer,
  ) {
    this.masterKeys = Buffer.isBuffer(masterKeyOrKeys)
      ? new Map([[keyVersion, masterKeyOrKeys]])
      : masterKeyOrKeys;
    for (const key of this.masterKeys.values()) {
      if (key.byteLength !== 32) {
        throw new Error("Kanban encryption key must contain exactly 32 bytes");
      }
    }
    if (!this.masterKeys.has(keyVersion)) {
      throw new Error("Current Kanban encryption key version is missing");
    }
    this.digestKey = digestKey || this.masterKeys.get(keyVersion)!;
    if (this.digestKey.byteLength !== 32) {
      throw new Error("Kanban digest key must contain exactly 32 bytes");
    }
  }

  createDataKey() {
    return randomBytes(32);
  }

  wrapDataKey(boardId: string, dataKey: Buffer) {
    return this.encryptWithKey(
      this.masterKeys.get(this.keyVersion)!,
      boardId,
      "dataKey",
      boardId,
      dataKey,
      this.keyVersion,
    );
  }

  unwrapDataKey(boardId: string, wrapped: KanbanEncryptedPayload) {
    const masterKey = this.masterKeys.get(wrapped.keyVersion);
    if (!masterKey) {
      throw new Error("Kanban encryption key version is unavailable");
    }
    return this.decryptWithKey(masterKey, boardId, "dataKey", boardId, wrapped);
  }

  encryptJson(
    dataKey: Buffer,
    boardId: string,
    entityType: string,
    entityId: string,
    payload: unknown,
  ) {
    return this.encryptWithKey(
      dataKey,
      boardId,
      entityType,
      entityId,
      Buffer.from(JSON.stringify(payload), "utf8"),
      1,
    );
  }

  decryptJson<T>(
    dataKey: Buffer,
    boardId: string,
    entityType: string,
    entityId: string,
    payload: KanbanEncryptedPayload,
  ): T {
    return JSON.parse(
      this.decryptWithKey(
        dataKey,
        boardId,
        entityType,
        entityId,
        payload,
      ).toString("utf8"),
    ) as T;
  }

  invitationDigest(token: string) {
    return createHash("sha256").update(token, "utf8").digest("base64url");
  }

  emailDigest(email: string) {
    return createHmac("sha256", this.digestKey)
      .update(normalizeEmail(email), "utf8")
      .digest("base64url");
  }

  secureDigestMatches(first: string, second: string) {
    const firstBuffer = Buffer.from(first, "utf8");
    const secondBuffer = Buffer.from(second, "utf8");
    return (
      firstBuffer.byteLength === secondBuffer.byteLength &&
      timingSafeEqual(firstBuffer, secondBuffer)
    );
  }

  private encryptWithKey(
    key: Buffer,
    boardId: string,
    entityType: string,
    entityId: string,
    plaintext: Buffer,
    keyVersion: number,
  ): KanbanEncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(aadFor(boardId, entityType, entityId, keyVersion));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return {
      version: 1,
      keyVersion,
      iv: encode(iv),
      authTag: encode(cipher.getAuthTag()),
      ciphertext: encode(ciphertext),
    };
  }

  private decryptWithKey(
    key: Buffer,
    boardId: string,
    entityType: string,
    entityId: string,
    payload: KanbanEncryptedPayload,
  ) {
    if (payload.version !== 1) {
      throw new Error("Unsupported Kanban encryption envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, decode(payload.iv), {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aadFor(boardId, entityType, entityId, payload.keyVersion));
    decipher.setAuthTag(decode(payload.authTag));
    return Buffer.concat([
      decipher.update(decode(payload.ciphertext)),
      decipher.final(),
    ]);
  }
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
