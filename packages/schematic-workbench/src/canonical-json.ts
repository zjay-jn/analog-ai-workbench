import { createHash } from "node:crypto";

export const AAW_CANONICALIZATION_VERSION = "aaw-json-c14n/v1" as const;
export const AAW_CANONICAL_MAX_BYTES = 8 * 1_024 * 1_024;
export const AAW_CANONICAL_MAX_DEPTH = 64;
export const AAW_CANONICAL_MAX_STRING_BYTES = 4_096;

export type AawCanonicalJsonErrorCode =
  | "INVALID_VALUE"
  | "INVALID_NUMBER"
  | "INVALID_STRING"
  | "INVALID_OBJECT"
  | "MAX_DEPTH_EXCEEDED"
  | "PAYLOAD_TOO_LARGE";

export class AawCanonicalJsonError extends Error {
  constructor(
    readonly code: AawCanonicalJsonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AawCanonicalJsonError";
  }
}

export type AawJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AawJsonValue[]
  | { readonly [key: string]: AawJsonValue };

const textEncoder = new TextEncoder();
const forbiddenObjectKeys = new Set(["__proto__", "prototype", "constructor"]);

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new AawCanonicalJsonError(
          "INVALID_STRING",
          "Canonical JSON rejects an unpaired high surrogate.",
        );
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new AawCanonicalJsonError(
        "INVALID_STRING",
        "Canonical JSON rejects an unpaired low surrogate.",
      );
    }
  }
  if (textEncoder.encode(value).byteLength > AAW_CANONICAL_MAX_STRING_BYTES) {
    throw new AawCanonicalJsonError(
      "INVALID_STRING",
      "Canonical JSON string exceeds the v1 byte limit.",
    );
  }
}

function canonicalString(value: string): string {
  assertValidUnicode(value);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new AawCanonicalJsonError("INVALID_STRING", "String encoding failed.");
  }
  return encoded;
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new AawCanonicalJsonError(
      "INVALID_NUMBER",
      "Canonical JSON rejects non-finite numbers and negative zero.",
    );
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new AawCanonicalJsonError(
      "INVALID_NUMBER",
      "Canonical JSON rejects unsafe integers.",
    );
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new AawCanonicalJsonError("INVALID_NUMBER", "Number encoding failed.");
  }
  return encoded;
}

function canonicalizeValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): string {
  if (depth > AAW_CANONICAL_MAX_DEPTH) {
    throw new AawCanonicalJsonError(
      "MAX_DEPTH_EXCEEDED",
      "Canonical JSON nesting exceeds the v1 limit.",
    );
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "string") return canonicalString(value);
  if (typeof value !== "object") {
    throw new AawCanonicalJsonError(
      "INVALID_VALUE",
      "Canonical JSON accepts only JSON data values.",
    );
  }

  if (ancestors.has(value)) {
    throw new AawCanonicalJsonError(
      "INVALID_VALUE",
      "Canonical JSON rejects cyclic data.",
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new AawCanonicalJsonError(
          "INVALID_VALUE",
          "Canonical JSON rejects nonstandard arrays.",
        );
      }
      const symbols = Object.getOwnPropertySymbols(value);
      if (symbols.length !== 0) {
        throw new AawCanonicalJsonError(
          "INVALID_VALUE",
          "Canonical JSON rejects array symbol properties.",
        );
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownNames = Object.getOwnPropertyNames(descriptors);
      const expectedNames = [
        ...Array.from({ length: value.length }, (_unused, index) => String(index)),
        "length",
      ];
      if (
        ownNames.length !== expectedNames.length ||
        ownNames.some((name) => !expectedNames.includes(name))
      ) {
        throw new AawCanonicalJsonError(
          "INVALID_VALUE",
          "Canonical JSON rejects sparse or named array properties.",
        );
      }
      const values: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new AawCanonicalJsonError(
            "INVALID_VALUE",
            "Canonical JSON rejects array holes, accessors, and hidden elements.",
          );
        }
        values.push(canonicalizeValue(descriptor.value, depth + 1, ancestors));
      }
      return `[${values.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AawCanonicalJsonError(
        "INVALID_OBJECT",
        "Canonical JSON accepts only plain objects.",
      );
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new AawCanonicalJsonError(
        "INVALID_OBJECT",
        "Canonical JSON rejects symbol keys.",
      );
    }
    const keys = (ownKeys as string[]).sort();
    const entries: string[] = [];
    for (const key of keys) {
      if (forbiddenObjectKeys.has(key)) {
        throw new AawCanonicalJsonError(
          "INVALID_OBJECT",
          "Canonical JSON rejects prototype-pollution keys.",
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw new AawCanonicalJsonError(
          "INVALID_OBJECT",
          "Canonical JSON rejects accessors and non-enumerable fields.",
        );
      }
      entries.push(
        `${canonicalString(key)}:${canonicalizeValue(
          descriptor.value,
          depth + 1,
          ancestors,
        )}`,
      );
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeAawJsonV1(value: unknown): string {
  const canonical = canonicalizeValue(value, 0, new WeakSet<object>());
  if (textEncoder.encode(canonical).byteLength > AAW_CANONICAL_MAX_BYTES) {
    throw new AawCanonicalJsonError(
      "PAYLOAD_TOO_LARGE",
      "Canonical JSON payload exceeds the v1 byte limit.",
    );
  }
  return canonical;
}

export function sha256CanonicalAawJsonV1(value: unknown): `sha256:${string}` {
  const canonical = canonicalizeAawJsonV1(value);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
