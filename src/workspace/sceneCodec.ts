import { createHash } from "node:crypto";

const sortObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = sortObjectKeys((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
};

export const serializeScene = (scene: unknown) =>
  Buffer.from(JSON.stringify(sortObjectKeys(scene)), "utf8");

export const hashScene = (scene: unknown) =>
  createHash("sha256").update(serializeScene(scene)).digest("hex");
