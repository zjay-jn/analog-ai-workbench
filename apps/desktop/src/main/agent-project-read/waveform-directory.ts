import fs from 'node:fs';
import path from 'node:path';
import { ProjectReadFsError } from '../cloud/project-read-files';

/** Converter cwd/HOME/TMPDIR is an empty dedicated directory, never the application data root. */
export function prepareWaveformReaderDirectory(productRoot: string, dataRoot: string): string {
  const fail = (): never => { throw new ProjectReadFsError('ROOT_UNAVAILABLE'); };
  const product = path.resolve(productRoot), data = path.resolve(dataRoot), relative = path.relative(product, data);
  if (product !== productRoot || data !== dataRoot || !relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return fail();
  const verify = (directory: string) => {
    const stat = fs.lstatSync(directory, {bigint:true});
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, fs.realpathSync.native(directory)) !== '') return fail();
    return {dev:stat.dev,ino:stat.ino};
  };
  try {
    const chain = [product]; let cursor = product;
    for (const segment of relative.split(path.sep)) { cursor = path.join(cursor, segment); chain.push(cursor); }
    const before = chain.map(verify), directory = path.join(data, 'waveform-reader');
    try { fs.mkdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const child = verify(directory);
    if (fs.readdirSync(directory).length) return fail();
    chain.forEach((item, index) => { const now = verify(item), old = before[index]!; if (now.dev !== old.dev || now.ino !== old.ino) fail(); });
    const after = verify(directory); if (after.dev !== child.dev || after.ino !== child.ino) return fail();
    return directory;
  } catch { return fail(); }
}
