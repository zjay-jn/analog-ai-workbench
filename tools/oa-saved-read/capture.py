#!/usr/bin/env python3
"""Fixed single-LCV saved-copy capture. Source observations are not transactions."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import resource
import secrets
import signal
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any

PRODUCT = Path("/mnt/c/work/analog_ai_workbench")
CAPTURES = PRODUCT / ".local/oa-read/captures"
# The product's retained single-view copy is the source for this first binding.
# It is deliberately distinct from the live engineering library and never saved.
SOURCE_LIBRARY = CAPTURES / "36aa6f37-22ae-4e73-b099-9d508567cd80/source/FOLDED_CASCODE"
SOURCE_VIEW = SOURCE_LIBRARY / "FOLDED_CASCODE/schematic"
NAMES = ("master.tag", "sch.oa")
LIBRARY_METADATA = (b'<?xml version="1.0"?>\n\n<Library DMSystem="oaDMFileSys">\n'
                    b'    <oaDMFileSys libReadOnly="No"\n'
                    b'                 origFileSystem="Unix"/>\n</Library>\n')
LIBRARY_TAG = b'CDSLIBRARY\nDMTYPE none\nNAMESPACE LibraryUnix\n'
LIMITS = {"sch.oa": 16 * 1024 * 1024, "master.tag": 1024}
DISTRO, USER = "ROCKY9_LLM_LAB", "maxwell"
ENVIRONMENT_ID = "rocky9-llm-lab:folded-copy:v1"
LCV = {"library": "FOLDED_CASCODE", "cell": "FOLDED_CASCODE", "view": "schematic"}
READER = PRODUCT / "tools/oa-saved-read/reader.il"
WRAPPER = Path("/opt/eda/cadence/IC251ISR4/tools/dfII/bin/virtuoso")
OA_HOME = Path("/opt/eda/cadence/IC251ISR4/oa_v22.62.020")
VERSION = "aaw.oa-saved-read.capture.copy.v2"
BYTE_CAP, TIMEOUT = 2 * 1024 * 1024, 120
UUID_PATTERN = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
MAPPING = {"environmentBindingId": ENVIRONMENT_ID, "library": "FOLDED_CASCODE",
           "libraryPath": str(SOURCE_LIBRARY), "lcv": LCV}

class CaptureError(RuntimeError):
    """Fixed error code, never source strings or environment values."""

def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def encoded(value: Any) -> bytes:
    # Insertion order is part of the manifest and library-mapping recipes.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")

def sha(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()

def identity(s: os.stat_result) -> dict[str, int]:
    return {"dev": s.st_dev, "ino": s.st_ino, "size": s.st_size,
            "mtimeNs": s.st_mtime_ns, "ctimeNs": s.st_ctime_ns}

def ancestors(path: Path) -> list[dict[str, Any]]:
    if not path.is_absolute() or str(path) != os.path.abspath(path):
        raise CaptureError("PATH_REJECTED")
    current = Path(path.anchor)
    result = []
    for name in path.parts[1:]:
        current /= name
        s = os.lstat(current)
        if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode):
            raise CaptureError("PATH_REJECTED")
        result.append({"path": str(current), "dev": s.st_dev, "ino": s.st_ino})
    if path.resolve(strict=True) != path:
        raise CaptureError("PATH_REJECTED")
    return result

def directory_fd(path: Path) -> int:
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in path.parts[1:]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise

def mkdir(parent: Path, name: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name) or name in {".", ".."}:
        raise CaptureError("PATH_REJECTED")
    ancestors(parent)
    fd = directory_fd(parent)
    try:
        os.mkdir(name, 0o700, dir_fd=fd)
    finally:
        os.close(fd)
    child = parent / name
    ancestors(child)
    return child

def prepare_parent() -> None:
    current = PRODUCT
    ancestors(current)
    for name in (".local", "oa-read", "captures"):
        child = current / name
        if not os.path.lexists(child):
            mkdir(current, name)
        ancestors(child)
        current = child

def write_new(path: Path, content: bytes, mode: int = 0o600) -> None:
    ancestors(path.parent)
    parent = directory_fd(path.parent)
    try:
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(content)
                stream.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        os.close(parent)

def publish(path: Path, value: Any) -> None:
    content = encoded(value)
    if len(content) > BYTE_CAP:
        raise CaptureError("RESULT_LIMIT")
    temporary = path.name + ".pending"
    write_new(path.with_name(temporary), content)
    parent = directory_fd(path.parent)
    try:
        # Atomic publish without replacing an existing result.
        os.link(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        os.unlink(temporary, dir_fd=parent)
    finally:
        os.close(parent)

def read_fd(fd: int, limit: int) -> tuple[bytes, dict[str, int]]:
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= limit:
        raise CaptureError("SOURCE_FILE_REJECTED")
    os.lseek(fd, 0, os.SEEK_SET)
    content = bytearray()
    while True:
        block = os.read(fd, min(1024 * 1024, limit + 1 - len(content)))
        if not block:
            break
        content.extend(block)
        if len(content) > limit:
            raise CaptureError("SOURCE_FILE_REJECTED")
    after = os.fstat(fd)
    if identity(before) != identity(after) or len(content) != after.st_size:
        raise CaptureError("SOURCE_CHANGED")
    return bytes(content), identity(after)

def read_path(path: Path, limit: int) -> tuple[bytes, dict[str, int]]:
    ancestors(path.parent)
    parent = directory_fd(path.parent)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        return read_fd(fd, limit)
    finally:
        os.close(fd)

class SourceObservation:
    def __init__(self) -> None:
        self.path_identity = ancestors(SOURCE_VIEW)
        self.parent = directory_fd(SOURCE_VIEW)
        self.fds = {}
        try:
            parent_info = os.fstat(self.parent)
            if (parent_info.st_dev, parent_info.st_ino) != (self.path_identity[-1]["dev"], self.path_identity[-1]["ino"]):
                raise CaptureError("SOURCE_CHANGED")
            for name in NAMES:
                self.fds[name] = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.parent)
        except BaseException:
            self.close()
            raise

    def observe(self) -> tuple[dict[str, Any], dict[str, bytes]]:
        if ancestors(SOURCE_VIEW) != self.path_identity:
            raise CaptureError("SOURCE_CHANGED")
        records, contents = {}, {}
        for name, fd in self.fds.items():
            content, info = read_fd(fd, LIMITS[name])
            path_info = os.stat(name, dir_fd=self.parent, follow_symlinks=False)
            if not stat.S_ISREG(path_info.st_mode) or identity(path_info) != info:
                raise CaptureError("SOURCE_CHANGED")
            records[name] = {"sha256": sha(content), **info}
            contents[name] = content
        return records, contents

    def close(self) -> None:
        for fd in self.fds.values():
            os.close(fd)
        self.fds.clear()
        if self.parent is not None:
            os.close(self.parent)
            self.parent = None

def copy_records(view: Path) -> dict[str, Any]:
    result = {}
    for name in NAMES:
        content, info = read_path(view / name, LIMITS[name])
        result[name] = {"sha256": sha(content), **info}
    return result

def manifest(records: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"relativePath": name, "bytes": records[name]["size"], "sha256": records[name]["sha256"]}
            for name in sorted(NAMES)]

def manifest_digest(records: dict[str, Any]) -> str:
    return "sha256:" + sha(encoded(manifest(records)))

def copy_tree_check(root: Path, view: Path) -> None:
    metadata = view.parent.parent / ".oalib"
    tag = view.parent.parent / "cdsinfo.tag"
    expected = {str(view / name) for name in NAMES} | {str(metadata), str(tag)}
    if read_path(metadata, 1024)[0] != LIBRARY_METADATA:
        raise CaptureError("COPY_METADATA_CHANGED")
    if read_path(tag, 1024)[0] != LIBRARY_TAG:
        raise CaptureError("COPY_METADATA_CHANGED")
    expected_directories = {str(root), str(view.parent.parent), str(view.parent), str(view)}
    found, found_directories = set(), set()
    for current, directories, files in os.walk(root, followlinks=False):
        ancestors(Path(current))
        found_directories.add(current)
        for name in directories + files:
            if stat.S_ISLNK(os.lstat(Path(current) / name).st_mode):
                raise CaptureError("COPY_CHANGED")
        found.update(str(Path(current) / name) for name in files)
    if found != expected or found_directories != expected_directories:
        raise CaptureError("COPY_SIDE_EFFECT_UNCONFIRMED")

def keys(value: Any, expected: set[str]) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise CaptureError("FACT_SCHEMA_REJECTED")

def text_value(value: Any, limit: int = 1024, nullable: bool = False) -> None:
    if value is None and nullable:
        return
    if not isinstance(value, str) or not value or "\x00" in value or len(value.encode("utf-8")) > limit:
        raise CaptureError("FACT_SCHEMA_REJECTED")

def array(value: Any, limit: int) -> list[Any]:
    if not isinstance(value, list) or len(value) > limit:
        raise CaptureError("FACT_SCHEMA_REJECTED")
    return value

def unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise CaptureError("FACT_SCHEMA_REJECTED")
        result[key] = value
    return result

def validate_raw(raw: Any, request_id: str, expected_file: str) -> dict[str, Any]:
    """Pure validator: no process or source read; usable with synthetic payloads."""
    keys(raw, {"schema", "requestId", "provenance", "facts"})
    if raw["schema"] != "aaw.oa-saved-read.reader.v1" or raw["requestId"] != request_id:
        raise CaptureError("FACT_IDENTITY_REJECTED")
    keys(raw["provenance"], {"openedFilePath", "readMode"})
    if raw["provenance"] != {"openedFilePath": expected_file, "readMode": "fresh_process_read_only"}:
        raise CaptureError("FACT_IDENTITY_REJECTED")
    facts = raw["facts"]
    keys(facts, {"instances", "nets", "ports"})
    instances, nets, ports = array(facts["instances"], 2048), array(facts["nets"], 4096), array(facts["ports"], 1024)
    owners, forward, reverse = {}, {}, {}
    net_ids, port_ids = set(), set()
    for ordinal, item in enumerate(instances):
        keys(item, {"id", "name", "master", "parameters", "terminals"})
        if item["id"] != f"instance:{ordinal}":
            raise CaptureError("FACT_IDENTITY_REJECTED")
        text_value(item["name"])
        keys(item["master"], {"library", "cell", "view"})
        for value in item["master"].values():
            text_value(value)
        parameter_names = set()
        for parameter in array(item["parameters"], 256):
            keys(parameter, {"name", "valueType", "valueText"})
            text_value(parameter["name"])
            text_value(parameter["valueType"], 128)
            text_value(parameter["valueText"], 16384)
            if parameter["name"] in parameter_names:
                raise CaptureError("FACT_SCHEMA_REJECTED")
            parameter_names.add(parameter["name"])
        for ti, terminal in enumerate(array(item["terminals"], 16384)):
            keys(terminal, {"id", "name", "role", "netId"})
            expected = f"terminal:{ordinal}:{ti}"
            if terminal["id"] != expected or terminal["name"] is not None or terminal["role"] != "unknown":
                raise CaptureError("FACT_IDENTITY_REJECTED")
            text_value(terminal["netId"], nullable=True)
            owners[expected] = item["id"]
            forward[("instance_terminal", expected)] = terminal["netId"]
            if len(owners) > 16384:
                raise CaptureError("FACT_SCHEMA_REJECTED")
    for ordinal, port in enumerate(ports):
        keys(port, {"id", "name", "direction", "netId"})
        if port["id"] != f"port:{ordinal}":
            raise CaptureError("FACT_IDENTITY_REJECTED")
        port_ids.add(port["id"])
        text_value(port["name"], nullable=True)
        text_value(port["direction"], 128, nullable=True)
        text_value(port["netId"], nullable=True)
        forward[("port", port["id"])] = port["netId"]
    for ordinal, net in enumerate(nets):
        keys(net, {"id", "name", "members"})
        if net["id"] != f"net:{ordinal}":
            raise CaptureError("FACT_IDENTITY_REJECTED")
        net_ids.add(net["id"])
        text_value(net["name"], nullable=True)
        for member in array(net["members"], 17408):
            if not isinstance(member, dict):
                raise CaptureError("FACT_SCHEMA_REJECTED")
            if member.get("kind") == "instance_terminal":
                keys(member, {"kind", "instanceId", "terminalId"})
                text_value(member["terminalId"])
                text_value(member["instanceId"])
                if owners.get(member["terminalId"]) != member["instanceId"]:
                    raise CaptureError("FACT_MEMBERSHIP_REJECTED")
                key = ("instance_terminal", member["terminalId"])
            elif member.get("kind") == "port":
                keys(member, {"kind", "portId"})
                text_value(member["portId"])
                if member["portId"] not in port_ids:
                    raise CaptureError("FACT_MEMBERSHIP_REJECTED")
                key = ("port", member["portId"])
            else:
                raise CaptureError("FACT_SCHEMA_REJECTED")
            if key in reverse or forward.get(key) != net["id"]:
                raise CaptureError("FACT_MEMBERSHIP_REJECTED")
            reverse[key] = net["id"]
    for key, net_id in forward.items():
        if net_id is not None and (net_id not in net_ids or reverse.get(key) != net_id):
            raise CaptureError("FACT_MEMBERSHIP_REJECTED")
    return facts

def process_stat(pid: int) -> dict[str, Any] | None:
    try:
        path = Path("/proc") / str(pid)
        if path.stat().st_uid != os.geteuid():
            return None
        value = (path / "stat").read_text(encoding="ascii")
        fields = value[value.rfind(")") + 2:].split()
        return {"pid": pid, "state": fields[0], "pgid": int(fields[2]),
                "sessionId": int(fields[3]), "startTicks": int(fields[19])}
    except (FileNotFoundError, ProcessLookupError):
        return None

def members(pgid: int, start_ticks: int) -> list[dict[str, Any]]:
    leader = process_stat(pgid)
    if leader is not None and leader["startTicks"] != start_ticks:
        raise CaptureError("PROCESS_IDENTITY_UNCONFIRMED")
    result = []
    for item in Path("/proc").iterdir():
        if item.name.isdecimal():
            value = process_stat(int(item.name))
            if value and value["pgid"] == pgid and value["sessionId"] == pgid:
                if value["startTicks"] < start_ticks:
                    raise CaptureError("PROCESS_IDENTITY_UNCONFIRMED")
                if value["state"] != "Z":
                    result.append(value)
    return result

def stop_group(process: subprocess.Popen[bytes], state: dict[str, Any]) -> None:
    if state["startTicks"] is None:
        raise CaptureError("PROCESS_IDENTITY_UNCONFIRMED")
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if members(process.pid, state["startTicks"]):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            process.poll()
            if not members(process.pid, state["startTicks"]):
                process.wait(timeout=1)
                state.update(exitCode=process.returncode, groupEnded=True, resourcesClosed=True, closedAt=now())
                return
            time.sleep(0.05)
    state.update(groupEnded=False, resourcesClosed=False)
    raise CaptureError("PROCESS_CLEANUP_UNCONFIRMED")

def budgets(run: Path, result: Path) -> None:
    count, total = 0, 0
    for current, directories, files in os.walk(run, followlinks=False):
        for name in directories + files:
            try:
                info = os.lstat(Path(current) / name)
            except FileNotFoundError:
                # Cadence removes its log-lock file as it exits. A vanished
                # runtime entry has no remaining size or link to traverse.
                continue
            if stat.S_ISLNK(info.st_mode):
                raise CaptureError("RUNTIME_PATH_REJECTED")
        for name in files:
            try:
                info = os.lstat(Path(current) / name)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode):
                raise CaptureError("RUNTIME_PATH_REJECTED")
            count += 1
            total += info.st_size
    if count > 256 or total > BYTE_CAP:
        raise CaptureError("LOG_LIMIT")
    if os.path.lexists(result):
        info = os.lstat(result)
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > BYTE_CAP:
            raise CaptureError("RESULT_LIMIT")

def check_cancel(run: Path) -> None:
    if CANCEL_REQUESTED:
        raise CaptureError("CANCELLED")
    marker = run / "cancel.request"
    if os.path.lexists(marker):
        info = os.lstat(marker)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024:
            raise CaptureError("CANCEL_MARKER_REJECTED")
        raise CaptureError("CANCELLED")

def child_limits() -> None:
    resource.setrlimit(resource.RLIMIT_FSIZE, (BYTE_CAP, BYTE_CAP))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)

def run_reader(run: Path, result: Path, view: Path, request_id: str, state: dict[str, Any]) -> None:
    check_cancel(run)
    environment = {"PATH": "/usr/bin:/bin", "HOME": str(run / "home"), "TMPDIR": str(run / "tmp"),
                   "USER": USER, "LOGNAME": USER, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                   "WSL_DISTRO_NAME": DISTRO, "AAW_OA_CAPTURE_ID": request_id,
                   "AAW_OA_RESULT_PATH": str(result), "AAW_OA_FILE_PATH": str(view / "sch.oa"),
                   "XDG_CONFIG_HOME": str(run / "home"), "XDG_CACHE_HOME": str(run / "home"),
                   "OA_HOME": str(OA_HOME)}
    # Existing routing only. Values are never printed, serialized or inspected.
    for name in ("CDS_LIC_FILE", "LM_LICENSE_FILE"):
        if os.environ.get(name):
            environment[name] = os.environ[name]
    command = [str(WRAPPER), "-nograph", "-nocdsinit", "-restore", str(READER), "-log", str(run / "virtuoso.log")]
    log_parent = directory_fd(run)
    log_fds = []
    try:
        for name in ("launcher.stdout", "launcher.stderr"):
            log_fds.append(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=log_parent))
        process = subprocess.Popen(command, cwd=run, env=environment, stdin=subprocess.DEVNULL,
                                   stdout=log_fds[0], stderr=log_fds[1],
                                   start_new_session=True, preexec_fn=child_limits)
    finally:
        for fd in log_fds:
            os.close(fd)
        os.close(log_parent)
    state.update(started=True, pid=process.pid, pgid=process.pid, sessionId=process.pid)
    leader = process_stat(process.pid)
    if leader is None:
        process.wait(timeout=1)
        state["exitCode"] = process.returncode
        raise CaptureError("PROCESS_IDENTITY_UNCONFIRMED")
    state["startTicks"] = leader["startTicks"]
    started = time.monotonic()
    try:
        while process.poll() is None:
            check_cancel(run)
            budgets(run, result)
            if time.monotonic() - started >= TIMEOUT:
                raise CaptureError("READER_TIMEOUT")
            time.sleep(0.05)
        if members(process.pid, state["startTicks"]):
            stop_group(process, state)
            raise CaptureError("READER_DESCENDANTS_AFTER_EXIT")
        state.update(exitCode=process.returncode, groupEnded=True, resourcesClosed=True, closedAt=now())
        budgets(run, result)
        check_cancel(run)
        if process.returncode != 0:
            raise CaptureError("READER_FAILED")
    except BaseException:
        stop_group(process, state)
        raise

CANCEL_REQUESTED = False

def signal_cancel(_signum: int, _frame: Any) -> None:
    global CANCEL_REQUESTED
    # Do not interrupt the Popen/identity-recording critical interval.
    CANCEL_REQUESTED = True

def require_context() -> None:
    if platform.system() != "Linux" or os.environ.get("WSL_DISTRO_NAME") != DISTRO or pwd.getpwuid(os.geteuid()).pw_name != USER:
        raise CaptureError("ENVIRONMENT_REJECTED")
    if Path(__file__).resolve(strict=True) != PRODUCT / "tools/oa-saved-read/capture.py":
        raise CaptureError("ADAPTER_PATH_REJECTED")
    ancestors(READER.parent)
    if not WRAPPER.is_file() or not os.access(WRAPPER, os.X_OK):
        raise CaptureError("FIXED_RUNTIME_UNAVAILABLE")
    if not OA_HOME.is_dir():
        raise CaptureError("FIXED_OA_RUNTIME_UNAVAILABLE")

def capture(request_id: str) -> dict[str, Any]:
    require_context()
    prepare_parent()
    root = mkdir(CAPTURES, request_id)
    observation = None
    receipt: dict[str, Any] = {
        "schema": "aaw.oa-saved-read.receipt.v1", "requestId": request_id,
        "status": "failed", "errorCode": None, "startedAt": now(), "completedAt": None,
        "published": False, "sourceUnchanged": None, "copyUnchanged": None,
        "reader": {"started": False, "pid": None, "pgid": None, "sessionId": None,
                   "startTicks": None, "exitCode": None, "groupEnded": None,
                   "resourcesClosed": None, "closedAt": None},
        "adapterDigests": {"reader.il": None, "capture.py": None},
        "factsFileSha256": None, "wireBytes": None,
        "sourceRecords": {"before": None, "second": None, "after": None},
        "copyRecords": {"before": None, "after": None}, "provenance": None,
    }
    phase = "preparation"
    try:
        reader_bytes, _ = read_path(READER, 128 * 1024)
        launcher_bytes, _ = read_path(Path(__file__), 128 * 1024)
        receipt["adapterDigests"] = {"reader.il": sha(reader_bytes), "capture.py": sha(launcher_bytes)}
        phase = "source_observation"
        observation = SourceObservation()
        before, contents = observation.observe()
        second, second_contents = observation.observe()
        receipt["sourceRecords"].update(before=before, second=second)
        if before != second or contents != second_contents:
            receipt["sourceUnchanged"] = False
            raise CaptureError("SOURCE_CHANGED")
        # Exact small view-locator format, preserving the actual bytes when copied.
        if contents["master.tag"].decode("ascii").splitlines() != ["-- Master.tag File, Rev:1.0", "sch.oa"]:
            raise CaptureError("MASTER_TAG_REJECTED")
        copy_root = mkdir(root, "source")
        copy_library = mkdir(copy_root, "FOLDED_CASCODE")
        # Cadence otherwise creates this same generic locator on first access.
        # It belongs only to the private runtime library, never the source view.
        write_new(copy_library / ".oalib", LIBRARY_METADATA, 0o444)
        write_new(copy_library / "cdsinfo.tag", LIBRARY_TAG, 0o444)
        copy_cell = mkdir(copy_library, "FOLDED_CASCODE")
        view = mkdir(copy_cell, "schematic")
        for name in NAMES:
            write_new(view / name, contents[name], 0o400)
            os.chmod(view / name, 0o444, follow_symlinks=False)
        copy_before = copy_records(view)
        receipt["copyRecords"]["before"] = copy_before
        if manifest_digest(copy_before) != manifest_digest(before):
            raise CaptureError("COPY_CHANGED")
        copy_tree_check(copy_root, view)
        copy_ancestors = ancestors(view)
        receipt["copyProtection"] = {
            "method": "private_new_directory_read_only_modes_and_hash_observations",
            "osImmutable": False, "requestedFileMode": "0444",
            "observedFileModes": {name: oct(stat.S_IMODE(os.lstat(view / name).st_mode)) for name in NAMES},
            "sourceTransactionLock": False,
        }
        receipt["sourceAncestorIdentity"] = observation.path_identity
        receipt["copyAncestorIdentity"] = copy_ancestors
        run = mkdir(root, "run")
        mkdir(run, "home")
        mkdir(run, "tmp")
        write_new(run / "cds.lib", f"DEFINE FOLDED_CASCODE {copy_library}\n".encode("ascii"))
        raw_path = root / "reader-result.json"
        phase = "reader"
        try:
            run_reader(run, raw_path, view, request_id, receipt["reader"])
        finally:
            # Also observe after a failed or cancelled reader; never alter the source.
            after, _ = observation.observe()
            receipt["sourceRecords"]["after"] = after
            receipt["sourceUnchanged"] = before == second == after
            if not receipt["sourceUnchanged"]:
                raise CaptureError("SOURCE_CHANGED")
            copy_after = copy_records(view)
            receipt["copyRecords"]["after"] = copy_after
            receipt["copyUnchanged"] = copy_before == copy_after and ancestors(view) == copy_ancestors
            if not receipt["copyUnchanged"]:
                raise CaptureError("COPY_CHANGED")
            copy_tree_check(copy_root, view)
        phase = "validation"
        if sha(read_path(READER, 128 * 1024)[0]) != receipt["adapterDigests"]["reader.il"] or sha(read_path(Path(__file__), 128 * 1024)[0]) != receipt["adapterDigests"]["capture.py"]:
            raise CaptureError("ADAPTER_CHANGED")
        raw_bytes, _ = read_path(raw_path, BYTE_CAP)
        try:
            raw = json.loads(raw_bytes.decode("utf-8"), object_pairs_hook=unique_keys,
                             parse_constant=lambda _: (_ for _ in ()).throw(CaptureError("FACT_SCHEMA_REJECTED")))
        except (UnicodeDecodeError, ValueError, RecursionError) as error:
            raise CaptureError("FACT_JSON_REJECTED") from error
        facts = validate_raw(raw, request_id, str(view / "sch.oa"))
        receipt["provenance"] = raw["provenance"]
        before_digest, after_digest, copied_digest = manifest_digest(before), manifest_digest(after), manifest_digest(copy_after)
        envelope = {
            "schema": "aaw.oa-saved-read.snapshot.v1", "requestId": request_id,
            "source": {
                "sourceKind": "saved_oa", "environmentBindingId": ENVIRONMENT_ID,
                "libraryMappingIdentity": "sha256:" + sha(encoded(MAPPING)), "lcv": LCV,
                "capturedAt": now(), "readMode": "fresh_process_read_only",
                "savedRevision": copied_digest, "revisionMethod": "copied-file-manifest-sha256-v1",
                "sourceObservation": {"beforeDigest": before_digest, "afterDigest": after_digest,
                                      "copiedDigest": copied_digest, "state": "observed_unchanged", "transactionLock": False},
                "files": manifest(copy_after), "dirty": {"status": "unknown", "reason": "not_observed"},
            },
            "metadata": {
                "adapterVersion": VERSION, "parameterEncoding": "skill_stored_value_serialization",
                "coverage": {"instances": "complete", "nets": "complete", "ports": "complete",
                             "parameters": "complete", "terminals": "complete", "netMembers": "complete",
                             "hierarchy": "not_read", "masterContents": "not_read", "cdf": "not_read"},
            },
            "facts": facts,
        }
        wire = encoded(envelope)
        if len(wire) > BYTE_CAP:
            raise CaptureError("RESULT_LIMIT")
        check_cancel(run)
        phase = "publication"
        receipt.update(status="completed", completedAt=now(), published=True,
                       factsFileSha256=sha(wire), wireBytes=len(wire))
        receipt["parameterSemantics"] = {"valueType": "skill_runtime_type",
                                         "valueText": "skill_percent_L_not_original_input",
                                         "coverageMeaning": "all_stored_instance_properties_not_effective_or_cdf_values"}
        # Facts are not accepted without the matching final receipt and stdout.
        publish(root / "facts.json", envelope)
        publish(root / "receipt.json", receipt)
        return envelope
    except BaseException as error:
        code = str(error) if isinstance(error, CaptureError) else "CAPTURE_FAILED"
        receipt.update(status="cancelled" if code == "CANCELLED" else "failed",
                       errorCode=code, completedAt=now(), published=False, phase=phase)
        try:
            publish(root / "receipt.json", receipt)
        except BaseException:
            pass
        raise CaptureError(code) from error
    finally:
        if observation is not None:
            observation.close()

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Capture only the fixed saved Folded schematic.")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--request-id")
    args = parser.parse_args(argv)
    if not args.execute:
        parser.error("--execute required; no source/command/path overrides are accepted")
    request_id = args.request_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(8)
    if args.request_id is not None and not re.fullmatch(UUID_PATTERN, args.request_id):
        parser.error("--request-id must be a lowercase canonical UUID")
    signal.signal(signal.SIGTERM, signal_cancel)
    signal.signal(signal.SIGINT, signal_cancel)
    try:
        output = capture(request_id)
        payload = encoded(output)
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()
        return 0
    except BaseException as error:
        output = {"schema": "aaw.oa-saved-read.failure.v1", "requestId": request_id,
                  "errorCode": str(error) if isinstance(error, CaptureError) else "CAPTURE_FAILED"}
        sys.stdout.buffer.write(encoded(output))
        sys.stdout.buffer.flush()
        return 2

if __name__ == "__main__":
    sys.exit(main())
