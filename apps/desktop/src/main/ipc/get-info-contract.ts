import { randomUUID } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import {
  getInfoRequestSchema,
  getInfoResultSchema,
  type AppInfoV1,
  type AppMode,
  type GetInfoResultV1,
  type WorkbenchErrorCode,
} from "../../shared/app-info";

const ajv = new Ajv({ allErrors: true, strict: true, formats: { uuid: true } });
const requestValidator: ValidateFunction = ajv.compile(getInfoRequestSchema);
const resultValidator: ValidateFunction = ajv.compile(getInfoResultSchema);

export function isGetInfoRequest(value: unknown): boolean {
  return requestValidator(value);
}

export function isGetInfoResult(value: unknown): value is GetInfoResultV1 {
  return resultValidator(value);
}

export function safeError(
  code: WorkbenchErrorCode,
  message: string,
): GetInfoResultV1 {
  return {
    ok: false,
    error: { code, message, correlationId: randomUUID() },
  };
}

export function createGetInfoResult(input: {
  readonly request: unknown;
  readonly appVersion: string;
  readonly mode: AppMode;
}): GetInfoResultV1 {
  if (!isGetInfoRequest(input.request)) {
    return safeError("INVALID_REQUEST", "The request did not match the approved contract.");
  }

  const value: AppInfoV1 = {
    contractVersion: "workbench.app.getInfo.v1",
    appName: "Analog AI Workbench",
    appVersion: input.appVersion,
    phase: "phase1",
    mode: input.mode,
    platform: "win32",
  };
  const result: GetInfoResultV1 = { ok: true, value };

  if (!isGetInfoResult(result)) {
    return safeError("INTERNAL", "The application information is unavailable.");
  }
  return result;
}
