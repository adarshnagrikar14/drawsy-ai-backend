import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

import { ApiError } from "../http/apiError.js";

import type { AppConfig } from "../config.js";

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export const encryptScene = (scene: unknown, key: Buffer) => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(scene), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([ENVELOPE_VERSION]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
};

export const decryptScene = (envelope: Buffer, key: Buffer): unknown => {
  const minimumLength = 1 + IV_BYTES + AUTH_TAG_BYTES;
  if (
    envelope.byteLength <= minimumLength ||
    envelope[0] !== ENVELOPE_VERSION
  ) {
    throw new ApiError(
      502,
      "scene_unavailable",
      "The canvas scene has an invalid storage envelope.",
    );
  }
  const ivStart = 1;
  const tagStart = ivStart + IV_BYTES;
  const ciphertextStart = tagStart + AUTH_TAG_BYTES;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    envelope.subarray(ivStart, tagStart),
  );
  decipher.setAuthTag(envelope.subarray(tagStart, ciphertextStart));
  const plaintext = Buffer.concat([
    decipher.update(envelope.subarray(ciphertextStart)),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
};

export interface SceneStorage {
  put(objectKey: string, scene: unknown): Promise<void>;
  get(objectKey: string): Promise<unknown>;
  delete(objectKey: string): Promise<void>;
  createObjectKey(userId: string, canvasId: string): string;
}

export class R2SceneStorage implements SceneStorage {
  private readonly client: S3Client;

  constructor(private readonly config: AppConfig) {
    this.client = new S3Client({
      endpoint: config.r2.endpointUrl,
      region: config.r2.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
      },
    });
  }

  createObjectKey(userId: string, canvasId: string) {
    return `${this.config.r2.keyPrefix}users/${userId}/canvases/${canvasId}/${randomUUID()}.bin`;
  }

  async put(objectKey: string, scene: unknown) {
    const body = encryptScene(scene, this.config.r2.encryptionKey);
    if (body.byteLength > this.config.sceneSizeLimitBytes) {
      throw new ApiError(
        413,
        "scene_too_large",
        "The canvas exceeds the workspace size limit.",
      );
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.r2.bucketName,
        Key: objectKey,
        Body: body,
        ContentType: "application/octet-stream",
        CacheControl: "private, no-store",
      }),
    );
  }

  async get(objectKey: string) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.r2.bucketName,
          Key: objectKey,
        }),
      );
      const body = response.Body
        ? Buffer.from(await response.Body.transformToByteArray())
        : Buffer.alloc(0);
      if (!body.byteLength) {
        throw new ApiError(
          502,
          "scene_unavailable",
          "The canvas scene is unavailable.",
        );
      }
      return decryptScene(body, this.config.r2.encryptionKey);
    } catch (error) {
      if (
        error instanceof NoSuchKey ||
        (error instanceof S3ServiceException &&
          (error.name === "NoSuchKey" ||
            error.$metadata.httpStatusCode === 404))
      ) {
        throw new ApiError(
          404,
          "scene_not_found",
          "The canvas scene was not found.",
        );
      }
      throw error;
    }
  }

  async delete(objectKey: string) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.r2.bucketName,
        Key: objectKey,
      }),
    );
  }
}
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
