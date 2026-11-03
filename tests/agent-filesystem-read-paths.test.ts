import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  resolveFilesystemPath, inspectFilesystemPath, captureFilesystemRoot,
  filesystemReadPartAllowed, filesystemTextNameAllowed,
} from '../apps/desktop/src/main/cloud/filesystem-read-sources';
import { ProjectReadFsError } from '../apps/desktop/src/main/cloud/project-read-files';

const base = 'C:\\work\\analog_ai_workbench\\.local\\filesystem-path-memory-fixture';
const isCode = (code: string, osCode?: string) => (error: unknown): boolean =>
  error instanceof ProjectReadFsError && error.code === code
  && (error as ProjectReadFsError & { osCode?: string }).osCode === osCode;
type Kind = 'file' | 'directory' | 'link' | 'device';
type Row = { kind: Kind; ino?: bigint; nlink?: bigint; real?: string; error?: string };
function memory(t: TestContext, rows: Record<string, Row> = {}) {
  const accesses: string[] = [], realpaths: string[] = [];
  const lookup = (value: fs.PathLike): Row => rows[String(value)] ?? { kind: 'directory' };
  t.mock.method(fs, 'lstatSync', ((value: fs.PathLike, options: unknown) => {
    assert.deepEqual(options, { bigint: true });
    const target = String(value); accesses.push(target); const row = lookup(value);
    if (row.error) throw Object.assign(new Error('raw private OS detail must never escape'), { code: row.error });
    return {
      dev: 1n, ino: row.ino ?? BigInt(target.length), nlink: row.nlink ?? 1n,
      size: 7n, mtimeNs: 1n, ctimeNs: 2n,
      isDirectory: () => row.kind === 'directory', isFile: () => row.kind === 'file',
      isSymbolicLink: () => row.kind === 'link',
    } as fs.BigIntStats;
  }) as typeof fs.lstatSync);
  t.mock.method(fs.realpathSync, 'native', ((value: fs.PathLike) => {
    realpaths.push(String(value)); return lookup(value).real ?? String(value);
  }) as typeof fs.realpathSync.native);
  t.mock.method(fs, 'openSync', (() => assert.fail('path capture must never open content')) as typeof fs.openSync);
  t.mock.method(fs, 'opendirSync', (() => assert.fail('direct file must not enumerate its parent')) as typeof fs.opendirSync);
  t.mock.method(fs, 'readdirSync', (() => assert.fail('path capture must never enumerate')) as typeof fs.readdirSync);
  return { accesses, realpaths, rows };
}

