import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {packagedOrdinary, readPackagedFile, type PackagePin} from './packaged-runtime';

export function ensurePackagedDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.dirname(directory) === directory) {packagedOrdinary(directory, true); return;}
  try {packagedOrdinary(directory, true);} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    ensurePackagedDirectory(path.dirname(directory));
    try {fs.mkdirSync(directory);} catch (failure) {if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;}
    packagedOrdinary(directory, true);
  }
}
export function writePackagedJson(file: string, value: unknown): PackagePin {
  const parent = path.dirname(file), before = packagedOrdinary(parent, true), data = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (data.length > 512*1024) throw Error('PACKAGED_STATE_LIMIT');
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor);} finally {fs.closeSync(descriptor);}
  const after = packagedOrdinary(parent, true);
  if (before.dev !== after.dev || before.ino !== after.ino || !readPackagedFile(file, data.length).equals(data)) throw Error('PACKAGED_STATE_CHANGED');
  return {path: file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex')};
}
/** Replace only main's fixed current state; each attempt and its evidence remain intact. */
export function publishPackagedState(file: string, value: unknown): void {
  const parent = path.dirname(file), before = packagedOrdinary(parent, true), pending = path.join(parent, `state-${randomUUID()}.tmp`);
  const expected = writePackagedJson(pending, value);
  try {packagedOrdinary(file);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  fs.renameSync(pending, file);
  const after = packagedOrdinary(parent, true);
  if (before.dev !== after.dev || before.ino !== after.ino || createHash('sha256').update(readPackagedFile(file, expected.bytes)).digest('hex') !== expected.sha256) throw Error('PACKAGED_STATE_CHANGED');
}
