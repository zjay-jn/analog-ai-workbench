import fs from 'node:fs';
import path from 'node:path';
import type { FolderIdentity } from './project-folder-files';
import { ProjectReadFsError } from './project-read-files';
import type { ProjectReadCode } from '../../shared/agent/agent-project-read';

export type FileSystemReadRoot = { root: string; chain: FolderIdentity[] };
const windows = path.win32;
const osCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EBUSY', 'EIO']);
const malformed = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF\p{Bidi_Control}]/u;
const reserved = /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:[ .]|$)/iu;
const privateNames = new Set([
  '.git', '.hg', '.svn', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.codex', '.agents',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', '_netrc', '.pypirc', '.git-credentials',
  '.envrc', 'authorized_keys', 'known_hosts',
]);
const rawEdaNames = new Set(['analog_gpt', 'pdk', 'pdks', 'oa', 'psf', 'netlist', 'netlists']);
const credentialFile = /^(?:\.env(?:$|[._-])|id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[.]))/iu;
const credentialWords = /(?:^|[._-])(?:secrets?|credentials?|passwords?|api[_-]?keys?|access[_-]?keys?|private[_-]?keys?)(?:$|[._-])/iu;
const keyExtension = /\.(?:key|pem|p12|pfx|ppk|jks|keystore|kdbx)$/iu;
const rawEdaExtension = /\.(?:oa|gds|gdsii|oas|psf|raw|scs|sp|spi|spice|ckt|cdl|spef|dspf|sdf|sdb|vams|va)$/iu;
const binaryExtension = /\.(?:exe|dll|sys|com|msi|bin|dat|db|sqlite|sqlite3|db3|zip|7z|rar|gz|bz2|xz|tar|tgz|pdf|doc|docx|xls|xlsx|ppt|pptx|png|jpg|jpeg|gif|bmp|ico|webp|tif|tiff|mp3|mp4|wav|avi|mov|woff2?|ttf|otf|eot|so|dylib|a|lib|o|obj|class|jar|pyc|pyo|wasm|safetensors|pt|pth|onnx|h5|hdf5|npy|npz|gguf|ggml|crt|cer|der)$/iu;
const textExtensions = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.out', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.yaml', '.yml', '.toml', '.xml', '.ini', '.conf', '.cfg', '.config', '.properties',
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py', '.pyi', '.ps1', '.sh',
  '.bash', '.zsh', '.fish', '.bat', '.cmd', '.c', '.h', '.cc', '.hh', '.cpp', '.hpp', '.cxx',
  '.cs', '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xhtml', '.svg', '.rs', '.go',
  '.java', '.kt', '.kts', '.swift', '.rb', '.php', '.pl', '.r', '.jl', '.lua', '.sql', '.tex',
  '.mk', '.cmake', '.diff', '.patch', '.ipynb',
]);
const plainNames = new Set(['readme', 'license', 'licence', 'notice', 'changelog', 'authors', 'contributors', 'contributing', 'codeowners', 'makefile', 'gnumakefile', 'dockerfile', 'gemfile', 'rakefile']);

function fail(code: ProjectReadCode, osCode?: string): never { throw new ProjectReadFsError(code, osCode); }
function validPart(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && name !== '.' && name !== '..' && !/[\\/:*?"<>|]/u.test(name) && !malformed.test(name)
    && !/[. ]$/u.test(name) && !reserved.test(name);
}
/** Read-only name policy; it is deliberately not shared with work-copy/import/write admission. */
export function filesystemReadPartAllowed(name: string): boolean {
  return validPart(name) && !privateNames.has(name.toLowerCase()) && !rawEdaNames.has(name.toLowerCase())
    && !credentialFile.test(name) && !credentialWords.test(name) && !keyExtension.test(name) && !rawEdaExtension.test(name);
}
/** A name is only a candidate: the bounded reader must still validate UTF-8 and text bytes. */
export function filesystemTextNameAllowed(name: string): boolean {
  if (!filesystemReadPartAllowed(name) || binaryExtension.test(name)) return false;
  const lower = name.toLowerCase();
  return textExtensions.has(windows.extname(lower)) || plainNames.has(lower)
    || lower.startsWith('.') && lower.indexOf('.', 1) === -1;
}

/** Pure lexical resolution. Relative input never consults process.cwd() or a drive's hidden cwd. */
export function resolveFilesystemPath(value: string, cwd: string | null): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 8192 || malformed.test(value)) fail('UNSUPPORTED_PATH');
  const input = value.replaceAll('/', '\\');
  if (input.startsWith('\\')) fail('UNSUPPORTED_PATH');
  const absolute = /^[a-z]:\\/iu.test(input);
  if (/^[a-z]:/iu.test(input) && !absolute || input.slice(absolute ? 2 : 0).includes(':')) fail('UNSUPPORTED_PATH');
  const parts = input.slice(absolute ? 3 : 0).split('\\');
  if (parts.some(part => part !== '' && part !== '.' && part !== '..' && !validPart(part))) fail('UNSUPPORTED_PATH');
  let resolved: string;
  if (absolute) resolved = windows.normalize(input);
  else {
    if (cwd === null) fail('CWD_UNAVAILABLE');
    if (typeof cwd !== 'string' || !/^[a-z]:[\\/]/iu.test(cwd)) fail('CWD_UNAVAILABLE');
    resolved = windows.resolve(resolveFilesystemPath(cwd, null), input);
  }
  const driveRoot = windows.parse(resolved).root;
  resolved = resolved.length === driveRoot.length ? driveRoot : resolved.replace(/\\+$/u, '');
  if (Buffer.byteLength(resolved, 'utf8') > 8192) fail('UNSUPPORTED_PATH');
  return resolved[0]!.toUpperCase() + resolved.slice(1);
}

