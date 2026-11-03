"""Explicit read-only recovery audit; never launches or stops an execution.

An operator reviews and pins the emitted certificate plus this auditor and the
old supervisor source. A nearby unregistered JSON file grants no recovery.
Only an old prestart receipt with no namespace identity is eligible.
"""
import datetime
import hashlib
import json
import os
import pathlib
import re
import sys
import time

PRODUCT = pathlib.Path('/mnt/c/work/analog_ai_workbench')
sha = lambda data: hashlib.sha256(data).hexdigest()


def ordinary(path):
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(PRODUCT) or resolved != path or any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError('path')
    stat = path.stat()
    if not path.is_file() or stat.st_nlink != 1:
        raise ValueError('file')
    data = path.read_bytes()
    after = path.stat()
    if (stat.st_ino, stat.st_size, stat.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError('changed')
    return data


def identity(pid):
    raw = pathlib.Path('/proc', str(pid), 'stat').read_text()
    fields = raw[raw.rfind(')') + 2:].split()
    return dict(pid=pid, ppid=int(fields[1]), startTicks=fields[19])


def identities():
    return sorted([identity(int(name)) for name in os.listdir('/proc') if name.isdigit()], key=lambda row: row['pid'])


def audit(target):
    before = identities()
    rows = []
    outer = os.readlink('/proc/self/ns/pid')
    for entry in before:
        pid = entry['pid']
        base = pathlib.Path('/proc', str(pid))
        status = (base / 'status').read_text()
        nspids = [line.split()[1:] for line in status.splitlines() if line.startswith('NSpid:')]
        if nspids != [[str(pid)]]:
            raise ValueError('nested_or_unknown_pid_namespace')
        try:
            same_outer = os.readlink(base / 'ns/pid') == outer
            if not same_outer:
                raise ValueError('nested_pid_namespace')
        except PermissionError:
            same_outer = None  # Stable outer NSpid is still positive exclusion.
        command = (base / 'cmdline').read_bytes()
        flags = dict(executionMentioned=target['identity']['executionId'].encode() in command,
                     nonceMentioned=target['identity']['nonce'].encode() in command,
                     privateWorkMentioned=target['privateWork'].encode() in command,
                     supervisorIdentityMatch=pid == target['supervisorPid'] and entry['startTicks'] == target['supervisorStartTicks'],
                     bubblewrap=any(pathlib.PurePosixPath(arg.decode('utf-8', 'replace')).name == 'bwrap' for arg in command.split(b'\0') if arg),
                     supervisorSourceMentioned=b'agent-wsl-command-supervisor.py' in command)
        if any(flags.values()) or identity(pid) != entry:
            raise ValueError('remaining_or_changed_process')
        rows.append(dict(**entry, nspidDepth=1, sameOuterNamespace=same_outer, **flags))
    time.sleep(.1)
    after = identities()
    if before != after:
        raise ValueError('unstable_census')
    return dict(before=before, after=after, rows=rows, errors=[], outerNamespace=outer, auditPid=os.getpid())


def main():
    if os.getuid() != 1000 or os.environ.get('WSL_DISTRO_NAME') != 'ROCKY9_LLM_LAB' or len(sys.argv) != 3:
        raise ValueError('target')
    request = json.loads(ordinary(pathlib.Path(sys.argv[1])))
    run, eid = request['runId'], request['executionId']
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,160}', run) or not re.fullmatch(r'cmd-[a-f0-9-]{36}', eid):
        raise ValueError('identity')
    source = ordinary(PRODUCT / request['supervisor']['path'])
    if len(source) != request['supervisor']['bytes'] or sha(source) != request['supervisor']['sha256']:
        raise ValueError('supervisor_changed')
    control = PRODUCT / '.local/agent-command-runner/executions' / eid / 'control'
    raw = ordinary(control / 'wsl-linux-result.json')
    terminal = json.loads(raw)
    driver_raw = ordinary(control / 'wsl-driver-result.json')
    driver = json.loads(driver_raw)
    original = json.loads(ordinary(control / 'wsl-request.json'))
    execution = json.loads(ordinary(PRODUCT / '.local/agent-command/runs' / run / eid / 'execution.json'))['execution']
    p = terminal['lifecycle']
    if terminal['identity'] != original['identity'] or terminal['identity']['executionId'] != eid or execution['runId'] != run or execution['startedAt'] is not None or terminal['startedAt'] is not None or terminal['cleanupConfirmed'] or terminal['exit']['shellExited'] or terminal['exit']['shellExitCode'] is not None or any(p[k] is not None for k in ['namespacePid', 'namespaceStartTicks', 'namespaceInode', 'namespaceProcessesRemaining']) or p['namespaceInitReaped']:
        raise ValueError('not_prestart_unknown_cleanup')
    if driver['snapshot'] != terminal or driver['receipt']['supervisorSha256'] != sha(source) or driver['receipt']['identity'] != terminal['identity'] or not driver['receipt']['wslExited'] or driver['receipt']['wslExitCode'] != 0 or driver['receipt']['wireFailed'] or driver['receipt']['callbackFailed']:
        raise ValueError('driver_receipt')
    logs = {}
    for stream in ['stdout', 'stderr']:
        data = ordinary(control / ('wsl-' + stream + '.bin'))
        log = terminal['logs'][stream]
        if len(data) != log['persistedBytes'] or sha(data) != log['sha256'] or not log['eof'] or log['coverage'] != 'complete' or log['observedBytes'] != len(data):
            raise ValueError('log')
        logs[stream] = dict(bytes=len(data), sha256=sha(data))
    target = dict(identity=terminal['identity'], privateWork=original['executionRoot'] + '/' + eid, supervisorPid=p['supervisorPid'], supervisorStartTicks=p['supervisorStartTicks'])
    census = None
    for _ in range(4):
        try:
            census = audit(target)
            break
        except (FileNotFoundError, ProcessLookupError):
            pass
        except ValueError as error:
            if str(error) not in ['unstable_census', 'remaining_or_changed_process']:
                raise
        time.sleep(.1)
    if census is None:
        raise ValueError('census_unconfirmed')
    result = dict(schema='aaw.command.wsl.prestart-recovery.v1', method='complete_outer_pid_census', runId=run,
                  identity=terminal['identity'], distribution='ROCKY9_LLM_LAB', user='maxwell',
                  supervisorSha256=sha(source), auditorSha256=sha(ordinary(pathlib.Path(__file__))),
                  observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                  bootId=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                  linuxReceipt=dict(bytes=len(raw), sha256=sha(raw)), driverReceipt=dict(bytes=len(driver_raw), sha256=sha(driver_raw)),
                  logs=logs, census=census)
    output = pathlib.Path(sys.argv[2])
    if not output.is_absolute() or not output.parent.resolve().is_relative_to(PRODUCT) or output.exists():
        raise ValueError('output')
    with output.open('x', encoding='utf-8') as file:
        file.write(json.dumps(result, indent=2) + '\n');file.flush();os.fsync(file.fileno())
    print(json.dumps(dict(certificate=str(output),sha256=sha(output.read_bytes()),processCount=len(census['rows']))))


if __name__ == '__main__':
    main()
