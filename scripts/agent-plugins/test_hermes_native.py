"""Actual installed Hermes against a local model endpoint: native + host tools and native resume.

TOKENBIRD_HERMES_ROOT selects the immutable source installed by the application's recipe.
"""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BRIDGE = Path(__file__).resolve().parents[2] / 'apps/electron/resources/scripts/agent-plugins/hermes_bridge.py'


class ModelHandler(BaseHTTPRequestHandler):
    requests = []
    native_path = None

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.requests.append(body)
        names = [item['function']['name'] for item in body.get('tools') or []]
        completed = [item for item in body['messages'] if item.get('role') == 'tool']
        if not names:
            call = None  # Native auxiliary inference uses no tools.
        elif not completed:
            name = 'read_file'
            assert name in names, names
            parameters = next(item['function']['parameters'] for item in body['tools'] if item['function']['name'] == name)
            path_key = 'path' if 'path' in parameters.get('properties', {}) else 'file_path'
            args = {path_key: self.native_path}
            call = {'id': 'native-read', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}
        elif not any(item.get('tool_call_id') == 'host-source' for item in completed):
            name = next((name for name in names if name.startswith('tokenbird_')), None)
            if name:
                arguments = '{}'
            else:
                # Hermes may defer plugin tools behind its native discovery bridge.
                # Exercise that bridge instead of turning off progressive discovery.
                assert 'tool_call' in names, names
                name, arguments = 'tool_call', json.dumps({'calls': [{'name': 'tokenbird_0', 'arguments': {}}]})
            call = {'id': 'host-source', 'type': 'function', 'function': {'name': name, 'arguments': arguments}}
        else:
            call = None
        message = {'role': 'assistant', 'content': None, 'tool_calls': [call]} if call else {'role': 'assistant', 'content': 'Native Hermes completed with native-file-marker and TokenBird-source-marker.'}
        response = {'id': 'chatcmpl-local', 'object': 'chat.completion', 'created': 1, 'model': body['model'],
            'choices': [{'index': 0, 'message': message, 'finish_reason': 'tool_calls' if call else 'stop'}],
            'usage': {'prompt_tokens': 200, 'completion_tokens': 20, 'total_tokens': 220}}
        self.send_response(200)
        if not body.get('stream'):
            self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps(response).encode()); return
        self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        delta = {'role': 'assistant', 'tool_calls': [{'index': 0, **call}]} if call else message
        for value, finish in [(delta, None), ({}, 'tool_calls' if call else 'stop')]:
            chunk = {'id': 'chatcmpl-local', 'object': 'chat.completion.chunk', 'created': 1, 'model': body['model'],
                'choices': [{'index': 0, 'delta': value, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode()); self.wfile.flush()
        self.wfile.write(('data: ' + json.dumps({'id': 'chatcmpl-local', 'object': 'chat.completion.chunk',
            'created': 1, 'model': body['model'], 'choices': [], 'usage': response['usage']}) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()


@unittest.skipUnless(os.environ.get('TOKENBIRD_HERMES_ROOT'), 'Set TOKENBIRD_HERMES_ROOT to run the actual installed framework')
class HermesNativeIntegration(unittest.TestCase):
    def test_native_registry_approval_shared_tools_preferences_and_persisted_resume(self):
        ModelHandler.requests = []
        server = ThreadingHTTPServer(('127.0.0.1', 0), ModelHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix='tokenbird-hermes-native-') as temporary:
            root = Path(temporary); (root / 'instructions.txt').write_text('native-file-marker', encoding='utf-8')
            ModelHandler.native_path = str(root / 'instructions.txt')
            initialization = {'protocolVersion': 1, 'runtimeDataDirectory': str(root / 'runtime'),
                'nativeHomeDirectory': str(root / 'native-home'), 'session': {'id': 'host-session', 'workingDirectory': str(root)},
                'connection': {'model': 'local-fixture', 'baseUrl': 'http://127.0.0.1:' + str(server.server_port) + '/v1',
                    'customEndpoint': {'api': 'openai-completions'}}, 'credentials': {'apiKey': 'local-fixture-key'}, 'history': []}
            params = {'turnId': 'first', 'message': 'Read the local file, then the configured source.', 'context': [],
                'systemPrompt': 'SHARED_PREFERENCES_MARKER', 'model': 'local-fixture', 'thinkingLevel': 'off',
                'framework': {'features': {'files': 'native'}, 'nativeOptions': {'toolsets': ['file'], 'memory': False, 'skills': True, 'projectInstructions': True}},
                'tools': [{'name': 'mcp__fixture__source', 'description': 'Configured source', 'inputSchema': {'type': 'object', 'properties': {}}}]}

            def run(init, turn):
                output = queue.Queue(); stderr_path = root / (turn['turnId'] + '.log')
                stderr = stderr_path.open('w', encoding='utf-8')
                env = dict(os.environ)
                if os.name == 'nt':
                    git_root = BRIDGE.parents[3] / 'vendor/git-bash'
                    env['HERMES_GIT_BASH_PATH'] = str(git_root / 'bin/bash.exe')
                    env['PATH'] = os.pathsep.join([str(git_root / 'bin'), str(git_root / 'usr/bin'), env.get('PATH', '')])
                process = subprocess.Popen([sys.executable, str(BRIDGE), '--hermes-root', os.environ['TOKENBIRD_HERMES_ROOT']],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, encoding='utf-8', cwd=root, env=env)
                def read():
                    for line in process.stdout:
                        output.put(json.loads(line))
                    output.put(None)
                threading.Thread(target=read, daemon=True).start()
                def send(value):
                    process.stdin.write(json.dumps({'jsonrpc': '2.0', **value}) + '\n'); process.stdin.flush()
                def receive(identifier):
                    events, approvals = [], []
                    while True:
                        message = output.get(timeout=90)
                        self.assertIsNotNone(message, stderr_path.read_text(encoding='utf-8'))
                        if message.get('method') == 'host/authorize':
                            approvals.append(message['params']); send({'id': message['id'], 'result': {'allowed': True, 'input': message['params']['input']}})
                        elif message.get('method') == 'host/tool':
                            self.assertEqual(message['params']['toolName'], 'mcp__fixture__source')
                            send({'id': message['id'], 'result': {'content': 'TokenBird-source-marker', 'isError': False}})
                        elif message.get('method') == 'agent/event':
                            events.append(message['params']['event'])
                        elif message.get('id') == identifier:
                            self.assertNotIn('error', message, str(message) + '\n' + stderr_path.read_text(encoding='utf-8'))
                            return message['result'], events, approvals
                try:
                    send({'id': 'init', 'method': 'initialize', 'params': init}); initialized, _, _ = receive('init')
                    self.assertIn('nativeTools', initialized['capabilities']); self.assertIn('resume', initialized['capabilities'])
                    send({'id': turn['turnId'], 'method': 'agent/chat', 'params': turn}); result, events, approvals = receive(turn['turnId'])
                    self.assertTrue(any(event.get('type') == 'text_complete' and 'Native Hermes completed' in event.get('text', '') for event in events))
                    return result, events, approvals
                finally:
                    process.stdin.close()
                    try: process.wait(timeout=15)
                    except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
                    stderr.close(); process.stdout.close()

            result, events, approvals = run(initialization, params)
            self.assertTrue(any(call['toolName'] == 'Read' for call in approvals))
            self.assertTrue(any(event['type'] == 'tool_result' and 'native-file-marker' in event.get('result', '') for event in events), json.dumps(events, ensure_ascii=False))
            self.assertIn('SHARED_PREFERENCES_MARKER', json.dumps(ModelHandler.requests[0]['messages']))
            self.assertTrue(any(event['type'] == 'complete' and event.get('usage', {}).get('inputTokens', 0) > 0 for event in events))
            self.assertTrue(any('TokenBird-source-marker' in json.dumps(request['messages']) for request in ModelHandler.requests if request.get('tools')))
            count = len(ModelHandler.requests)
            run({**initialization, 'session': {**initialization['session'], 'nativeSessionId': result['sessionId']}}, {**params, 'turnId': 'resumed', 'message': 'Continue this native session.'})
            self.assertIn('native-read', json.dumps(ModelHandler.requests[count]['messages']))


if __name__ == '__main__':
    unittest.main()
