export const GET_INFO_CHANNEL = "workbench.app.getInfo.v1" as const;

export type AppMode = "development" | "production" | "test";

export interface AppInfoV1 {
  readonly contractVersion: "workbench.app.getInfo.v1";
  readonly appName: "Analog AI Workbench";
  readonly appVersion: string;
  readonly phase: "phase1";
  readonly mode: AppMode;
  readonly platform: "win32";
}

export type WorkbenchErrorCode =
  | "INVALID_REQUEST"
  | "CAPABILITY_DENIED"
  | "REVISION_UNAVAILABLE"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL";

export interface WorkbenchSafeErrorV1 {
  readonly code: WorkbenchErrorCode;
  readonly message: string;
  readonly correlationId: string;
}

export type GetInfoResultV1 =
  | { readonly ok: true; readonly value: AppInfoV1 }
  | { readonly ok: false; readonly error: WorkbenchSafeErrorV1 };

export interface WorkbenchApiV1 {
  readonly getInfo: () => Promise<GetInfoResultV1>;
  readonly resolveReviewedArtifact: (
    request: ResolveReviewedArtifactRequestV1,
  ) => Promise<ResolveReviewedArtifactResultV1>;
  readonly startTurn: (
    request: StartTurnRequestV1,
  ) => Promise<StartTurnResultV1>;
  readonly subscribeRun: (
    request: SubscribeRunRequestV1,
    callback: (event: CanonicalEventV1) => void,
  ) => Promise<SubscribeRunResultV1>;
  readonly cancelRun: (
    request: CancelRunRequestV1,
  ) => Promise<CancelRunResultV1>;
  readonly resolveArtifact: (
    request: ResolveArtifactRequestV1,
  ) => Promise<ResolveResultV1>;
  readonly resolveCitation: (
    request: ResolveCitationRequestV1,
  ) => Promise<ResolveResultV1>;
}

export const getInfoRequestSchema = {
  $id: "workbench.app.getInfo.v1.request",
  type: "object",
  properties: {},
  additionalProperties: false,
  required: [],
} as const;

export const getInfoResultSchema = {
  $id: "workbench.app.getInfo.v1.result",
  oneOf: [
    {
      type: "object",
      properties: {
        ok: { const: true },
        value: {
          type: "object",
          properties: {
            contractVersion: { const: "workbench.app.getInfo.v1" },
            appName: { const: "Analog AI Workbench" },
            appVersion: { type: "string", minLength: 1, maxLength: 64 },
            phase: { const: "phase1" },
            mode: { enum: ["development", "production", "test"] },
            platform: { const: "win32" },
          },
          required: [
            "contractVersion",
            "appName",
            "appVersion",
            "phase",
            "mode",
            "platform"
          ],
          additionalProperties: false,
        },
      },
      required: ["ok", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ok: { const: false },
        error: {
          type: "object",
          properties: {
            code: {
              enum: ["INVALID_REQUEST", "CAPABILITY_DENIED", "INTERNAL"]
            },
            message: { type: "string", minLength: 1, maxLength: 160 },
            correlationId: { type: "string", format: "uuid" },
          },
          required: ["code", "message", "correlationId"],
          additionalProperties: false,
        },
      },
      required: ["ok", "error"],
      additionalProperties: false,
    },
  ],
} as const;
import type {
  ResolveReviewedArtifactRequestV1,
  ResolveReviewedArtifactResultV1,
} from "./schematic/reviewed-artifact-resolve";
import type {
  CanonicalEventV1,
  ResolveArtifactRequestV1,
  ResolveCitationRequestV1,
  ResolveResultV1,
  CancelRunRequestV1,
  CancelRunResultV1,
  StartTurnRequestV1,
  StartTurnResultV1,
  SubscribeRunRequestV1,
  SubscribeRunResultV1,
} from "./agent/desktop-agent-api";
