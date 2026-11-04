import path from 'node:path';
import {runtimePaths} from './runtime-paths';
let packagedSystemRoot: string | undefined;
/** Only a current native KnownFolder/system probe may configure packaged child environments. */
export function configurePackagedWindowsRoot(value: string): void {
  if (runtimePaths().mode !== 'packaged' || !/^[a-z]:[\\/]/iu.test(value) || path.resolve(value) !== value || path.dirname(value) === value
    || packagedSystemRoot !== undefined && packagedSystemRoot.toLowerCase() !== value.toLowerCase()) throw Error('SYSTEM_ROOT_UNAVAILABLE');
  packagedSystemRoot ??= value;
}
/** The OS supplies this location; native profiles independently pin the actual system images. */
export function nativeWindowsEnvironment(): Readonly<Record<string, string>> {
  const value = packagedSystemRoot ?? process.env.SystemRoot;
  if (!value || !/^[a-z]:[\\/]/iu.test(value) || path.resolve(value) !== value || path.dirname(value) === value) throw Error('SYSTEM_ROOT_UNAVAILABLE');
  return Object.freeze({SystemRoot: value, windir: value, SystemDrive: path.parse(value).root.slice(0, 2)});
}
