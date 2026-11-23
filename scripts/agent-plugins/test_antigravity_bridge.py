"""Regression checks for the Antigravity ACP conversation and approval boundary."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps/electron/resources/scripts/agent-plugins"))
import antigravity_bridge as bridge


class AntigravityBridgeTests(unittest.TestCase):
    def setUp(self):
        self.backend = bridge.Antigravity("agy")
        self.cwd = tempfile.gettempdir()
        self.backend.session = {"workingDirectory": self.cwd}
        self.backend.session_id = "session"
        self.backend.mode = "ask"
        bridge.PROTOCOL.turn = "turn"

    def tearDown(self):
        bridge.PROTOCOL.turn = None

    def test_permission_stays_bound_to_exact_operation_and_session(self):
        command = {"command": "echo test", "cwd": self.cwd}
        request = {"sessionId": "session", "toolCall": {"kind": "execute", "rawInput": command},
                   "options": [{"kind": "allow_always", "optionId": "always"},
                               {"kind": "allow_once", "optionId": "once"},
                               {"kind": "reject_once", "optionId": "deny"}]}
        with patch.object(bridge.PROTOCOL, "authorize", return_value={"allowed": True, "input": command}) as authorize:
            self.assertEqual(self.backend.permissions(request)["outcome"]["optionId"], "once")
            authorize.assert_called_once_with("Bash", command)
        with patch.object(bridge.PROTOCOL, "authorize", return_value={"allowed": True, "input": {}}):
            self.assertEqual(self.backend.permissions(request)["outcome"]["optionId"], "deny")
        with patch.object(bridge.PROTOCOL, "authorize", return_value={"allowed": False}):
            self.assertEqual(self.backend.permissions(request)["outcome"]["optionId"], "deny")
        with patch.object(bridge.PROTOCOL, "authorize") as authorize:
            self.assertEqual(self.backend.permissions({**request, "sessionId": "other"})["outcome"]["outcome"], "cancelled")
            self.backend.mode = "safe"
            self.assertEqual(self.backend.permissions(request)["outcome"]["outcome"], "cancelled")
            authorize.assert_not_called()

    def test_confirmed_reply_streams_once_and_ignores_thoughts_and_late_sessions(self):
        self.backend.modes = {"currentModeId": "default", "availableModes": [{"id": "default"}]}
        actual = self.backend.call = unittest.mock.Mock()

        def respond(method, params, **kwargs):
            self.assertEqual(method, "session/prompt")
            self.assertEqual(params["sessionId"], "session")
            self.assertEqual(params["prompt"], [{"type": "text", "text": "Hello"}])
            for session, kind, text in [("other", "agent_message_chunk", "wrong"),
                                        ("session", "agent_thought_chunk", "hidden"),
                                        ("session", "agent_message_chunk", "Hi")]:
                self.backend.handle_update({"method": "session/update", "params": {"sessionId": session,
                                           "update": {"sessionUpdate": kind, "content": {"type": "text", "text": text}}}})
            return {"stopReason": "end_turn"}

        actual.side_effect = respond
        with patch.object(bridge.PROTOCOL, "event") as event:
            self.backend.chat({"message": "Hello", "model": "antigravity-auto", "permissionMode": "ask"})
            self.assertEqual([call.args[0] for call in event.call_args_list],
                             [{"type": "text_delta", "text": "Hi"}, {"type": "text_complete", "text": "Hi"}])
        with self.assertRaisesRegex(RuntimeError, "read-only"):
            self.backend.chat({"message": "Hello", "permissionMode": "safe"})
        self.assertEqual(actual.call_count, 1)


if __name__ == "__main__":
    unittest.main()
