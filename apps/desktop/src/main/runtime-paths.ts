import path from 'node:path';

/** Main-owned locations. Renderer requests never supply installation or data roots. */
export type RuntimePaths = Readonly<{
  installationRoot: string;
  storageRoot: string;
  dataRoot: string;
  profileRoot: string;
  runtimeRoot: string;
  nativeRoot: string;
  opencodeExecutable: string;
  pilotRoot: string;
}>;

function root(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw Error('RUNTIME_PATH_CONFIGURATION');
  const resolved = path.resolve(value);
  if (path.dirname(resolved) === resolved) throw Error('RUNTIME_PATH_CONFIGURATION');
  return resolved;
}

export function createRuntimePaths(options: Readonly<{installationRoot: string; storageRoot: string}>): RuntimePaths {
  const installationRoot = root(options.installationRoot), storageRoot = root(options.storageRoot);
  const dataRoot = path.join(storageRoot, '.local'), runtimeRoot = path.join(installationRoot, '.local', 'runtime');
  return Object.freeze({installationRoot, storageRoot, dataRoot, profileRoot: path.join(dataRoot, 'cloud-user-data'),
    runtimeRoot, nativeRoot: path.join(runtimeRoot, 'native'),
    opencodeExecutable: path.join(runtimeRoot, 'opencode', '1.18.17', 'opencode.exe'),
    pilotRoot: path.join(dataRoot, 'agent-engine-pilot')});
}

let configured: RuntimePaths | undefined;
/** Startup sets this once before any capability/store is created; it cannot swap roots later. */
export function configureRuntimePaths(options: Readonly<{installationRoot: string; storageRoot: string}>): RuntimePaths {
  const next = createRuntimePaths(options);
  if (configured && (configured.installationRoot !== next.installationRoot || configured.storageRoot !== next.storageRoot)) throw Error('RUNTIME_PATH_ALREADY_CONFIGURED');
  return configured ??= next;
}

/** The source/test fallback is the caller's checkout, never a previous installation. */
export function runtimePaths(): RuntimePaths {
  return configured ?? createRuntimePaths({installationRoot: path.resolve(process.cwd()), storageRoot: path.resolve(process.cwd())});
}
