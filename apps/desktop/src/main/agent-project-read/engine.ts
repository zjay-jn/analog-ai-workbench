import type { ProjectReadModel, ProjectReadToolCall, ProjectReadToolResult, ProjectReadUsage } from '../../shared/agent/agent-project-read';
import type { ProjectReadPublication } from '../cloud/project-read-broker';
import type { AgentRuntimeResource } from './runtime-arbiter';
import type { MultimodalRequest } from '../cloud/multimodal-context';
import type { ReplyLimits } from '../../shared/agent/reply-limits';
/** Local gateway classification only; never populated from upstream error text. */
export type ProjectReadFailureReason='CONTEXT_LIMIT'|'UPSTREAM'|'TIMEOUT'|'FIRST_RESPONSE_TIMEOUT'|'IDLE_TIMEOUT'|'PROTOCOL_ERROR'|'AUTHENTICATION_FAILED'|'ENGINE_FAILED';
export type ProjectReadFailureStage='request_validation'|'upstream_http'|'upstream_transport'|'response_validation'|'tool_validation'|'tool_execution';
/** Scalar-only main evidence; no provider text, credentials, headers or tool arguments. */
export type ProjectReadFailureDiagnostic=Readonly<{stage:ProjectReadFailureStage;reason:ProjectReadFailureReason;providerAttempts:number;httpDispatches:number;httpStatus?:number;toolFailure?:import('../../shared/agent/local-tool-failure').LocalToolFailureCode;responseFailure?:import('../../shared/agent/provider-response-diagnostic').ProviderResponseDiagnostic}>;
export type NativeConversationInput=Readonly<{conversationId:string;expectedSessionId?:string;legacyMessages?:readonly import('../cloud/multimodal-context').MultimodalMessage[];externalTurns?:readonly Readonly<{turnId:string;messages:readonly import('../cloud/multimodal-context').MultimodalMessage[]}>[]}>;

export type ProjectReadEngineNotice =
  | Readonly<{ type: 'started'; sessionId: string; controller?: import('../../shared/agent/agent-work-cycle').WorkCycleControllerRef }>
  | Readonly<{ type: 'step'; step: number; usage: ProjectReadUsage }>
  | Readonly<{ type: 'response'; request: number; responseModel: string | null; usage: ProjectReadUsage }>
  | (Readonly<{type:'compaction'}> & import('../../shared/agent/chat-turns').ChatCompactionReceipt)
  | Readonly<{ type: 'text'; messageId: string; step: number; text: string }>
  | Readonly<{ type: 'question'; questionId: string; prompt: string }>
  | Readonly<{ type: 'completed' }>
  | Readonly<{ type: 'failed'; nativeFailure?:import('../../shared/agent/native-engine-failure').NativeEngineFailure }>;
export type ProjectReadEngineInput = Readonly<{
  runId: string; model: ProjectReadModel; signal: AbortSignal;
  workCycle?: boolean;
  /** Main-owned chat envelope; persistent native sessions receive only this turn's input. */
  chatContext?: MultimodalRequest;
  nativeConversation?: NativeConversationInput;
  prompt: Readonly<{ goal: string; constraint: string; rules: string; systemText: string; initialUserText: string }>;
  callbacks: Readonly<{
    notice(event: ProjectReadEngineNotice): void;
    tool(call: ProjectReadToolCall): Promise<ProjectReadToolResult>;
    questionDelivered(questionId: string): Promise<void>;
  }>;
}>;
export type ProjectReadNativeEngine = AgentRuntimeResource & Readonly<{
  health(): Promise<boolean>;
  start(input: ProjectReadEngineInput): Promise<void>;
  answer(runId: string, questionId: string, answer: string): Promise<void>;
  stop(runId: string): Promise<void>;
}>;
export type ProjectReadEngine = ProjectReadNativeEngine & Readonly<{
  status(): Readonly<{ model: ProjectReadModel | null; canStart: boolean; processState: 'idle' | 'starting' | 'ready' | 'failed'; reason: 'MODEL_UNAVAILABLE' | 'ENGINE_FAILED' | null }>;
  accept(runId: string, model: ProjectReadModel): ProjectReadModel;
  acceptChat?(runId: string, model: ProjectReadModel, limits: ReplyLimits): ProjectReadModel;
  /** Main-only, once per chat run after the first tool prepares its fixed project. */
  setProjectContext?(runId:string,context:string):void;
  canDeliver(runId: string, publication: ProjectReadPublication): boolean;
  accounting(runId: string): Readonly<{ providerAttempts: number; httpDispatches: number; contextBytes: number; failureReason?:ProjectReadFailureReason; failureDiagnostic?:ProjectReadFailureDiagnostic }>;
}>;
