import type {SessionTurn,ChatSession} from '../../shared/agent/chat-sessions';
import type {ChatAcceptedContext,ChatTurnExecution,ChatTurnActivity,ChatTurnInteraction,ChatConfigurationInteraction} from '../../shared/agent/chat-turns';
import type {MultimodalRequest} from './multimodal-context';

/** Main-only seam. No caller can supply a folder, environment, credential or run association. */
export type UnifiedChatExecutionUpdate=Pick<ChatTurnExecution,'phase'|'cleanupState'|'runLink'|'pendingInteraction'>&Partial<Pick<ChatTurnExecution,'clarifications'|'nativeSession'|'compaction'|'failureDiagnostic'|'toolScopeRequested'|'readOnlyScope'>>;
export class UnifiedChatConfigurationError extends Error {
 constructor(readonly code:'CONFIGURATION_REQUIRED'|'CONFIGURATION_UNAVAILABLE'){super(code);}
}
export interface UnifiedChatService {
 filesystemRead?:true;
 capture(input:{sessionId:string;executionId:string;provider:ChatAcceptedContext['provider'];model:string;historyVersion:string;retryConfiguration?:ChatConfigurationInteraction}):ChatAcceptedContext;
 execute(input:{sessionId:string;turn:SessionTurn;context:MultimodalRequest;historyTurnIds?:readonly string[];signal:AbortSignal;
   onText(text:string):void;onExecution(update:UnifiedChatExecutionUpdate):void;
   /** Trusted local failure before awaited cleanup; fixes the first stop cause. */
   onFailure?(error:unknown):void}):Promise<void>;
 answer(executionId:string,interaction:ChatTurnInteraction,answer:string):Promise<void>;
 activity(sessionId:string,turn:SessionTurn,afterSequence:number):ChatTurnActivity;
 /** Pure ledger reconciliation. Must never start or recover an external execution. */
 reconcile(sessionId:string,turn:SessionTurn):ChatTurnExecution;
 forget(executionId:string):void;
 busy():boolean;
 confirm?(session:ChatSession,turn:SessionTurn,interaction:ChatTurnInteraction):Promise<void>;
}
