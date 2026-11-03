"""Pure supervisor logic tests. No process launch, /proc, WSL or filesystem writes."""
import errno
import json
import pathlib
import types
import unittest
from unittest import mock

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "tools" / "agent-wsl-command-supervisor.py"
supervisor = types.ModuleType("synthetic_supervisor")
exec(compile(SOURCE.read_text(encoding="utf-8"), str(SOURCE), "exec"), supervisor.__dict__)


def proc_stat(start="100"):
    return "123 (synthetic process) " + " ".join(["S", "1"] + ["0"] * 17 + [start, "0"])


class ProcessPolicyTests(unittest.TestCase):
    def test_queued_controls_are_consumed_before_launch_and_bind_identity(self):
        identity = {"executionId": "synthetic"}
        stop = mock.Mock()
        frame = json.dumps(dict(type="stop", identity=identity, reason="engine_failure")).encode() + b"\n"
        self.assertEqual(supervisor.consume_control(frame + b'{"type":', identity, stop), b'{"type":')
        stop.assert_called_once_with("engine_failure")
        for bad in (dict(type="stop", identity={}, reason="user"), dict(type="stop", identity=identity, reason="unknown"), [], dict(type="stop", identity=identity, reason="user", extra=True)):
            with self.assertRaises(ValueError):
                supervisor.consume_control(json.dumps(bad).encode() + b"\n", identity, stop)

    def test_reaping_requires_kernel_echild_not_unknown_or_live_child(self):
        with mock.patch.object(supervisor.os, "waitpid", side_effect=[(12, 0), ChildProcessError()]):
            self.assertTrue(supervisor.reap_children())
        with mock.patch.object(supervisor.os, "waitpid", return_value=(0, 0)):
            self.assertFalse(supervisor.reap_children())
        with mock.patch.object(supervisor.os, "waitpid", side_effect=OSError(errno.EIO, "synthetic")), self.assertRaises(OSError):
            supervisor.reap_children()

    def test_prestart_cleanup_requires_explicit_child_and_gate_evidence(self):
        owner = dict(namespace="pid:[1]")
        def method(spawn=False, reaped=False, empty=True, started=None, gate=False, init=None, remaining=None):
            return supervisor.cleanup_proof(spawn, reaped, empty, init, remaining, owner, started, gate)["method"]
        self.assertEqual(method(), "not_spawned")
        self.assertEqual(method(spawn=True, reaped=True), "prestart_children_reaped")
        for kwargs in (dict(empty=False), dict(spawn=True), dict(spawn=True, reaped=True, empty=False), dict(spawn=True, reaped=True, gate=True), dict(spawn=True, reaped=True, started="time")):
            self.assertEqual(method(**kwargs), "unconfirmed")
        init = dict(namespace="pid:[2]")
        self.assertEqual(method(spawn=True, reaped=True, init=init, remaining=[]), "namespace_empty")
        self.assertEqual(method(spawn=True, reaped=True, init=init, remaining=None), "unconfirmed")
        self.assertEqual(method(spawn=True, reaped=True, init=owner, remaining=[]), "unconfirmed")

    def test_observe_only_keeps_real_counts_above_eight_and_thirty_two(self):
        observation = supervisor.new_process_observation(None)
        for count in (8, 9, 33, 65, 0):
            self.assertEqual(supervisor.observe_processes(observation, [{}] * count), (count, False))
        self.assertEqual(observation, dict(policy="observe_only", limit=None, peakProcesses=65, samples=5))
        self.assertEqual(supervisor.observe_processes(observation, None), (None, False))
        self.assertEqual(observation["samples"], 5)
        self.assertEqual(observation["peakProcesses"], 65)

    def test_legacy_threshold_fault_retains_peak_and_null_is_explicit(self):
        observation = supervisor.new_process_observation(8)
        self.assertEqual(supervisor.observe_processes(observation, [{}] * 8), (8, False))
        self.assertEqual(supervisor.observe_processes(observation, [{}] * 9), (9, True))
        self.assertEqual(observation["peakProcesses"], 9)
        for value in (0, 9, 32, 64, True, False, "none", 1.5):
            with self.subTest(value=value), self.assertRaises(ValueError):
                supervisor.new_process_observation(value)
        untouched = supervisor.new_process_observation(None)
        self.assertEqual(supervisor.observe_processes(untouched, None), (None, False))
        self.assertIsNone(untouched["peakProcesses"])
        self.assertEqual(untouched["samples"], 0)

    def test_proc_identity_distinguishes_disappearance_from_unreadable(self):
        for code in (errno.ENOENT, errno.ESRCH):
            with mock.patch("builtins.open", side_effect=OSError(code, "synthetic")):
                self.assertIsNone(supervisor.proc_identity(123))
        for code in (errno.EACCES, errno.EIO):
            with mock.patch("builtins.open", side_effect=OSError(code, "synthetic")), self.assertRaises(OSError):
                supervisor.proc_identity(123)

    def test_members_unknown_is_not_empty_and_nonmembers_are_excluded(self):
        target = "pid:[12345]"
        with mock.patch.object(supervisor.os, "listdir", side_effect=OSError(errno.EIO, "synthetic")):
            self.assertIsNone(supervisor.namespace_members(target))
        with mock.patch.object(supervisor.os, "listdir", return_value=["123"]):
            with mock.patch.object(supervisor, "proc_identity", return_value=None):
                self.assertEqual(supervisor.namespace_members(target), [])
            with mock.patch.object(supervisor, "proc_identity", side_effect=OSError(errno.EACCES, "synthetic")):
                with mock.patch.object(supervisor, "outside_nested_namespace", return_value=False):
                    self.assertIsNone(supervisor.namespace_members(target))
                with mock.patch.object(supervisor, "outside_nested_namespace", return_value=True):
                    self.assertEqual(supervisor.namespace_members(target), [])
            with mock.patch.object(supervisor, "proc_identity", side_effect=ValueError("malformed stat")):
                self.assertIsNone(supervisor.namespace_members(target))
            member = dict(pid=123, ppid=1, start="100", namespace=target)
            with mock.patch.object(supervisor, "proc_identity", return_value=member):
                self.assertEqual(supervisor.namespace_members(target), [member])

    def test_permission_fallback_requires_stable_identity_and_outer_nspid(self):
        def check(status, after=None):
            reads = [proc_stat(), status, after or proc_stat()]
            handles = [mock.mock_open(read_data=data)() for data in reads]
            with mock.patch("builtins.open", side_effect=handles):
                return supervisor.outside_nested_namespace(123)
        self.assertTrue(check("Name:\tsynthetic\nNSpid:\t123\n"))
        self.assertFalse(check("NSpid:\t123\t2\n"))
        self.assertFalse(check("NSpid:\t124\n"))
        self.assertFalse(check("Uid:\t1000\t1000\t1000\t1000\n"))
        self.assertFalse(check("NSpid:\t123\n", proc_stat("101")))
        with mock.patch("builtins.open", side_effect=OSError(errno.EACCES, "synthetic")):
            self.assertFalse(supervisor.outside_nested_namespace(123))


if __name__ == "__main__":
    unittest.main()
