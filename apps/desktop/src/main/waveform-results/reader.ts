/** Fixed Python 3.9 program; the only external program is the pinned, read-only Cadence psf ELF. */
export const WAVEFORM_RESULTS_READER = String.raw`import os, sys, stat, json, base64, hashlib, re, pwd, signal, time, subprocess, selectors, resource, ctypes
VERSION = 'aaw.waveform-results.v1'
EXE = '/opt/eda/cadence/IC251ISR4/tools.lnx86/dfII/bin/64bit/psf'
EXE_SHA = '51fa49791e6e896c30ccb4e237d0966a3762051dad8b115bd7af08419dbd0635'
LIBS = '/opt/eda/cadence/IC251ISR4/tools.lnx86/TPtools/libstdc++6/lib/64bit:/opt/eda/cadence/IC251ISR4/tools.lnx86/lib/64bit'
MAX_FILE, MAX_ASCII, MAX_ERROR = 4194304, 2097152, 131072
FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
child = None
class Denied(Exception): pass
def fail(code): raise Denied(code)
def expired(signum, frame): fail('BUDGET_EXCEEDED' if signum == signal.SIGALRM else 'CANCELLED')
for sig in (signal.SIGALRM, signal.SIGTERM, signal.SIGHUP, signal.SIGINT): signal.signal(sig, expired)
signal.alarm(12)
def exact(v, keys):
    if not isinstance(v, dict) or set(v) != set(keys): fail('INVALID_REQUEST')
def sensitive(name):
    return bool(re.search(r'(^|[._ -])(model[s]?|pdk|license[s]?|credential[s]?|secret[s]?|password[s]?|passwd|token[s]?|api|auth|oauth|key[s]?|api[_-]?key|private[_-]?key|config|configuration|settings|netlist|input)([._ -]|$)', name, re.I)) or name.lower() in ('cds.lib', 'hdl.var', 'runsimulation', 'master.tag', 'sch.oa', 'id_rsa', 'id_ed25519')
def parts(path, hidden=False):
    if not isinstance(path, str) or not path or len(path.encode('utf-8')) > 2048: fail('UNSUPPORTED_PATH')
    result = path.split('/')
    if any(not p or p in ('.','..') or (not hidden and p.startswith('.')) or '\\' in p or len(p.encode('utf-8')) > 255 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in p) for p in result): fail('UNSUPPORTED_PATH')
    return result
def identity(s): return str(s.st_dev) + ':' + str(s.st_ino)
def version(s): return identity(s) + ':' + str(s.st_size) + ':' + str(s.st_mtime_ns) + ':' + str(s.st_ctime_ns)
def walk(items, directory, root=None):
    fd = os.open('/', FLAGS | os.O_DIRECTORY) if root is None else os.dup(root)
    try:
        for i, item in enumerate(items):
            new = os.open(item, FLAGS | (os.O_DIRECTORY if directory or i < len(items)-1 else 0), dir_fd=fd)
            os.close(fd); fd = new
        return fd
    except BaseException:
        os.close(fd); raise
def file_hash(fd, limit):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= limit: fail('FILE_LIMIT')
    os.lseek(fd, 0, os.SEEK_SET); digest = hashlib.sha256(); count = 0; head = b''
    while True:
        chunk = os.read(fd, min(65536, limit-count+1))
        if not chunk: break
        if not head: head = chunk[:64]
        count += len(chunk)
        if count > limit: fail('FILE_LIMIT')
        digest.update(chunk)
    after = os.fstat(fd); os.lseek(fd, 0, os.SEEK_SET)
    if version(before) != version(after) or count != before.st_size: fail('SOURCE_CHANGED')
    return before, digest.hexdigest(), head
def group_gone():
    if child is None: return True
    try: os.killpg(child.pid, 0); return False
    except ProcessLookupError: return True
def cleanup_child():
    if child is None: return
    if child.poll() is None or not group_gone():
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    try: child.wait(timeout=1)
    except subprocess.TimeoutExpired: fail('CLEANUP_FAILED')
    end = time.monotonic() + 0.5
    while not group_gone() and time.monotonic() < end: time.sleep(0.01)
    if not group_gone(): fail('CLEANUP_FAILED')
def converter(file_fd, cwd, cwd_fd):
    global child
    exe_fd = os.open(EXE, FLAGS)
    try:
        exe_stat, digest, _head = file_hash(exe_fd, 67108864)
        if digest != EXE_SHA: fail('CONVERTER_UNAVAILABLE')
        parent = os.getpid()
        def limits():
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent: os._exit(125)
            resource.setrlimit(resource.RLIMIT_CPU, (10,10))
            resource.setrlimit(resource.RLIMIT_AS, (1073741824,1073741824))
            resource.setrlimit(resource.RLIMIT_FSIZE, (0,0))
            resource.setrlimit(resource.RLIMIT_CORE, (0,0))
        env = {'PATH':'/usr/bin:/bin', 'HOME':cwd, 'TMPDIR':cwd, 'LANG':'C', 'LC_ALL':'C', 'LD_LIBRARY_PATH':LIBS}
        child = subprocess.Popen([EXE, '-f', '%.17g', '-i', '/proc/self/fd/'+str(file_fd)], cwd='/proc/self/fd/'+str(cwd_fd), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(file_fd,cwd_fd), start_new_session=True, preexec_fn=limits)
        output, error_size, total = [], 0, 0
        selector = selectors.DefaultSelector()
        for stream in (child.stdout, child.stderr): os.set_blocking(stream.fileno(), False); selector.register(stream, selectors.EVENT_READ)
        deadline = time.monotonic()+10
        try:
            while selector.get_map():
                if time.monotonic() >= deadline: fail('BUDGET_EXCEEDED')
                for key, _events in selector.select(min(0.1, max(0,deadline-time.monotonic()))):
                    chunk = os.read(key.fileobj.fileno(),65536)
                    if not chunk: selector.unregister(key.fileobj); key.fileobj.close(); continue
                    if key.fileobj is child.stdout:
                        total += len(chunk)
                        if total > MAX_ASCII: fail('BUDGET_EXCEEDED')
                        output.append(chunk)
                    else:
                        error_size += len(chunk)
                        if error_size > MAX_ERROR: fail('BUDGET_EXCEEDED')
            try: code = child.wait(timeout=max(0.01,deadline-time.monotonic()))
            except subprocess.TimeoutExpired: fail('BUDGET_EXCEEDED')
            if code != 0: fail('ENGINE_FAILED')
            if not group_gone(): fail('CLEANUP_FAILED')
            if version(os.fstat(exe_fd)) != version(exe_stat) or version(os.stat(EXE,follow_symlinks=False)) != version(exe_stat): fail('CONVERTER_UNAVAILABLE')
            raw = b''.join(output)
            return raw.decode('utf-8','strict'), hashlib.sha256(raw).hexdigest()
        finally:
            selector.close()
            for stream in (child.stdout,child.stderr): stream.close()
    finally: os.close(exe_fd)
def run():
    if len(sys.argv)!=2 or len(sys.argv[1])>12000 or not re.fullmatch(r'[A-Za-z0-9+/]*={0,2}',sys.argv[1]): fail('INVALID_REQUEST')
    req = json.loads(base64.b64decode(sys.argv[1],validate=True).decode('utf-8'))
    exact(req,['readerVersion','binding','relativePath','operation','expectedFile','directory'])
    b = req['binding']; exact(b,['distro','user','rootPath','id','rootIdentity','readerVersion','selectedAt'])
    if req['readerVersion']!=VERSION or b['readerVersion']!='aaw.wsl-results.v1' or b['distro']!='ROCKY9_LLM_LAB' or b['user']!='maxwell' or pwd.getpwuid(os.geteuid()).pw_name!='maxwell' or os.environ.get('WSL_DISTRO_NAME')!='ROCKY9_LLM_LAB': fail('CAPABILITY_DENIED')
    if not isinstance(b['rootPath'],str) or not re.fullmatch(r'/home/maxwell/(?:simulation/|virtuoso_workspace[A-Za-z0-9_-]*/_codex_runs/)[^/]+(?:/[^/]+)*',b['rootPath']): fail('CAPABILITY_DENIED')
    root_parts, rel_parts = parts(b['rootPath'][1:]), parts(req['relativePath'])
    if any(sensitive(p) for p in root_parts+rel_parts): fail('CAPABILITY_DENIED')
    if not req['relativePath'].endswith('.ac'): fail('UNSUPPORTED_FORMAT')
    if req['operation'] not in ('convert','check'): fail('INVALID_REQUEST')
    cwd = req['directory']
    if not isinstance(cwd,str) or not re.fullmatch(r'/mnt/c/work/analog_ai_workbench/\.local(?:/[^/]+)*',cwd): fail('CAPABILITY_DENIED')
    cwd_parts = parts(cwd[1:],True)
    root_fd = walk(root_parts,True); file_fd = None; cwd_fd = None
    try:
        if identity(os.fstat(root_fd))!=b['rootIdentity']: fail('ROOT_CHANGED')
        file_fd = walk(rel_parts,False,root_fd)
        before,digest,head = file_hash(file_fd,MAX_FILE)
        # The observed binary uses length-prefixed, padded version key/value records, not a text magic string.
        if len(head)<40 or head[:4]!=b'\x00\x00\x02\x00' or head[16:30]!=b'\x00\x00\x00\x0aPSFversion' or head[30:36]!=b'\x00\x00\x00\x00\x00\x03' or head[36:39]!=b'1.1': fail('UNSUPPORTED_FORMAT')
        source = {'relativePath':req['relativePath'],'fileIdentity':identity(before),'version':version(before),'bytes':before.st_size,'rawSha256':digest}
        if req['expectedFile'] is not None:
            exact(req['expectedFile'],list(source))
            if source!=req['expectedFile']: fail('SOURCE_CHANGED')
        ascii_text = ascii_sha = converter_result = None
        if req['operation']=='convert':
            cwd_fd = walk(cwd_parts,True); cwd_id=identity(os.fstat(cwd_fd))
            if os.listdir(cwd_fd): fail('CAPABILITY_DENIED')
            ascii_text,ascii_sha=converter(file_fd,cwd,cwd_fd)
            again=walk(cwd_parts,True)
            try:
                if identity(os.fstat(again))!=cwd_id or os.listdir(again): fail('CAPABILITY_DENIED')
            finally: os.close(again)
            converter_result={'exitCode':0,'processGroupGone':True}
        after,after_digest,_head=file_hash(file_fd,MAX_FILE)
        if version(after)!=version(before) or after_digest!=digest: fail('SOURCE_CHANGED')
        again=walk(rel_parts,False,root_fd)
        try:
            if version(os.fstat(again))!=version(before): fail('SOURCE_CHANGED')
        finally: os.close(again)
        again=walk(root_parts,True)
        try:
            if identity(os.fstat(again))!=b['rootIdentity']: fail('ROOT_CHANGED')
        finally: os.close(again)
        return {'operation':req['operation'],'rootIdentity':b['rootIdentity'],'file':source,'ascii':ascii_text,'asciiSha256':ascii_sha,'converter':converter_result,'physicalReadBytes':before.st_size*(3 if req['operation']=='convert' else 2),'scannedCandidates':1}
    finally:
        if cwd_fd is not None: os.close(cwd_fd)
        if file_fd is not None: os.close(file_fd)
        os.close(root_fd)
try:
    result={'ok':True,'readerVersion':VERSION,'value':run()}
except Denied as error: result={'ok':False,'readerVersion':VERSION,'error':str(error)}
except (FileNotFoundError,NotADirectoryError,PermissionError): result={'ok':False,'readerVersion':VERSION,'error':'FILE_UNAVAILABLE'}
except (UnicodeError,ValueError,TypeError,KeyError): result={'ok':False,'readerVersion':VERSION,'error':'INVALID_REQUEST'}
except BaseException: result={'ok':False,'readerVersion':VERSION,'error':'ENGINE_FAILED'}
finally:
    signal.alarm(0)
    try: cleanup_child()
    except BaseException: result={'ok':False,'readerVersion':VERSION,'error':'CLEANUP_FAILED'}
print(json.dumps(result,ensure_ascii=False,separators=(',',':'),allow_nan=False))
`;
