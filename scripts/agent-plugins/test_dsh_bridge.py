"""Real DSH runtime integration against a local deterministic model endpoint."""
import importlib.util
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BRIDGE = Path(__file__).resolve().parents[2] / "apps/electron/resources/scripts/agent-plugins/dsh_bridge.py"


class ModelHandler(BaseHTTPRequestHandler):
    requests = []
    native_path = None
    deny_native = False

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        ModelHandler.requests.append(body)
        if self.headers.get("Authorization") != "Bearer local-fixture-key":
            self.send_error(403)
            return
        has_result = any(message.get("role") == "tool" for message in body["messages"])
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        function = next((tool['function'] for tool in body.get('tools', []) if tool['function']['name'] == 'write'), None) if ModelHandler.native_path else None
        if ModelHandler.native_path:
            assert function, [tool['function']['name'] for tool in body.get('tools', [])]
            name = function['name']; arguments = json.dumps({'file_path': ModelHandler.native_path, 'content': 'native-dsh-file-marker'})
        else:
            name = next(tool['function']['name'] for tool in body['tools'] if tool['function']['name'].startswith('tokenbird_')); arguments = '{"value":"native-dsh"}'
        delta = {"role": "assistant", "content": "Native DSH received the TokenBird source result."} if has_result else {
            "role": "assistant", "content": "", "tool_calls": [{"index": 0, "id": "native-call-1", "type": "function",
                "function": {"name": name, "arguments": arguments}}]}
        for changes, finish in [(delta, None), ({}, "stop" if has_result else "tool_calls")]:
            chunk = {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1,
                "model": body["model"], "choices": [{"index": 0, "delta": changes, "finish_reason": finish}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(('data: ' + json.dumps({'id': 'chatcmpl-fixture', 'object': 'chat.completion.chunk',
            'created': 1, 'model': body['model'], 'choices': [],
            'usage': {'prompt_tokens': 200, 'completion_tokens': 20, 'total_tokens': 220}}) + '\n\n').encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


@unittest.skipUnless(importlib.util.find_spec("deepseek_harness"), "Install deepseek-harness-sdk==0.1.5rc1 to run native DSH integration")
class DshBridgeIntegration(unittest.TestCase):
    def test_native_loop_host_tools_preferences_and_history_recovery(self):
        ModelHandler.requests = []
        model_server = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        self.addCleanup(model_server.server_close)
        self.addCleanup(model_server.shutdown)
        threading.Thread(target=model_server.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory(prefix="tokenbird-dsh-integration-") as root_value:
            root = Path(root_value)
            workspace = root / "workspace"
            workspace.mkdir()
            model_url = "http://127.0.0.1:" + str(model_server.server_port) + "/v1"
            initialization = {"protocolVersion": 1, "runtimeDataDirectory": str(root / "runtime"),
                "session": {"id": "host-session", "workingDirectory": str(workspace), "workspaceRootPath": str(workspace)},
                "connection": {"providerType": "pi_compat", "piAuthProvider": "openai", "authType": "api_key",
                    "model": "deepseek-v4-flash", "baseUrl": model_url, "customEndpoint": {"api": "openai-completions"}},
                "credentials": {"apiKey": "local-fixture-key"}, "history": [{"type": "user", "content": "Prior visible host conversation"}]}

            def start_bridge(index):
                output = queue.Queue()
                stderr = (root / ("stderr-" + str(index) + ".log")).open("w", encoding="utf-8")
                env = {key: value for key, value in os.environ.items() if key in {
                    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
                    "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"}}
                env.update({"PYTHONIOENCODING": "utf-8", "DSH_PRIMARY_RUNTIME": ""})
                process = subprocess.Popen([sys.executable, str(BRIDGE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=stderr, encoding="utf-8", env=env, cwd=workspace)

                def read():
                    for line in process.stdout:
                        output.put(json.loads(line))
                    output.put(None)

                threading.Thread(target=read, daemon=True).start()
                return process, output, stderr

            def send(process, value):
                process.stdin.write(json.dumps({"jsonrpc": "2.0", **value}) + "\n")
                process.stdin.flush()

            native_approvals = []
            def receive(process, output, request_id):
                events, calls = [], []
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    value = output.get(timeout=max(0.1, deadline - time.monotonic()))
                    self.assertIsNotNone(value, "Bridge exited before replying")
                    if value.get('method') == 'host/authorize':
                        native_approvals.append(value['params'])
                        send(process, {'id': value['id'], 'result': {'allowed': not ModelHandler.deny_native,
                            'input': value['params']['input'], 'reason': 'Native test denies this write' if ModelHandler.deny_native else None}})
                    elif value.get("method") == "host/tool":
                        calls.append(value["params"])
                        self.assertEqual(value["params"]["toolName"], "mcp__fixture__source")
                        self.assertEqual(value["params"]["input"], {"value": "native-dsh"})
                        send(process, {"id": value["id"], "result": {"content": "TokenBird source result", "isError": False}})
                    elif value.get("method") == "agent/event":
                        events.append(value["params"])
                    elif value.get("id") == request_id:
                        self.assertNotIn("error", value, json.dumps(value, ensure_ascii=False))
                        return value["result"], events, calls
                self.fail("Native DSH bridge timed out")

            def close_bridge(process, stderr):
                process.stdin.close()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    if os.name == "nt":
                        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                    else:
                        process.kill()
                    process.wait(timeout=5)
                stderr.close()
                process.stdout.close()

            params = {"turnId": "turn-1", "message": "Use the configured TokenBird source.", "model": "deepseek-v4-flash",
                "systemPrompt": "TOKENBIRD_SHARED_PREFERENCES_MARKER", "context": ["Existing page context"],
                "tools": [{"name": "mcp__fixture__source", "description": "Configured TokenBird source",
                    "inputSchema": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}}]}
            if os.environ.get('TOKENBIRD_DSH_TOOLS_FILE'):
                params['tools'] += json.loads(Path(os.environ['TOKENBIRD_DSH_TOOLS_FILE']).read_text(encoding='utf-8'))
            process, output, stderr = start_bridge(1)
            try:
                send(process, {"id": "initialize", "method": "initialize", "params": initialization})
                initialized, _, _ = receive(process, output, "initialize")
                self.assertNotIn("resume", initialized["capabilities"])
                send(process, {"id": "chat", "method": "agent/chat", "params": params})
                result, events, calls = receive(process, output, "chat")
                self.assertEqual(len(calls), 1)
                self.assertEqual(result, {})
                self.assertTrue(any(row["event"].get("text") == "Native DSH received the TokenBird source result." for row in events))
                self.assertTrue(all(row["turnId"] == "turn-1" for row in events))
                self.assertEqual(next(row['event']['usage'] for row in events if row['event']['type'] == 'complete'),
                    {'inputTokens': 400, 'outputTokens': 40})
                self.assertIn("TOKENBIRD_SHARED_PREFERENCES_MARKER", json.dumps(ModelHandler.requests[0]["messages"]))
                self.assertIn("Prior visible host conversation", json.dumps(ModelHandler.requests[0]["messages"]))
                self.assertTrue(any(not tool['function']['name'].startswith('tokenbird_') for tool in ModelHandler.requests[0]['tools']))
                self.assertEqual(sum(tool['function']['name'].startswith('tokenbird_') for tool in ModelHandler.requests[0]['tools']), len(params['tools']))
                before_change = len(ModelHandler.requests)
                send(process, {"id": "changed-prompt", "method": "agent/chat", "params": {
                    **params, "turnId": "changed-prompt", "systemPrompt": "TOKENBIRD_UPDATED_PREFERENCES_MARKER"}})
                _, _, changed_calls = receive(process, output, "changed-prompt")
                self.assertEqual(len(changed_calls), 1)
                changed_messages = json.dumps(ModelHandler.requests[before_change]['messages'])
                self.assertIn('TOKENBIRD_UPDATED_PREFERENCES_MARKER', changed_messages)
                self.assertIn('Native DSH received the TokenBird source result.', changed_messages)
            finally:
                close_bridge(process, stderr)

            ModelHandler.native_path = str(workspace / 'native-created.txt')
            process, output, stderr = start_bridge('native')
            try:
                send(process, {'id': 'initialize', 'method': 'initialize', 'params': {**initialization, 'history': []}})
                receive(process, output, 'initialize')
                send(process, {'id': 'native-turn', 'method': 'agent/chat', 'params': {**params, 'turnId': 'native-turn', 'message': 'Create the native file.'}})
                _, native_events, _ = receive(process, output, 'native-turn')
                self.assertEqual(Path(ModelHandler.native_path).read_text(), 'native-dsh-file-marker')
                self.assertTrue(any(call['toolName'] == 'Write' for call in native_approvals))
                self.assertTrue(any(row['event']['type'] == 'tool_start' and row['event']['toolName'] == 'Write' for row in native_events))
                self.assertTrue(any(row['event']['type'] == 'tool_result' and not row['event']['isError'] for row in native_events))
                ModelHandler.native_path = str(workspace / 'denied-native-file.txt'); ModelHandler.deny_native = True
                send(process, {'id': 'denied-turn', 'method': 'agent/chat', 'params': {**params, 'turnId': 'denied-turn', 'systemPrompt': 'Changed native test prompt', 'message': 'Create the denied native file.'}})
                receive(process, output, 'denied-turn')
                self.assertFalse(Path(ModelHandler.native_path).exists())
            finally:
                ModelHandler.native_path = None; ModelHandler.deny_native = False
                close_bridge(process, stderr)

            process, output, stderr = start_bridge('host-files')
            try:
                send(process, {'id': 'initialize', 'method': 'initialize', 'params': {**initialization, 'history': []}})
                receive(process, output, 'initialize')
                first_request = len(ModelHandler.requests)
                send(process, {'id': 'host-files', 'method': 'agent/chat', 'params': {**params, 'turnId': 'host-files',
                    'framework': {'features': {'files': 'host'}}, 'message': 'Use host tools.'}})
                receive(process, output, 'host-files')
                names = {tool['function']['name'] for tool in ModelHandler.requests[first_request]['tools']}
                self.assertIn('tokenbird_0', names)
                self.assertFalse(names & {'read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'str_replace_editor'})
            finally:
                close_bridge(process, stderr)

            process, output, stderr = start_bridge(2)
            try:
                initialization["history"] = [{"type": "assistant", "content": "Native DSH received the TokenBird source result."}]
                send(process, {"id": "initialize", "method": "initialize", "params": initialization})
                resumed, _, _ = receive(process, output, "initialize")
                self.assertNotIn('resume', resumed['capabilities'])
                send(process, {"id": "chat", "method": "agent/chat", "params": {**params, "turnId": "turn-2", "message": "Continue the existing session."}})
                _, _, calls = receive(process, output, "chat")
                self.assertEqual(len(calls), 1)
                self.assertIn("TokenBird source result", json.dumps(ModelHandler.requests[-1]["messages"]))
            finally:
                close_bridge(process, stderr)


if __name__ == "__main__":
    unittest.main()