test('filesystem path: absolute and relative paths normalize independently of binding', () => {
  assert.equal(resolveFilesystemPath('c:/notes/./draft/../summary.log', null), 'C:\\notes\\summary.log');
  assert.equal(resolveFilesystemPath('../source-B/readme.txt', 'C:\\synthetic\\project-A'), 'C:\\synthetic\\source-B\\readme.txt');
  assert.equal(resolveFilesystemPath('.\\notes.txt', 'd:/ordinary'), 'D:\\ordinary\\notes.txt');
  assert.equal(resolveFilesystemPath('C:/', null), 'C:\\');
  assert.equal(resolveFilesystemPath('C:\\notes.txt', null), 'C:\\notes.txt');
  assert.equal(resolveFilesystemPath('C:\\资料\\😀.txt', null), 'C:\\资料\\😀.txt');
  assert.equal(resolveFilesystemPath('C:\\ordinary\\..\\notes.txt', null), 'C:\\notes.txt');
});
test('filesystem path: no cwd gives an explicit error only for relative paths', () => {
  assert.throws(() => resolveFilesystemPath('notes.txt', null), isCode('CWD_UNAVAILABLE'));
  assert.throws(() => resolveFilesystemPath('../notes.txt', null), isCode('CWD_UNAVAILABLE'));
  assert.equal(resolveFilesystemPath('C:\\notes.txt', null), 'C:\\notes.txt');
});
test('filesystem path: namespaces, ambiguous names and malformed encodings fail lexically', () => {
  for (const value of [
    '\\\\server\\share\\notes.txt', '//server/share/notes.txt', '\\\\?\\C:\\notes.txt',
    '\\\\.\\C:\\notes.txt', '\\??\\C:\\notes.txt', '\\notes.txt', '/notes.txt', 'C:notes.txt', 'C:',
    'C:\\notes.txt:stream', 'C:\\notes.txt::$DATA', 'C:\\NUL.txt', 'C:\\CON', 'C:\\COM¹.log',
    'C:\\LPT9', 'C:\\CONIN$', 'C:\\CONOUT$', 'C:\\notes.\\x.txt', 'C:\\notes \\x.txt',
    'C:\\bad?.txt', 'C:\\bad\u0000.txt', 'C:\\bad\uD800.txt', 'C:\\bad\uDC00.txt',
    'C:\\bad\u202E.txt', 'C:\\bad\u000A.txt', '', 'C:\\' + 'x'.repeat(8200),
  ]) assert.throws(() => resolveFilesystemPath(value, base), isCode('UNSUPPORTED_PATH'), value);
});
test('filesystem policy: ordinary source names do not inherit the old project denylist', () => {
  for (const name of ['models', 'model', 'license', 'licenses', 'node_modules', 'api.ts', 'private', 'AppData', '.config', '.local', '.notes', 'keymap.json', 'private.txt'])
    assert.equal(filesystemReadPartAllowed(name), true, name);
  for (const name of ['analysis.log', 'run.out', 'README', 'LICENSE', '.editorconfig', '.gitignore', '.notes', 'api.ts', 'model.json', 'LICENSE.txt'])
    assert.equal(filesystemTextNameAllowed(name), true, name);
});
test('filesystem policy: explicit credentials and raw EDA categories remain denied', () => {
  for (const name of ['.ssh', '.aws', '.codex', '.env', '.env.local', '.envrc', '.npmrc', '.netrc', '.pypirc',
    'id_rsa', 'id_ed25519', 'client.key', 'client.pem', 'vault.pfx', 'credentials.json', 'secrets.yaml', 'client.credentials.json', 'service.private-key.json', 'api-key.txt',
    'analog_gpt', 'pdk', 'pdks', 'oa', 'psf', 'netlist', 'netlists', 'circuit.scs', 'layout.gds'])
    assert.equal(filesystemReadPartAllowed(name), false, name);
  for (const name of ['image.png', 'archive.zip', 'program.exe', 'data.sqlite', 'model.bin', 'weight.safetensors', 'wave.raw', '.env.example', 'id_rsa.pub'])
    assert.equal(filesystemTextNameAllowed(name), false, name);
});
test('filesystem capture: a drive-root file has a complete chain without listing or opening', t => {
  const file = 'C:\\notes.log', seen = memory(t, { [file]: { kind: 'file', ino: 77n } });
  const value = inspectFilesystemPath(file, 'file');
  assert.equal(value.absolutePath, file);
  assert.deepEqual(value.chain, [{ dev: '1', ino: '3' }, { dev: '1', ino: '77' }]);
  assert.deepEqual(seen.accesses, ['C:\\', file]);
  assert.deepEqual(seen.realpaths, ['C:\\', file]);
});
test('filesystem capture: drive root is a valid parent; repeated captures carry current identity', t => {
  const rows: Record<string, Row> = { [base]: { kind: 'directory', ino: 21n } };
  const seen = memory(t, rows);
  assert.deepEqual(captureFilesystemRoot('C:\\'), { root: 'C:\\', chain: [{ dev: '1', ino: '3' }] });
  const first = captureFilesystemRoot(base); rows[base]!.ino = 22n;
  assert.notDeepEqual(captureFilesystemRoot(base).chain, first.chain);
  assert.ok(seen.accesses.every(p => p === 'C:\\' || base.startsWith(p)));
});
test('filesystem capture: exact protected roots block private sources before any I/O', t => {
  const seen = memory(t), protectedRoot = base + '\\actual-private';
  for (const value of [protectedRoot, protectedRoot + '\\record.json', protectedRoot.toUpperCase() + '\\record.json'])
    assert.throws(() => inspectFilesystemPath(value, 'either', [protectedRoot]), isCode('PATH_POLICY_DENIED'));
  assert.equal(seen.accesses.length, 0);
  const sibling = base + '\\actual-private-copy\\notes.txt';
  seen.rows[sibling] = { kind: 'file' };
  assert.equal(inspectFilesystemPath(sibling, 'file', [protectedRoot]).absolutePath, sibling);
});
test('filesystem capture: ordinary AppData/local/config ancestors and same-name folders stay readable', t => {
  const file = base + '\\AppData\\.local\\.config\\model-settings\\notes.txt';
  memory(t, { [file]: { kind: 'file' } });
  assert.equal(inspectFilesystemPath(file, 'file', [base + '\\actual-store']).absolutePath, file);
});
test('filesystem capture: sensitive targets and ancestors are rejected before any I/O', t => {
  const seen = memory(t);
  for (const file of [base + '\\.ssh\\notes.txt', base + '\\.env', base + '\\client.pem', base + '\\analog_gpt\\notes.txt'])
    assert.throws(() => inspectFilesystemPath(file, 'either'), isCode('PATH_POLICY_DENIED'));
  assert.equal(seen.accesses.length, 0);
});
test('filesystem capture: symlinks, junctions, hardlinks and alternate real paths are policy failures', t => {
  const file = base + '\\notes.txt', seen = memory(t, { [file]: { kind: 'link' } });
  assert.throws(() => inspectFilesystemPath(file, 'file'), isCode('PATH_POLICY_DENIED'));
  seen.rows[file] = { kind: 'file', nlink: 2n };
  assert.throws(() => inspectFilesystemPath(file, 'file'), isCode('PATH_POLICY_DENIED'));
  seen.rows[file] = { kind: 'file', real: base + '\\other.txt' };
  assert.throws(() => inspectFilesystemPath(file, 'file'), isCode('PATH_POLICY_DENIED'));
  seen.rows[file] = { kind: 'file' }; seen.rows[base] = { kind: 'link' };
  assert.throws(() => inspectFilesystemPath(file, 'file'), isCode('PATH_POLICY_DENIED'));
});
test('filesystem capture: final and intermediate type mismatches are explicit', t => {
  const file = base + '\\notes.txt', seen = memory(t, { [file]: { kind: 'directory' } });
  assert.throws(() => inspectFilesystemPath(file, 'file'), isCode('NOT_A_FILE'));
  seen.rows[file] = { kind: 'file' };
  assert.throws(() => inspectFilesystemPath(file, 'directory'), isCode('NOT_A_DIRECTORY'));
  assert.throws(() => inspectFilesystemPath(file + '\\child.txt', 'file'), isCode('NOT_A_DIRECTORY'));
  seen.rows[file] = { kind: 'device' };
  assert.throws(() => inspectFilesystemPath(file, 'either'), isCode('PATH_POLICY_DENIED'));
});
test('filesystem capture: actual OS errors preserve only safe classifications and code', t => {
  const file = base + '\\notes.txt', seen = memory(t);
  for (const [osCode, code] of [
    ['ENOENT', 'PATH_NOT_FOUND'], ['EACCES', 'ACCESS_DENIED'], ['EPERM', 'ACCESS_DENIED'],
    ['ENOTDIR', 'NOT_A_DIRECTORY'], ['EISDIR', 'NOT_A_FILE'], ['EBUSY', 'IO_ERROR'], ['EIO', 'IO_ERROR'],
  ] as const) {
    seen.rows[file] = { kind: 'file', error: osCode };
    assert.throws(() => inspectFilesystemPath(file, 'file'), error => {
      assert.ok(isCode(code, osCode)(error));
      assert.equal((error as Error).message, code);
      assert.equal('path' in (error as object), false);
      return true;
    });
  }
  seen.rows[file] = { kind: 'file', error: 'UNTRUSTED_OS_CODE' };
  assert.throws(() => inspectFilesystemPath(file, 'file'), isCode('IO_ERROR'));
});
test('filesystem capture: realpath errors use the same OS classification', t => {
  memory(t);
  t.mock.method(fs.realpathSync, 'native', (() => { throw Object.assign(Error('raw private path'), { code: 'EACCES' }); }) as typeof fs.realpathSync.native);
  assert.throws(() => captureFilesystemRoot(base), isCode('ACCESS_DENIED', 'EACCES'));
});
