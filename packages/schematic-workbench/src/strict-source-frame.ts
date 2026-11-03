import { createHash } from "node:crypto";

import type { AawJsonValue } from "./canonical-json";

export const STRICT_SOURCE_FRAME_MAX_BYTES = 8 * 1_024 * 1_024;
export const STRICT_SOURCE_FRAME_MAX_DEPTH = 64;
export const STRICT_SOURCE_FRAME_MAX_STRING_BYTES = 4_096;

export type StrictSourceFrameErrorCode =
  | "INVALID_FRAME"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_UTF8"
  | "BOM_FORBIDDEN"
  | "INVALID_JSON"
  | "DUPLICATE_KEY"
  | "PROTOTYPE_KEY"
  | "UNKNOWN_TOP_LEVEL_KEY"
  | "INVALID_NUMBER"
  | "INVALID_STRING"
  | "MAX_DEPTH_EXCEEDED";

export class StrictSourceFrameError extends Error {
  constructor(
    readonly code: StrictSourceFrameErrorCode,
    message: string,
    readonly offset: number | null = null,
  ) {
    super(message);
    this.name = "StrictSourceFrameError";
  }
}

export type StrictSourceFrameOptions = {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxStringBytes?: number;
  readonly allowedTopLevelKeys: readonly string[];
};

export type StrictDecodedSourceFrameV1 = Readonly<{
  decoded: Readonly<Record<string, AawJsonValue>>;
  byteLength: number;
  rawSha256: `sha256:${string}`;
}>;

type MutableJsonObject = { [key: string]: AawJsonValue };
type MutableJsonArray = AawJsonValue[];

const textEncoder = new TextEncoder();
const forbiddenObjectKeys = new Set(["__proto__", "prototype", "constructor"]);

type IntrinsicGetter = (this: unknown) => unknown;

function requiredIntrinsicGetter(
  prototype: object,
  propertyName: string,
): IntrinsicGetter {
  const getter = Object.getOwnPropertyDescriptor(prototype, propertyName)?.get;
  if (typeof getter !== "function") {
    throw new Error(`Required ${propertyName} intrinsic is unavailable.`);
  }
  return getter;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLengthGetter = requiredIntrinsicGetter(
  typedArrayPrototype,
  "byteLength",
);
const typedArrayBufferGetter = requiredIntrinsicGetter(
  typedArrayPrototype,
  "buffer",
);
const arrayBufferByteLengthGetter = requiredIntrinsicGetter(
  ArrayBuffer.prototype,
  "byteLength",
);
const sharedArrayBufferByteLengthGetter =
  typeof SharedArrayBuffer === "undefined"
    ? undefined
    : requiredIntrinsicGetter(SharedArrayBuffer.prototype, "byteLength");
const uint8ArraySetIntrinsic = Uint8Array.prototype.set;

function assertValidUnicode(value: string, offset: number): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new StrictSourceFrameError(
          "INVALID_STRING",
          "Source frame rejects an unpaired high surrogate.",
          offset,
        );
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new StrictSourceFrameError(
        "INVALID_STRING",
        "Source frame rejects an unpaired low surrogate.",
        offset,
      );
    }
  }
}

function deepFreezeJson<T extends AawJsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

