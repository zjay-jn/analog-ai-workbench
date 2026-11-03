import type { WorkbenchApiV1 } from "../../shared/app-info";
import type {EnginePilotApi} from '../../shared/agent/engine-pilot';
import type {WorkbenchAgentProjectReadApi} from '../../shared/agent/agent-project-read';
import type {WorkbenchCloudApiV2} from '../../shared/agent/cloud-chat-api';
import type {WorkbenchSessionsApi} from '../../shared/agent/chat-sessions';
import type {WorkbenchSettingsApi} from '../../shared/agent/model-settings';
import type {WorkbenchEditsApi} from '../../shared/agent/reviewed-edit';
import type {WorkbenchWindowMenuApi} from '../../shared/window-menu';
import type {WorkbenchWorkspaceApi} from '../../shared/agent/project-workspace';
import type {WorkbenchDraftsApi} from '../../shared/agent/chat-drafts';
import type {WorkbenchChatExportApi} from '../../shared/agent/chat-export';

import type {WorkbenchDisplayPathsApi} from '../../shared/agent/display-paths';
import type {WorkbenchProjectFoldersApi} from '../../shared/agent/project-folders';

declare global {
  interface Window {
    readonly workbenchEnginePilot?: EnginePilotApi;
    readonly workbenchAgentProjectRead?: WorkbenchAgentProjectReadApi;
    readonly workbenchProjectFolders?: WorkbenchProjectFoldersApi;
    readonly workbenchDisplayPaths?: WorkbenchDisplayPathsApi;
    readonly workbenchFilePath?: {describe:(file:File)=>readonly string[]};
    readonly workbench: WorkbenchApiV1;
    readonly workbenchCloud?: WorkbenchCloudApiV2;
    readonly workbenchSessions?: WorkbenchSessionsApi;
    readonly workbenchModelSettings?: WorkbenchSettingsApi;
    readonly workbenchEdits?: WorkbenchEditsApi;
    readonly workbenchWindowMenu?: WorkbenchWindowMenuApi;
    readonly workbenchWorkspace?: WorkbenchWorkspaceApi;
    readonly workbenchDrafts?: WorkbenchDraftsApi;
    readonly workbenchChatExport?: WorkbenchChatExportApi;
  }
}

export {};
