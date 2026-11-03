"""Pinned WSL command bridge. Protocol stdin/stdout only; no shell interpolation.

The Python owner stays outside bubblewrap's user/mount/PID namespaces. User code
cannot alter control receipts. PID namespace init exit kills detached descendants.
Network is inherited; this is not Windows AppContainer or a network sandbox.
"""
import base64
import ctypes
import datetime
import errno
import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

MAX_FILES = 32
MAX_FILE = 65536
MAX_OUTPUT = 262144
MAX_LOG = 16777216
MAX_REQUEST = 2000000
ID_RE = re.compile(r"^cmd-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
SHA_RE = re.compile(r"^[a-f0-9]{64}$")
EXPORT_NAME = re.compile(r"\.(md|txt|js|ts|jsx|tsx|py|ps1|sh|c|h|cpp|hpp|css|html|json|yaml|yml|toml|rs|go|java|sql|csv)$", re.I)
SENSITIVE_NAME = re.compile(r"(?:^|[._-])(?:api|secrets?|credentials?|tokens?|private|passwords?)(?:[._-]|$)", re.I)
BOOT = None
WIRE = True
INITIAL_CONTROL = b""


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def emit(kind, **data):
    global WIRE
    if WIRE:
        try:
            sys.stdout.write(json.dumps(dict(type=kind, **data), separators=(",", ":")) + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            WIRE = False


def safe_path(root, relative):
    if not isinstance(relative, str) or not relative or len(relative.encode()) > 240:
        raise ValueError("path")
    parts = relative.split("/")
    if len(parts) > 4 or any(not p or p.startswith(".") or "\\" in p or ":" in p or any(ord(c) < 32 for c in p) for p in parts):
        raise ValueError("path")
    target = os.path.join(root, *parts)
    if os.path.commonpath([root, target]) != root:
        raise ValueError("path")
    return target


def ordinary_path(path, directory=False):
    path = os.path.abspath(path)
    at = "/"
    for part in path.split("/")[1:]:
        at = os.path.join(at, part)
        s = os.lstat(at)
        if stat.S_ISLNK(s.st_mode):
            raise ValueError("symlink")
    s = os.lstat(path)
    if directory:
        if not stat.S_ISDIR(s.st_mode):
            raise ValueError("directory")
    elif not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
        raise ValueError("file")
    return s


def read_file(path, maximum):
    before = ordinary_path(path)
    if before.st_size > maximum:
        raise ValueError("size")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino, opened.st_size) != (before.st_dev, before.st_ino, before.st_size):
            raise ValueError("changed")
        data = b""
        while len(data) <= maximum:
            chunk = os.read(fd, min(65536, maximum + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        after = os.fstat(fd)
        if (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(data) != opened.st_size:
            raise ValueError("changed")
        return data
    finally:
        os.close(fd)


def write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as out:
            out.write(data)
            out.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path, value):
    write_new(path, json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode())
    fd = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        try:
            os.fsync(fd)
        except OSError as error:
            # DrvFS can reject directory fsync. Each ordinary receipt itself was
            # flushed above; the Windows execution/control directory pre-exists.
            if not path.startswith("/mnt/c/work/analog_ai_workbench/.local/agent-command-runner/executions/") or error.errno not in (errno.EINVAL, errno.ENOTSUP):
                raise
    finally:
        os.close(fd)


def proc_identity(pid):
    try:
        raw = open("/proc/%d/stat" % pid).read()
        fields = raw[raw.rfind(")") + 2:].split()
        return {"pid": pid, "ppid": int(fields[1]), "start": fields[19], "namespace": os.readlink("/proc/%d/ns/pid" % pid)}
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            return None
        raise


def outside_nested_namespace(pid):
    """Prove an unreadable namespace link belongs to the outer PID namespace.

    NSpid is relative to the observer's /proc mount. Our target is nested below
    that namespace, so a stable process with one NSpid cannot be a target member.
    UID or permission failure alone never proves exclusion.
    """
    try:
        stat_path = "/proc/%d/stat" % pid
        before = open(stat_path).read()
        status = open("/proc/%d/status" % pid).read()
        after = open(stat_path).read()
        first = before[before.rfind(")") + 2:].split()[19]
        last = after[after.rfind(")") + 2:].split()[19]
        nspid = [line.split()[1:] for line in status.splitlines() if line.startswith("NSpid:")]
        return first == last and nspid == [[str(pid)]]
    except (OSError, ValueError, IndexError):
        return False


def namespace_members(namespace):
    if not namespace:
        return None
    found = []
    try:
        for name in os.listdir("/proc"):
            if name.isdigit():
                try:
                    p = proc_identity(int(name))
                except OSError as error:
                    if error.errno in (errno.EACCES, errno.EPERM) and outside_nested_namespace(int(name)):
                        continue
                    return None
                if p and p["namespace"] == namespace:
                    found.append(p)
    except (OSError, ValueError, IndexError):
        return None
    return found


def new_process_observation(limit):
    if limit is not None and (type(limit) is not int or not 1 <= limit <= 8):
        raise ValueError("process_limit")
    return dict(policy="observe_only" if limit is None else "terminate_above_limit", limit=limit, peakProcesses=None, samples=0)


def observe_processes(observation, members):
    """Keep actual samples even for a legacy threshold fault; unknown is not zero."""
    if members is None:
        return None, False
    count = len(members)
    observation["samples"] += 1
    observation["peakProcesses"] = max(count, observation["peakProcesses"] or 0)
    return count, observation["limit"] is not None and count > observation["limit"]


def consume_control(buffer, identity, stop):
    if len(buffer) > 4096:
        raise ValueError("control")
    while b"\n" in buffer:
        line, buffer = buffer.split(b"\n", 1)
        message = json.loads(line)
        if not isinstance(message, dict) or set(message) != {"type", "identity", "reason"} or message["type"] != "stop" or message["identity"] != identity or message["reason"] not in ["user", "deadline", "log_limit", "shutdown", "model_finished", "storage_failure", "engine_failure"]:
            raise ValueError("control")
        stop(message["reason"])
    return buffer


def reap_children():
    """ECHILD is positive evidence from this dedicated subreaper, not a PID guess."""
    try:
        while True:
            if os.waitpid(-1, os.WNOHANG)[0] == 0:
                return False
    except ChildProcessError:
        return True


def cleanup_proof(spawn_attempted, reaped, children_empty, init, remaining, owner, started, gate_opened):
    method = "unconfirmed"
    if not spawn_attempted and children_empty and started is None and not gate_opened:
        method = "not_spawned"
    elif reaped and children_empty:
        if init and remaining == [] and init["namespace"] != owner["namespace"]:
            method = "namespace_empty"
        elif init is None and started is None and not gate_opened:
            # Only the pinned bwrap/handshake ran. User code never passed the gate.
            # Its reaped monitor and ECHILD together cover even an unobserved init.
            method = "prestart_children_reaped"
    return dict(method=method, spawnAttempted=spawn_attempted, childReaped=reaped,
                subreaperEmpty=children_empty, gateOpened=gate_opened)


def check_request(req):
    identity = req["identity"]
    if req["schema"] != "aaw.command.wsl.request.v1" or not ID_RE.fullmatch(identity["executionId"]):
        raise ValueError("identity")
    if any(not SHA_RE.fullmatch(identity[k]) for k in ["signature", "environmentRevision", "baselineVersion", "scriptSha256"]):
        raise ValueError("identity")
    if not isinstance(identity["nonce"], str) or not re.fullmatch(r"[a-f0-9-]{32,64}", identity["nonce"]):
        raise ValueError("nonce")
    root = req["executionRoot"]
    if not isinstance(root, str) or not root.startswith("/home/maxwell/") or "/../" in root or "/./" in root or root.endswith("/") or os.path.normpath(root) != root:
        raise ValueError("root")
    if req["distribution"] != "ROCKY9_LLM_LAB" or req["user"] != "maxwell" or os.getuid() != 1000 or os.environ.get("WSL_DISTRO_NAME") != "ROCKY9_LLM_LAB":
        raise ValueError("target")
    if req["bubblewrapPath"] != "/usr/bin/bwrap" or req["shellPath"] != "/bin/bash":
        raise ValueError("runtime")
    if req["mode"] not in ["run", "recover"]:
        raise ValueError("mode")
    return os.path.join(root, identity["executionId"])


def export_files(work, control, baseline):
    exported, deleted, skipped, total, seen = [], [], 0, 0, 0
    originals = {f["relativePath"]: f for f in baseline}
    for parent, directories, names in os.walk(work, followlinks=False):
        directories.sort()
        names.sort()
        seen += len(directories) + len(names)
        if seen > 4096:
            raise ValueError("artifact_budget")
        admitted = [d for d in directories if not d.startswith(".") and not os.path.islink(os.path.join(parent, d)) and os.path.relpath(os.path.join(parent, d), work).count(os.sep) < 3]
        skipped += len(directories) - len(admitted)
        directories[:] = admitted
        for name in names:
            relative = os.path.relpath(os.path.join(parent, name), work).replace(os.sep, "/")
            try:
                if len(name) > 120 or not EXPORT_NAME.search(name) or SENSITIVE_NAME.search(name) or any(c in name for c in "\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"):
                    raise ValueError("name")
                target = safe_path(work, relative)
                data = read_file(target, MAX_FILE)
                text = data.decode("utf-8")
                if any(ord(c) < 32 and c not in "\t\n\r" or ord(c) == 127 for c in text):
                    raise ValueError("binary")
                if digest(data) == originals.get(relative, {}).get("version"):
                    continue
                if len(exported) >= 8 or total + len(data) > MAX_OUTPUT:
                    raise ValueError("budget")
                total += len(data)
                version = digest(data)
                write_new(os.path.join(control, "artifact-%d.bin" % len(exported)), data)
                exported.append(dict(relativePath=relative, version=version, bytes=len(data)))
            except (OSError, ValueError, UnicodeError):
                skipped += 1
    for f in baseline:
        if not os.path.lexists(safe_path(work, f["relativePath"])):
            deleted.append(dict(relativePath=f["relativePath"], beforeVersion=f["version"]))
    return exported, deleted, skipped


def recover(req, root):
    control = os.path.join(root, "control")
    try:
        result = json.loads(read_file(os.path.join(control, "result.json"), 524288))
    except FileNotFoundError:
        emit("missing", identity=req["identity"])
        return
    if result["schema"] != "aaw.command.wsl.result.v1" or result["identity"] != req["identity"]:
        raise ValueError("identity")
    for stream in ["stdout", "stderr"]:
        data = read_file(os.path.join(control, stream + ".bin"), MAX_LOG)
        log = result["logs"][stream]
        if len(data) != log["persistedBytes"] or digest(data) != log["sha256"]:
            raise ValueError("log")
        for offset in range(0, len(data), 32768):
            emit("log", identity=req["identity"], stream=stream, offset=offset, data=base64.b64encode(data[offset:offset+32768]).decode())
    send_artifacts(req, control, result)
    emit("result", result=result)


def send_artifacts(req, control, result):
    for index, f in enumerate(result["exported"]):
        data = read_file(os.path.join(control, "artifact-%d.bin" % index), MAX_FILE)
        if len(data) != f["bytes"] or digest(data) != f["version"]:
            raise ValueError("artifact")
        emit("artifact", identity=req["identity"], relativePath=f["relativePath"], data=base64.b64encode(data).decode())


def run(req, root):
    global WIRE
    for name, executable in [("bash", req["shellPath"]), ("python", sys.executable), ("bubblewrap", req["bubblewrapPath"])]:
        if digest(read_file(os.path.realpath(executable), 16777216)) != req["runtimeSha256"][name]:
            raise ValueError("runtime_changed")
    observation = new_process_observation(req["processLimit"])
    if type(req["logBytes"]) is not int or not 1 <= req["logBytes"] <= MAX_LOG:
        raise ValueError("limit")
    ordinary_path(req["executionRoot"], True)
    os.mkdir(root, 0o700)
    work, control = os.path.join(root, "work"), os.path.join(root, "control")
    os.mkdir(work, 0o700)
    os.mkdir(control, 0o700)
    host_control = req["hostControl"]
    expected_host = "/mnt/c/work/analog_ai_workbench/.local/agent-command-runner/executions/" + req["identity"]["executionId"] + "/control"
    if host_control != expected_host:
        raise ValueError("host_control")
    ordinary_path(host_control, True)
    write_json(os.path.join(control, "intent.json"), req)
    identity = req["identity"]
    baseline = req["baseline"]
    if len(baseline) > MAX_FILES:
        raise ValueError("baseline")
    total, names = 0, set()
    for f in baseline:
        target = safe_path(work, f["relativePath"])
        data = base64.b64decode(f["data"], validate=True)
        if len(data) != f["bytes"] or len(data) > MAX_FILE or digest(data) != f["version"] or f["relativePath"].lower() in names:
            raise ValueError("baseline")
        names.add(f["relativePath"].lower())
        total += len(data)
        if total > 1048576:
            raise ValueError("baseline")
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        write_new(target, data)
    script = req["commandText"].encode("utf-8")
    if not script or len(script) > 8192 or digest(script) != identity["scriptSha256"]:
        raise ValueError("script")
    script_path = os.path.join(control, "command.sh")
    write_new(script_path, script)
    cwd = safe_path(work, req["cwdRelativePath"]) if req["cwdRelativePath"] else work
    ordinary_path(cwd, True)
    if not isinstance(req["timeoutMs"], int) or not 1 <= req["timeoutMs"] <= 600000:
        raise ValueError("deadline")
    # PR_SET_CHILD_SUBREAPER: adopted bwrap descendants are reaped before receipt.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError("subreaper")
    info_read, info_write = os.pipe()
    gate_path = os.path.join(control, "start.fifo")
    os.mkfifo(gate_path, 0o600)
    gate = os.open(gate_path, os.O_RDWR | os.O_NONBLOCK)
    argv = [req["bubblewrapPath"], "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--info-fd", str(info_write)]
    # Empty filesystem root: no host /home, /mnt drives, /run/WSL or owner receipts.
    for system in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]:
        if os.path.isdir(system):
            argv += ["--ro-bind", system, system]
    for private in ["/home", "/mnt", "/media", "/root", "/run", "/tmp", "/var/tmp"]:
        argv += ["--tmpfs", private]
    for source in req["sourceRoots"]:
        src = source["path"]
        if source["access"] != "read_only" or source["enforcement"] != "os_read_only" or src in ["/", "/home", "/home/maxwell", "/mnt", "/proc", "/dev", "/run", "/tmp"] or os.path.normpath(src) != src or not src.startswith("/") or os.path.commonpath([src, root]) == src:
            raise ValueError("source")
        ordinary_path(src, True)
        argv += ["--ro-bind", src, src]
    argv += ["--bind", work, work, "--ro-bind", script_path, "/run/aaw-command.sh", "--ro-bind", gate_path, "/run/aaw-start", "--proc", "/proc", "--dev", "/dev", "--chdir", cwd, "--clearenv"]
    for key, value in {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/maxwell", "USER": "maxwell", "LOGNAME": "maxwell", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TMPDIR": "/tmp", "AAW_WORK_DIRECTORY": work, "AAW_EXECUTION_ID": identity["executionId"]}.items():
        argv += ["--setenv", key, value]
    # The exact namespace identity is pinned before user code can run or exit.
    argv += [req["shellPath"], "--noprofile", "--norc", "-c", 'printf "AAW_READY:%s:%s\\n" "$1" "$(pwd -P)"; IFS= read -r gate </run/aaw-start && test "$gate" = start && exec /bin/bash --noprofile --norc /run/aaw-command.sh', "aaw-handshake", identity["nonce"]]
    logs = {s: {"observedBytes": 0, "persistedBytes": 0, "sha256": "", "eof": False, "coverage": "incomplete"} for s in ["stdout", "stderr"]}
    files = {s: open(os.path.join(control, s + ".bin"), "xb", buffering=0) for s in logs}
    host_files = {s: open(os.path.join(host_control, "wsl-" + s + ".bin"), "xb", buffering=0) for s in logs}
    hashes = {s: hashlib.sha256() for s in logs}
    owner = proc_identity(os.getpid())
    started, termination, fault, init = None, "exited", None, None
    process = None
    spawn_attempted, gate_opened = False, False
    selector = selectors.DefaultSelector()
    info = b""
    stop_at = None
    deadline = time.monotonic() + req["timeoutMs"] / 1000
    control_bytes = INITIAL_CONTROL
    last_process_check = 0
    last_members = None
    ready_bytes = b""
    cwd_ready = False
    def activate():
        nonlocal started, gate_opened
        if init and cwd_ready and started is None and stop_at is None and WIRE and time.monotonic() < deadline:
            if init["namespace"] == owner["namespace"]:
                raise OSError("namespace")
            proof = dict(identity=identity, supervisorPid=os.getpid(), supervisorStartTicks=owner["start"], namespacePid=init["pid"], namespaceStartTicks=init["start"], namespaceInode=init["namespace"])
            write_json(os.path.join(control, "namespace.json"), proof)
            write_json(os.path.join(host_control, "wsl-namespace.json"), proof)
            started = now()
            emit("started", identity=identity, startedAt=started, runtime=dict(platform="wsl", distribution=req["distribution"], user=req["user"], cwd=cwd, workDirectory=work, baselineDirectory=None))
            os.write(gate, b"start\n")
            gate_opened = True
    def stop(reason):
        nonlocal stop_at, termination
        if stop_at is None:
            stop_at = time.monotonic()
            termination = "timed_out" if reason == "deadline" else "log_limit" if reason == "log_limit" else "fault" if reason == "fault" else "stopped"
            if process:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
    # A Windows relay can deliver HUP/TERM as well as pipe EOF. Preserve the
    # bounded namespace cleanup and durable local mirror on either path.
    for shutdown_signal in [signal.SIGHUP, signal.SIGTERM, signal.SIGINT]:
        signal.signal(shutdown_signal, lambda _signal, _frame: stop("shutdown"))
    try:
        # A stop may share the initial request read or already be waiting in stdin.
        # Consume it before creating any child; a queued stop must never launch bwrap.
        os.set_blocking(0, False)
        control_bytes = consume_control(control_bytes, identity, stop)
        while True:
            try:
                pending_control = os.read(0, 4096)
            except BlockingIOError:
                break
            if not pending_control:
                stop("shutdown")
                break
            control_bytes = consume_control(control_bytes + pending_control, identity, stop)
        if time.monotonic() >= deadline:
            stop("deadline")
        if not WIRE:
            stop("shutdown")
        if stop_at is None:
            spawn_attempted = True
            process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True, pass_fds=(info_write,), start_new_session=True)
        os.close(info_write)
        info_write = -1
        for stream in logs if process else []:
            fd = getattr(process, stream).fileno()
            os.set_blocking(fd, False)
            selector.register(fd, selectors.EVENT_READ, stream)
        os.set_blocking(info_read, False)
        selector.register(info_read, selectors.EVENT_READ, "info")
        os.set_blocking(0, False)
        selector.register(0, selectors.EVENT_READ, "control")
        while process is not None:
            current = time.monotonic()
            control_bytes = consume_control(control_bytes, identity, stop)
            if init and current - last_process_check >= 0.25:
                last_process_check = current
                members = namespace_members(init["namespace"])
                count, exceeded = observe_processes(observation, members)
                if started and count != last_members:
                    last_members = count
                    emit("job", identity=identity, job=dict(activeProcesses=None if exceeded else count, emptyConfirmed=False, observedAt=now()))
                if exceeded:
                    fault = dict(code="WSL_PROCESS_LIMIT", stage="run", nativeCode=None)
                    stop("fault")
            if current >= deadline:
                stop("deadline")
            if not WIRE:
                stop("shutdown")
            if stop_at is not None and current - stop_at >= 0.75 and process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if stop_at is not None and current - stop_at >= 5:
                break
            events = selector.select(0.05)
            # Cancellation observed in the same batch wins over the start gate.
            events.sort(key=lambda item: 0 if item[0].data == "control" else 1)
            for key, _ in events:
                data = os.read(key.fd, 32768)
                if not data:
                    selector.unregister(key.fd)
                    if key.data in logs:
                        logs[key.data]["eof"] = True
                    elif key.data == "control":
                        stop("shutdown")
                    continue
                if key.data == "info":
                    info += data
                    if len(info) > 8192:
                        raise ValueError("info")
                    try:
                        details = json.loads(info)
                        init = proc_identity(int(details["child-pid"])) or init
                        activate()
                    except (ValueError, KeyError):
                        pass
                elif key.data == "control":
                    control_bytes = consume_control(control_bytes + data, identity, stop)
                else:
                    stream = key.data
                    if stream == "stdout" and not cwd_ready:
                        ready_bytes += data
                        if len(ready_bytes) > 2048:
                            raise ValueError("cwd_handshake")
                        if b"\n" not in ready_bytes:
                            continue
                        line, data = ready_bytes.split(b"\n", 1)
                        expected = ("AAW_READY:" + identity["nonce"] + ":" + cwd).encode()
                        if line != expected or data:
                            raise ValueError("cwd_handshake")
                        cwd_ready = True
                        activate()
                        continue
                    log = logs[stream]
                    log["observedBytes"] += len(data)
                    room = max(0, min(req["logBytes"], MAX_LOG) - sum(x["persistedBytes"] for x in logs.values()))
                    retained = data[:room]
                    offset = log["persistedBytes"]
                    if retained:
                        files[stream].write(retained)
                        host_files[stream].write(retained)
                        hashes[stream].update(retained)
                        log["persistedBytes"] += len(retained)
                        emit("log", identity=identity, stream=stream, offset=offset, data=base64.b64encode(retained).decode())
                    if len(retained) != len(data):
                        stop("log_limit")
            if process.poll() is not None and all(log["eof"] for log in logs.values()):
                break
    except (OSError, ValueError, KeyError) as error:
        fault = dict(code="WSL_SUPERVISOR_FAILED", stage="run", nativeCode=getattr(error, "errno", None))
        stop("fault")
    finally:
        if process and process.poll() is None:
            stop("shutdown")
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        selector.close()
        os.close(gate)
        os.close(info_read)
        if info_write >= 0:
            os.close(info_write)
    # bwrap's PID-namespace init dies with its monitor. An adopted init is reaped.
    until = time.monotonic() + 2
    remaining = namespace_members(init["namespace"]) if init else None
    reaped = process is not None and process.poll() is not None
    children_empty = False
    while time.monotonic() < until:
        children_empty = reap_children() if process is None or reaped else False
        remaining = namespace_members(init["namespace"]) if init else None
        if children_empty and (remaining == [] or init is None):
            break
        if init:
            try:
                p = proc_identity(init["pid"])
            except (OSError, ValueError, IndexError):
                p = None
            if p and p["start"] == init["start"] and p["namespace"] == init["namespace"]:
                try:
                    os.kill(init["pid"], signal.SIGKILL)
                except ProcessLookupError:
                    pass
        time.sleep(0.03)
    proof = cleanup_proof(spawn_attempted, reaped, children_empty, init, remaining, owner, started, gate_opened)
    confirmed = proof["method"] != "unconfirmed"
    for stream, log in logs.items():
        if not spawn_attempted:
            log["eof"] = True
        files[stream].flush()
        os.fsync(files[stream].fileno())
        files[stream].close()
        host_files[stream].flush()
        os.fsync(host_files[stream].fileno())
        host_files[stream].close()
        log["sha256"] = hashes[stream].hexdigest()
        log["coverage"] = "partial_at_limit" if log["persistedBytes"] < log["observedBytes"] else "complete" if log["eof"] else "incomplete"
    exported, deleted, skipped = [], [], 0
    if confirmed:
        try:
            exported, deleted, skipped = export_files(work, control, baseline)
        except (OSError, ValueError):
            fault = dict(code="WSL_ARTIFACTS_UNAVAILABLE", stage="run", nativeCode=None)
    if not confirmed:
        fault = dict(code="WSL_CLEANUP_UNCONFIRMED", stage="cleanup", nativeCode=None)
    complete = now()
    result = dict(schema="aaw.command.wsl.result.v1", identity=identity, startedAt=started, completedAt=complete,
                  exit=dict(shellExitCode=process.returncode if reaped and started is not None and stop_at is None else None, shellExited=reaped and started is not None and stop_at is None, observedAt=complete, termination=termination if started or stop_at is not None else "failed_start"),
                  job=dict(activeProcesses=0 if confirmed else None, emptyConfirmed=confirmed, observedAt=complete), cleanupConfirmed=confirmed, logs=logs, error=fault,
                  lifecycle=dict(supervisorPid=os.getpid(), supervisorStartTicks=owner["start"], namespacePid=init["pid"] if init else None, namespaceStartTicks=init["start"] if init else None, namespaceInode=init["namespace"] if init else None, namespaceProcessesRemaining=len(remaining) if remaining is not None else None, namespaceInitReaped=confirmed and init is not None, processObservation=observation, cleanupProof=proof),
                  exported=exported, deleted=deleted, skippedFiles=skipped)
    write_json(os.path.join(control, "result.json"), result)
    for index, exported_file in enumerate(exported):
        write_new(os.path.join(host_control, "wsl-artifact-%d.bin" % index), read_file(os.path.join(control, "artifact-%d.bin" % index), MAX_FILE))
    # Written last and fsynced: cold history recovery never launches WSL.
    write_json(os.path.join(host_control, "wsl-linux-result.json"), result)
    send_artifacts(req, control, result)
    emit("result", result=result)


def main():
    global INITIAL_CONTROL
    request_bytes = b""
    while b"\n" not in request_bytes and len(request_bytes) <= MAX_REQUEST:
        chunk = os.read(0, 65536)
        if not chunk:
            break
        request_bytes += chunk
    if b"\n" in request_bytes:
        line, INITIAL_CONTROL = request_bytes.split(b"\n", 1)
        request_bytes = line + b"\n"
    if len(request_bytes) > MAX_REQUEST or not request_bytes.endswith(b"\n"):
        raise ValueError("request")
    req = json.loads(request_bytes)
    root = check_request(req)
    if req["mode"] == "recover":
        recover(req, root)
    else:
        run(req, root)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("fault", code="WSL_BRIDGE_FAILED", detail=type(error).__name__)
        sys.exit(1)
