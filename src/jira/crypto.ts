import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { EncryptedJiraTokens, JiraTokens } from "./types.js";

const encode = (value: Buffer) => value.toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url");

export class JiraCrypto {
  constructor(
    private readonly keys: ReadonlyMap<number, Buffer>,
    private readonly currentKeyVersion: number,
  ) {
    if (!keys.has(currentKeyVersion)) {
      throw new Error("Current Jira encryption key version is missing");
    }
  }

  encrypt(userId: string, connectionId: string, tokens: JiraTokens) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.keys.get(this.currentKeyVersion)!,
      iv,
    );
    cipher.setAAD(this.aad(userId, connectionId, this.currentKeyVersion));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(tokens), "utf8"),
      cipher.final(),
    ]);
    return {
      version: 1,
      keyVersion: this.currentKeyVersion,
      iv: encode(iv),
      authTag: encode(cipher.getAuthTag()),
      ciphertext: encode(ciphertext),
    } satisfies EncryptedJiraTokens;
  }

  decrypt(
    userId: string,
    connectionId: string,
    payload: EncryptedJiraTokens,
  ): JiraTokens {
    const key = this.keys.get(payload.keyVersion);
    if (!key || payload.version !== 1) {
      throw new Error("Jira token encryption key is unavailable");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, decode(payload.iv));
    decipher.setAAD(this.aad(userId, connectionId, payload.keyVersion));
    decipher.setAuthTag(decode(payload.authTag));
    return JSON.parse(
      Buffer.concat([
        decipher.update(decode(payload.ciphertext)),
        decipher.final(),
      ]).toString("utf8"),
    ) as JiraTokens;
  }

  private aad(userId: string, connectionId: string, keyVersion: number) {
    return Buffer.from(
      `jira:${userId}:${connectionId}:tokens:v1:k${keyVersion}`,
      "utf8",
    );
  }
}
