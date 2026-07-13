import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type {
  ConnectorProviderId,
  ConnectorTokens,
  EncryptedConnectorTokens,
} from "./types.js";

const encode = (value: Buffer) => value.toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url");

export class ConnectorCrypto {
  constructor(
    private readonly keys: ReadonlyMap<number, Buffer>,
    private readonly currentKeyVersion: number,
  ) {
    if (!keys.has(currentKeyVersion)) {
      throw new Error("Current connector encryption key version is missing");
    }
  }

  encrypt(
    providerId: ConnectorProviderId,
    userId: string,
    connectionId: string,
    tokens: ConnectorTokens,
  ) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.keys.get(this.currentKeyVersion)!,
      iv,
    );
    cipher.setAAD(
      this.aad(providerId, userId, connectionId, this.currentKeyVersion),
    );
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
    } satisfies EncryptedConnectorTokens;
  }

  decrypt(
    providerId: ConnectorProviderId,
    userId: string,
    connectionId: string,
    payload: EncryptedConnectorTokens,
  ): ConnectorTokens {
    const key = this.keys.get(payload.keyVersion);
    if (!key || payload.version !== 1) {
      throw new Error("Connector token encryption key is unavailable");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, decode(payload.iv));
    decipher.setAAD(
      this.aad(providerId, userId, connectionId, payload.keyVersion),
    );
    decipher.setAuthTag(decode(payload.authTag));
    return JSON.parse(
      Buffer.concat([
        decipher.update(decode(payload.ciphertext)),
        decipher.final(),
      ]).toString("utf8"),
    ) as ConnectorTokens;
  }

  private aad(
    providerId: ConnectorProviderId,
    userId: string,
    connectionId: string,
    keyVersion: number,
  ) {
    return Buffer.from(
      `connector:${providerId}:${userId}:${connectionId}:tokens:v1:k${keyVersion}`,
      "utf8",
    );
  }
}