class StrictJsonParser {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
    private readonly maxStringBytes: number,
  ) {}

  parse(): AawJsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      this.fail("INVALID_JSON", "Unexpected trailing content.");
    }
    return value;
  }

  private fail(code: StrictSourceFrameErrorCode, message: string): never {
    throw new StrictSourceFrameError(code, message, this.index);
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
        break;
      }
      this.index += 1;
    }
  }

  private parseValue(depth: number): AawJsonValue {
    if (depth > this.maxDepth) {
      this.fail("MAX_DEPTH_EXCEEDED", "Source frame nesting exceeds the v1 limit.");
    }
    const character = this.text[this.index];
    if (character === "{") return this.parseObject(depth + 1);
    if (character === "[") return this.parseArray(depth + 1);
    if (character === '"') return this.parseString();
    if (character === "t") return this.parseLiteral("true", true);
    if (character === "f") return this.parseLiteral("false", false);
    if (character === "n") return this.parseLiteral("null", null);
    if (character === "-" || (character !== undefined && /[0-9]/u.test(character))) {
      return this.parseNumber();
    }
    this.fail("INVALID_JSON", "Expected a JSON value.");
  }

  private parseObject(depth: number): MutableJsonObject {
    if (depth > this.maxDepth) {
      this.fail("MAX_DEPTH_EXCEEDED", "Source frame nesting exceeds the v1 limit.");
    }
    this.index += 1;
    const result: MutableJsonObject = Object.create(null) as MutableJsonObject;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== '"') {
        this.fail("INVALID_JSON", "Object property name must be a string.");
      }
      const key = this.parseString();
      if (forbiddenObjectKeys.has(key)) {
        this.fail("PROTOTYPE_KEY", "Prototype-pollution property name is forbidden.");
      }
      if (keys.has(key)) {
        this.fail("DUPLICATE_KEY", "Duplicate object property name is forbidden.");
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") {
        this.fail("INVALID_JSON", "Expected a colon after an object property name.");
      }
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      const delimiter = this.text[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return result;
      }
      if (delimiter !== ",") {
        this.fail("INVALID_JSON", "Expected a comma or closing object delimiter.");
      }
      this.index += 1;
      this.skipWhitespace();
    }
    this.fail("INVALID_JSON", "Unterminated object.");
  }

  private parseArray(depth: number): MutableJsonArray {
    if (depth > this.maxDepth) {
      this.fail("MAX_DEPTH_EXCEEDED", "Source frame nesting exceeds the v1 limit.");
    }
    this.index += 1;
    const result: MutableJsonArray = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      const delimiter = this.text[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return result;
      }
      if (delimiter !== ",") {
        this.fail("INVALID_JSON", "Expected a comma or closing array delimiter.");
      }
      this.index += 1;
      this.skipWhitespace();
    }
    this.fail("INVALID_JSON", "Unterminated array.");
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    let value = "";
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      const code = this.text.charCodeAt(this.index);
      if (character === '"') {
        this.index += 1;
        assertValidUnicode(value, start);
        if (textEncoder.encode(value).byteLength > this.maxStringBytes) {
          this.fail("INVALID_STRING", "Source frame string exceeds the v1 byte limit.");
        }
        return value;
      }
      if (character === "\\") {
        this.index += 1;
        const escape = this.text[this.index];
        const simpleEscapes: Readonly<Record<string, string>> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (escape === "u") {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
            this.fail("INVALID_JSON", "Invalid Unicode escape.");
          }
          value += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 5;
          continue;
        }
        if (escape === undefined) {
          this.fail("INVALID_JSON", "Invalid string escape.");
        }
        const replacement = simpleEscapes[escape];
        if (replacement === undefined) {
          this.fail("INVALID_JSON", "Invalid string escape.");
        }
        value += replacement;
        this.index += 1;
        continue;
      }
      if (code < 0x20) {
        this.fail("INVALID_JSON", "Unescaped control character in string.");
      }
      value += character;
      this.index += 1;
    }
    this.fail("INVALID_JSON", "Unterminated string.");
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.text.slice(this.index),
    );
    if (match === null) this.fail("INVALID_NUMBER", "Invalid JSON number.");
    const token = match[0];
    this.index += token.length;
    const value = Number(token);
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      this.fail("INVALID_NUMBER", "Non-finite numbers and negative zero are forbidden.");
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      this.fail("INVALID_NUMBER", "Unsafe integers are forbidden.");
    }
    return value;
  }

  private parseLiteral<T extends boolean | null>(token: string, value: T): T {
    if (this.text.slice(this.index, this.index + token.length) !== token) {
      this.fail("INVALID_JSON", "Invalid JSON literal.");
    }
    this.index += token.length;
    return value;
  }
}

function approvedMaxBytes(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > STRICT_SOURCE_FRAME_MAX_BYTES
  ) {
    throw new StrictSourceFrameError(
      "INVALID_FRAME",
      "Source frame byte limit is outside the approved v1 bounds.",
    );
  }
  return value;
}

function trustedUint8ArrayByteLength(value: Uint8Array): number {
  const byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []);
  if (
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    throw new StrictSourceFrameError(
      "INVALID_FRAME",
      "Source frame byte length is invalid.",
    );
  }
  return byteLength;
}

function assertPrivateArrayBufferBacking(value: Uint8Array): void {
  const backingBuffer = Reflect.apply(typedArrayBufferGetter, value, []);
  if (sharedArrayBufferByteLengthGetter !== undefined) {
    try {
      Reflect.apply(sharedArrayBufferByteLengthGetter, backingBuffer, []);
      throw new StrictSourceFrameError(
        "INVALID_FRAME",
        "SharedArrayBuffer-backed source frames are forbidden.",
      );
    } catch (error: unknown) {
      if (error instanceof StrictSourceFrameError) throw error;
    }
  }
  try {
    Reflect.apply(arrayBufferByteLengthGetter, backingBuffer, []);
  } catch {
    throw new StrictSourceFrameError(
      "INVALID_FRAME",
      "Source frame backing storage is not a private ArrayBuffer.",
    );
  }
}

