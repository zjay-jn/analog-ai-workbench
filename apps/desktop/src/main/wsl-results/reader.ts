/** Reviewed, immutable Python 3.9+ program. Model input is JSON data in one base64 argv. */
export const WSL_RESULTS_READER = String.raw`import os, sys, stat, json, base64, hashlib, re, pwd, signal
signal.alarm(8)
VERSION = 'aaw.wsl-results.v1'
MAX_FILE, MAX_PATH, MAX_CANDIDATES = 4194304, 1024, 2000
class Denied(Exception):
    pass
def fail(code):
    raise Denied(code)
def exact(v, keys):
    if not isinstance(v, dict) or set(v) != set(keys): fail('INVALID_REQUEST')
def clean_path(p, empty=False):
    if not isinstance(p, str) or len(p.encode('utf-8')) > MAX_PATH: fail('UNSUPPORTED_PATH')
    if p == '' and empty: return []
    parts = p.split('/')
    if any(not x or x in ('.', '..') or x.startswith('.') or '\\' in x or len(x.encode('utf-8')) > 255 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in x) for x in parts): fail('UNSUPPORTED_PATH')
    return parts
def sensitive(name):
    return bool(re.search(r'(^|[._ -])(model[s]?|pdk|license[s]?|credential[s]?|secret[s]?|password[s]?|passwd|token[s]?|api|auth|oauth|key[s]?|api[_-]?key|private[_-]?key|config|configuration|settings|netlist|input)([._ -]|$)', name, re.I)) or name.lower() in ('cds.lib', 'hdl.var', 'runsimulation', 'master.tag', 'sch.oa', 'id_rsa', 'id_ed25519')
def allowed_parts(parts):
    if any(sensitive(x) for x in parts): fail('CAPABILITY_DENIED')
def identity(st):
    return str(st.st_dev) + ':' + str(st.st_ino)
def version(st):
    return identity(st) + ':' + str(st.st_size) + ':' + str(st.st_mtime_ns) + ':' + str(st.st_ctime_ns)
FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
def walk(parts, directory):
    fd = os.open('/', FLAGS | os.O_DIRECTORY)
    try:
        for index, part in enumerate(parts):
            child = os.open(part, FLAGS | (os.O_DIRECTORY if directory or index < len(parts) - 1 else 0), dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise
def relative(root_fd, parts, directory):
    fd = os.dup(root_fd)
    try:
        for index, part in enumerate(parts):
            child = os.open(part, FLAGS | (os.O_DIRECTORY if directory or index < len(parts) - 1 else 0), dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise
def check_root(parts, expected):
    fd = walk(parts, True)
    try:
        if identity(os.fstat(fd)) != expected: fail('ROOT_CHANGED')
    finally: os.close(fd)
def classify(name, parts, st):
    if stat.S_ISDIR(st.st_mode): return 'directory'
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1: return None
    ext = os.path.splitext(name)[1].lower()
    if ext in ('.txt', '.csv', '.tsv', '.json', '.log', '.out', '.rpt', '.md'): return 'file_limit' if st.st_size > MAX_FILE else 'text_result'
    if ext in ('.psf', '.psfxl', '.ac', '.tran', '.dc', '.noise', '.sst', '.bin') or any(p.lower() in ('psf', 'psfxl') for p in parts): return 'binary_result'
    return 'unsupported'
def integer(v, low, high):
    return isinstance(v, int) and not isinstance(v, bool) and low <= v <= high
def run():
    if len(sys.argv) != 2 or len(sys.argv[1]) > 12000 or not re.fullmatch(r'[A-Za-z0-9+/]*={0,2}', sys.argv[1]): fail('INVALID_REQUEST')
    request = json.loads(base64.b64decode(sys.argv[1], validate=True).decode('utf-8'))
    exact(request, ['readerVersion', 'distro', 'user', 'rootPath', 'rootIdentity', 'operation', 'arguments'])
    if request['readerVersion'] != VERSION or request['distro'] != 'ROCKY9_LLM_LAB' or request['user'] != 'maxwell' or pwd.getpwuid(os.geteuid()).pw_name != 'maxwell' or os.environ.get('WSL_DISTRO_NAME') != 'ROCKY9_LLM_LAB': fail('CAPABILITY_DENIED')
    root = request['rootPath']
    if not isinstance(root, str) or not re.fullmatch(r'/home/maxwell/(?:simulation/|virtuoso_workspace[A-Za-z0-9_-]*/_codex_runs/)[^/]+(?:/[^/]+)*', root): fail('CAPABILITY_DENIED')
    root_parts = clean_path(root[1:])
    allowed_parts(root_parts)
    root_fd = walk(root_parts, True)
    try:
        root_id = identity(os.fstat(root_fd))
        if request['rootIdentity'] is not None and request['rootIdentity'] != root_id: fail('ROOT_CHANGED')
        op, args = request['operation'], request['arguments']
        if op == 'select':
            exact(args, [])
            if request['rootIdentity'] is not None: fail('INVALID_REQUEST')
            check_root(root_parts, root_id)
            return {'operation': op, 'rootIdentity': root_id, 'physicalReadBytes': 0, 'scannedCandidates': 0}
        if request['rootIdentity'] is None: fail('INVALID_REQUEST')
        if op == 'list':
            exact(args, ['relativeDirectory', 'nameQuery', 'afterName', 'directoryVersion'])
            parts = clean_path(args['relativeDirectory'], True)
            allowed_parts(parts)
            if not isinstance(args['nameQuery'], str) or len(args['nameQuery'].encode('utf-8')) > 128: fail('INVALID_REQUEST')
            if args['afterName'] is not None: clean_path(args['afterName'])
            fd = relative(root_fd, parts, True)
            try:
                before = os.fstat(fd)
                dv = version(before)
                if args['directoryVersion'] is not None and args['directoryVersion'] != dv: fail('CURSOR_STALE')
                names, scanned = [], 0
                with os.scandir(fd) as entries:
                    for entry in entries:
                        scanned += 1
                        if scanned > MAX_CANDIDATES: fail('SCOPE_LIMIT')
                        names.append(entry.name)
                names.sort()
                result, more = [], False
                for name in names:
                    if args['afterName'] is not None and name <= args['afterName']: continue
                    if args['nameQuery'] not in name or sensitive(name): continue
                    try: clean_path(name)
                    except (Denied, UnicodeError): continue
                    try: st = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    except OSError: continue
                    readability = classify(name, parts, st)
                    if readability is None: continue
                    if len(result) >= 24:
                        more = True
                        break
                    path = '/'.join(parts + [name])
                    if len(path.encode('utf-8')) > MAX_PATH: continue
                    result.append({'name': name, 'relativePath': path, 'kind': 'directory' if readability == 'directory' else 'file', 'readability': readability, 'bytes': st.st_size, 'version': version(st) if readability == 'text_result' else None})
                if version(os.fstat(fd)) != dv: fail('SOURCE_CHANGED')
                again = relative(root_fd, parts, True)
                try:
                    if version(os.fstat(again)) != dv: fail('SOURCE_CHANGED')
                finally: os.close(again)
                check_root(root_parts, root_id)
                return {'operation': op, 'rootIdentity': root_id, 'directoryVersion': dv, 'entries': result, 'hasMore': more, 'physicalReadBytes': 0, 'scannedCandidates': scanned}
            finally: os.close(fd)
        if op == 'read':
            exact(args, ['relativePath', 'version', 'rawSha256', 'startLine', 'maxLines'])
            parts = clean_path(args['relativePath'])
            allowed_parts(parts)
            if not integer(args['startLine'], 1, 500000) or not integer(args['maxLines'], 1, 200): fail('INVALID_REQUEST')
            fd = relative(root_fd, parts, False)
            try:
                before = os.fstat(fd)
                if classify(parts[-1], parts[:-1], before) != 'text_result': fail('UNSUPPORTED_TEXT')
                fv = version(before)
                if fv != args['version']: fail('SOURCE_CHANGED')
                chunks, length = [], 0
                while length < before.st_size:
                    chunk = os.read(fd, min(65536, before.st_size - length))
                    if not chunk: fail('SOURCE_CHANGED')
                    length += len(chunk)
                    chunks.append(chunk)
                if version(os.fstat(fd)) != fv: fail('SOURCE_CHANGED')
                again = relative(root_fd, parts, False)
                try:
                    if version(os.fstat(again)) != fv: fail('SOURCE_CHANGED')
                finally: os.close(again)
                check_root(root_parts, root_id)
                raw = b''.join(chunks)
                raw_hash = hashlib.sha256(raw).hexdigest()
                if args['rawSha256'] is not None and raw_hash != args['rawSha256']: fail('SOURCE_CHANGED')
                try: text = raw.decode('utf-8')
                except UnicodeError: fail('UNSUPPORTED_ENCODING')
                if any(ord(c) < 32 and c not in '\r\n\t' or 127 <= ord(c) <= 159 for c in text): fail('UNSUPPORTED_TEXT')
                if re.search(r'-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|(?:api[_-]?key|access[_-]?token|password|passwd|secret)[\x22\x27]?\s*[=:]\s*[\x22\x27]?\S{4,}|\bsk-[A-Za-z0-9_-]{20,}', text, re.I): fail('CAPABILITY_DENIED')
                lines = text.splitlines(keepends=True)
                if len(lines) > 500000: fail('FILE_LIMIT')
                start = args['startLine']
                if start > max(1, len(lines)): fail('INVALID_REQUEST')
                page, page_bytes = [], 0
                for line in lines[start - 1:start - 1 + args['maxLines']]:
                    count = len(line.encode('utf-8'))
                    if count > 4096 and not page: fail('FILE_LIMIT')
                    if page_bytes + count > 4096: break
                    page.append(line)
                    page_bytes += count
                excerpt = ''.join(page)
                end = start - 1 + len(page)
                return {'operation': op, 'rootIdentity': root_id, 'fileIdentity': identity(before), 'version': fv, 'rawSha256': raw_hash, 'excerptSha256': hashlib.sha256(excerpt.encode('utf-8')).hexdigest(), 'startLine': start, 'endLine': end, 'totalLines': len(lines), 'fileBytes': len(raw), 'text': excerpt, 'nextLine': end + 1 if end < len(lines) else None, 'physicalReadBytes': length, 'scannedCandidates': 1}
            finally: os.close(fd)
        fail('INVALID_REQUEST')
    finally: os.close(root_fd)
try:
    response = {'ok': True, 'readerVersion': VERSION, 'value': run()}
except Denied as error:
    response = {'ok': False, 'readerVersion': VERSION, 'error': str(error)}
except (ValueError, TypeError, KeyError, UnicodeError):
    response = {'ok': False, 'readerVersion': VERSION, 'error': 'INVALID_REQUEST'}
except OSError:
    response = {'ok': False, 'readerVersion': VERSION, 'error': 'FILE_UNAVAILABLE'}
sys.stdout.write(json.dumps(response, ensure_ascii=True, separators=(',', ':')))
`;
