import type {ChatRunOrigin,ChatRunLink} from '../../shared/agent/chat-turns';
import type {ProjectReadModel,BoundProjectReadRef,ProjectReadEventData} from '../../shared/agent/agent-project-read';
import type {WslResultsBinding} from '../../shared/agent/wsl-results';
import type {FolderRoot} from '../cloud/project-folder-files';
import type {ProjectReadEngine,ProjectReadEngineInput} from './engine';
import type {AgentRuntimeLease} from './runtime-arbiter';

export type ChatProjectSnapshot=Readonly<{
 projectId:string;name:string;cwd:string|null;scope:Readonly<{root:FolderRoot;project:BoundProjectReadRef}>|null;
 wsl:Promise<WslResultsBinding|null>;commandEnvironmentVersion:string;
 wslUnavailable?:()=>boolean;
}>;
export type ChatProjectEvent={ [K in keyof ProjectReadEventData]:{type:K;data:ProjectReadEventData[K]} }[keyof ProjectReadEventData];
export type ChatScopeAdmission=Readonly<{
 runId:string;origin:ChatRunOrigin;model:ProjectReadModel;snapshot:ChatProjectSnapshot;
 lease:AgentRuntimeLease;abort:AbortController;engine:ProjectReadEngine;
 outputBytes:number;history:readonly ChatProjectEvent[];
 recoveryVersion?:string;
 prepareWorkHead?:()=>Promise<string|null>;
 onLinked(link:ChatRunLink):void;
 onReady(callbacks:ProjectReadEngineInput['callbacks']):void;
 onFailure(error:unknown):void;
}>;
