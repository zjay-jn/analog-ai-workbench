import { contextBridge, ipcRenderer } from 'electron';
import { AGENT_PROJECT_READ_VERSION, PROJECT_READ_METHODS, type WorkbenchAgentProjectReadApi } from '../shared/agent/agent-project-read';
import { parseProjectReadRequest, parseProjectReadResult } from '../shared/agent/agent-project-read-validation';
const bridge = Object.freeze(Object.fromEntries(PROJECT_READ_METHODS.map(method => [method, async (value: unknown) => {
  const request = parseProjectReadRequest(method, value); if (!request) return { ok: false, error: { code: 'INVALID_REQUEST' } };
  try { return parseProjectReadResult(method, await ipcRenderer.invoke(AGENT_PROJECT_READ_VERSION + ':' + method, request)) ?? { ok: false, error: { code: 'ENGINE_FAILED' } }; }
  catch { return { ok: false, error: { code: 'ENGINE_FAILED' } }; }
}]))) as WorkbenchAgentProjectReadApi;
contextBridge.exposeInMainWorld('workbenchAgentProjectRead', bridge);