function checkPolicy(absolutePath: string, protectedRoots: readonly string[]): void {
  const drive = windows.parse(absolutePath).root;
  if (absolutePath.slice(drive.length).split('\\').some(part => part && !filesystemReadPartAllowed(part))) fail('PATH_POLICY_DENIED');
  for (const value of protectedRoots) {
    const protectedRoot = resolveFilesystemPath(value, null), relative = windows.relative(protectedRoot, absolutePath);
    if (!relative || relative !== '..' && !relative.startsWith('..\\') && !windows.isAbsolute(relative)) fail('PATH_POLICY_DENIED');
  }
}
function osFailure(error: unknown): never {
  if (error instanceof ProjectReadFsError) throw error;
  const raw = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
  const osCode = typeof raw === 'string' && osCodes.has(raw) ? raw : undefined;
  const code: ProjectReadCode = osCode === 'ENOENT' ? 'PATH_NOT_FOUND'
    : osCode === 'EACCES' || osCode === 'EPERM' ? 'ACCESS_DENIED'
    : osCode === 'ENOTDIR' ? 'NOT_A_DIRECTORY' : osCode === 'EISDIR' ? 'NOT_A_FILE' : 'IO_ERROR';
  return fail(code, osCode);
}

/** Main-only metadata capture. protectedRoots are actual private storage paths, never IPC input. */
export function inspectFilesystemPath(
  target: string, expected: 'file' | 'directory' | 'either', protectedRoots: readonly string[] = [],
): { absolutePath: string; chain: FolderIdentity[]; stat: fs.BigIntStats } {
  const absolutePath = resolveFilesystemPath(target, null);
  if (process.platform !== 'win32') fail('UNSUPPORTED_PATH');
  checkPolicy(absolutePath, protectedRoots);
  const drive = windows.parse(absolutePath).root;
  const parts = absolutePath.slice(drive.length).split('\\').filter(Boolean);
  const chain: FolderIdentity[] = [];
  let cursor = drive, stat!: fs.BigIntStats;
  try {
    for (let index = 0; index <= parts.length; index++) {
      if (index) cursor = windows.join(cursor, parts[index - 1]!);
      stat = fs.lstatSync(cursor, { bigint: true });
      if (stat.isSymbolicLink()) fail('PATH_POLICY_DENIED');
      if (index < parts.length && !stat.isDirectory()) fail('NOT_A_DIRECTORY');
      if (!stat.isDirectory() && !stat.isFile()) fail('PATH_POLICY_DENIED');
      const real = resolveFilesystemPath(fs.realpathSync.native(cursor), null);
      checkPolicy(real, protectedRoots);
      if (real.toLowerCase() !== cursor.toLowerCase()) fail('PATH_POLICY_DENIED');
      chain.push({ dev: String(stat.dev), ino: String(stat.ino) });
    }
    if (expected === 'directory' && !stat.isDirectory()) fail('NOT_A_DIRECTORY');
    if (expected === 'file' && !stat.isFile()) fail('NOT_A_FILE');
    if (stat.isFile() && stat.nlink !== 1n) fail('PATH_POLICY_DENIED');
    return { absolutePath, chain, stat };
  } catch (error) { return osFailure(error); }
}
export function captureFilesystemRoot(target: string, protectedRoots: readonly string[] = []): FileSystemReadRoot {
  const value = inspectFilesystemPath(target, 'directory', protectedRoots);
  return { root: value.absolutePath, chain: value.chain };
}
