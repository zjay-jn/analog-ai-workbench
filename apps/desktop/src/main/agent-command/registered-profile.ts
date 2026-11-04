import path from 'node:path';
import {isCommandEnvironment} from '../../shared/agent/agent-command-validation';
import {nativePinned, type NativeFilePin} from './native-files';
import {createWindowsCommandDriver} from './windows-driver';
import type {CommandDriver} from './types';
import {runtimePaths} from '../runtime-paths';
import {runtimeComponent, type RuntimeComponentId} from '../runtime-manifest';

/** Only this installation's verified native test admission grants execution. */
export function registeredCommandDrivers(): readonly CommandDriver[] {
  try {
    const proof = runtimeComponent('commandAdmission');
    const admission = JSON.parse(nativePinned(proof, 512*1024).toString('utf8'));
    if (admission.schema !== 'aaw.command.runtime-admission.v1' || admission.status !== 'SCOPED_NATIVE_READY_FOR_INTEGRATION'
      || !isCommandEnvironment(admission.environment) || admission.environment.platform !== 'windows'
      || admission.environment.availability !== 'ready' || admission.environment.isolation !== 'windows-appcontainer-job') return [];
    const checked = (ref: NativeFilePin, id: RuntimeComponentId): NativeFilePin => {
      const expected = runtimeComponent(id);
      if (!ref || path.resolve(runtimePaths().installationRoot, ref.path) !== expected.path || ref.bytes !== expected.bytes || ref.sha256 !== expected.sha256) throw Error('RUNTIME_BINDING_CHANGED');
      return expected;
    };
    return [createWindowsCommandDriver({environment: admission.environment, proof,
      native: checked(admission.native, 'commandRunner'), node: checked(admission.runtime.node, 'node'),
      license: checked(admission.runtime.license, 'nodeLicense'), bootstrap: checked(admission.runtime.bootstrap, 'commandBootstrap')})];
  } catch {return [];}
}