export function snapshotStrictSourceFrameV1(
  rawFrame: unknown,
  maxBytes: number = STRICT_SOURCE_FRAME_MAX_BYTES,
): Uint8Array {
  const byteLimit = approvedMaxBytes(maxBytes);
  try {
    if (
      !ArrayBuffer.isView(rawFrame) ||
      Object.getPrototypeOf(rawFrame) !== Uint8Array.prototype
    ) {
      throw new StrictSourceFrameError(
        "INVALID_FRAME",
        "Source frame must be a standard Uint8Array.",
      );
    }
    const view = rawFrame as Uint8Array;
    const byteLength = trustedUint8ArrayByteLength(view);
    assertPrivateArrayBufferBacking(view);
    if (byteLength > byteLimit) {
      throw new StrictSourceFrameError(
        "PAYLOAD_TOO_LARGE",
        "Source frame exceeds the approved byte limit.",
      );
    }
    const snapshot = new Uint8Array(byteLength);
    Reflect.apply(uint8ArraySetIntrinsic, snapshot, [view]);
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof StrictSourceFrameError) throw error;
    throw new StrictSourceFrameError(
      "INVALID_FRAME",
      "Source frame could not be privately snapshotted.",
    );
  }
}

function validatedLimits(options: StrictSourceFrameOptions): Readonly<{
  maxBytes: number;
  maxDepth: number;
  maxStringBytes: number;
}> {
  const maxBytes = approvedMaxBytes(
    options.maxBytes ?? STRICT_SOURCE_FRAME_MAX_BYTES,
  );
  const maxDepth = options.maxDepth ?? STRICT_SOURCE_FRAME_MAX_DEPTH;
  const maxStringBytes =
    options.maxStringBytes ?? STRICT_SOURCE_FRAME_MAX_STRING_BYTES;
  if (
    !Number.isInteger(maxDepth) ||
    maxDepth <= 0 ||
    maxDepth > STRICT_SOURCE_FRAME_MAX_DEPTH ||
    !Number.isInteger(maxStringBytes) ||
    maxStringBytes <= 0 ||
    maxStringBytes > STRICT_SOURCE_FRAME_MAX_STRING_BYTES
  ) {
    throw new StrictSourceFrameError(
      "INVALID_FRAME",
      "Source frame limits are outside the approved v1 bounds.",
    );
  }
  return Object.freeze({ maxBytes, maxDepth, maxStringBytes });
}

export function decodeAndHashStrictSourceFrameV1(
  rawFrame: unknown,
  options: StrictSourceFrameOptions,
): StrictDecodedSourceFrameV1 {
  const limits = validatedLimits(options);
  const snapshot = snapshotStrictSourceFrameV1(rawFrame, limits.maxBytes);
  const snapshotByteLength = trustedUint8ArrayByteLength(snapshot);
  if (
    snapshotByteLength >= 3 &&
    snapshot[0] === 0xef &&
    snapshot[1] === 0xbb &&
    snapshot[2] === 0xbf
  ) {
    throw new StrictSourceFrameError("BOM_FORBIDDEN", "UTF-8 BOM is forbidden.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
  } catch {
    throw new StrictSourceFrameError("INVALID_UTF8", "Source frame is not valid UTF-8.");
  }
  const value = new StrictJsonParser(
    text,
    limits.maxDepth,
    limits.maxStringBytes,
  ).parse();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StrictSourceFrameError(
      "INVALID_JSON",
      "Source frame top level must be an object.",
    );
  }

  const allowed = new Set(options.allowedTopLevelKeys);
  if (allowed.size !== options.allowedTopLevelKeys.length) {
    throw new StrictSourceFrameError(
      "INVALID_FRAME",
      "Allowed top-level key list contains duplicates.",
    );
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new StrictSourceFrameError(
        "UNKNOWN_TOP_LEVEL_KEY",
        "Source frame contains an unknown top-level field.",
      );
    }
  }
  const decoded = deepFreezeJson(value) as Readonly<
    Record<string, AawJsonValue>
  >;
  return Object.freeze({
    decoded,
    byteLength: snapshotByteLength,
    rawSha256: `sha256:${createHash("sha256")
      .update(snapshot)
      .digest("hex")}` as const,
  });
}

export function decodeStrictSourceFrameV1(
  rawFrame: unknown,
  options: StrictSourceFrameOptions,
): Readonly<Record<string, AawJsonValue>> {
  return decodeAndHashStrictSourceFrameV1(rawFrame, options).decoded;
}
