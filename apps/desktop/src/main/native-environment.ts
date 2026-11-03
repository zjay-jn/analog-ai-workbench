import path from 'node:path';
/** The OS supplies this location; native profiles independently pin the actual system images. */
export function nativeWindowsEnvironment(): Readonly<Record<string, string>> {
  const value = process.env.SystemRoot;
  if (!value || !/^[a-z]:[\\/]/iu.test(value) || path.resolve(value) !== value || path.dirname(value) === value) throw Error('SYSTEM_ROOT_UNAVAILABLE');
  return Object.freeze({SystemRoot: value, windir: value, SystemDrive: path.parse(value).root.slice(0, 2)});
}
