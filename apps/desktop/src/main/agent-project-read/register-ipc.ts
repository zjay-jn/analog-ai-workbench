import type { DesktopBootstrapOptionsV1 } from '../bootstrap';
import { createAgentCallerFenceV1 } from '../agent/agent-caller-fence';
import { AGENT_PROJECT_READ_VERSION, PROJECT_READ_METHODS } from '../../shared/agent/agent-project-read';
import { parseProjectReadResult } from '../../shared/agent/agent-project-read-validation';
import { createProjectReadHost } from './host';
type Context = Parameters<NonNullable<DesktopBootstrapOptionsV1['registerExtension']>>[0];
export function projectReadExtension(options: Parameters<typeof createProjectReadHost>[0]) {
  return (context: Context) => {
    const host = createProjectReadHost(options), fence = createAgentCallerFenceV1({ caller: context.owner, capabilities: ['start_turn'], generation: 1 });
    const extension = { host, revoke: host.revoke, shutdown: host.shutdown, dispose() { host.revoke(); void host.shutdown().catch(() => {}); for (const method of PROJECT_READ_METHODS) context.ipcMain.removeHandler(AGENT_PROJECT_READ_VERSION + ':' + method); } };
    try { for (const method of PROJECT_READ_METHODS) {
      const channel = AGENT_PROJECT_READ_VERSION + ':' + method; context.ipcMain.removeHandler(channel);
      context.ipcMain.handle(channel, async (event: unknown, value: unknown) => {
        try { return parseProjectReadResult(method, await host.invoke(method, value, () => fence.authorizeInvocation({ caller: context.deriveCallerContext(event), operation: 'startTurn' }).allowed)) ?? { ok: false, error: { code: 'ENGINE_FAILED' } }; }
        catch { return { ok: false, error: { code: 'ENGINE_FAILED' } }; }
      });
    } } catch { extension.dispose(); throw Error('PROJECT_READ_INITIALIZATION'); }
    return extension;
  };
}
