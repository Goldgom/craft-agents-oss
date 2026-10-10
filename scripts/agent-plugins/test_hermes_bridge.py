"""Contract tests using a subprocess and a small native AIAgent API fixture."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BRIDGE = Path(__file__).resolve().parents[2] / 'apps/electron/resources/scripts/agent-plugins/hermes_bridge.py'
FIXTURE = '''
print("native startup diagnostics")
from tools.registry import registry
class AIAgent:
    def __init__(self, **kwargs):
        assert not kwargs['skip_context_files'] and not kwargs['skip_memory'] and not kwargs['skip_background_review']
        assert kwargs['load_soul_identity'] and kwargs['save_trajectories']
        assert kwargs['ephemeral_system_prompt'] == 'User preference instructions'
        self.kwargs = kwargs
        self.session_id = kwargs['session_id']
        self.session_input_tokens = self.session_output_tokens = 0
        from model_tools import get_tool_definitions
        self.tools = get_tool_definitions()
    def steer(self, message):
        return True
    def close(self):
        pass
    def _execute_tool_calls(self, name, arguments, messages):
        # The bridge must retain this native executor and augment the registry.
        result = registry.dispatch(name, arguments)
        messages.append({'role': 'tool', 'content': result})
        return result
    def run_conversation(self, message, conversation_history, task_id, stream_callback):
        messages = list(conversation_history) + [{'role': 'user', 'content': message}]
        names = {tool['function']['name'] for tool in self.tools}
        assert 'read_file' in names and 'tokenbird_0' in names
        native_result = self._execute_tool_calls('read_file', {'path': 'instructions.md', 'limit': 20}, messages)
        host_result = self._execute_tool_calls('tokenbird_0', {'file_path': 'instructions.md'}, messages)
        stream_callback('native ')
        self.session_input_tokens += 100
        self.session_output_tokens += 20
        result = 'native response; history=' + str(len(conversation_history)) + '; native=' + native_result + '; host=' + host_result
        messages.append({'role': 'assistant', 'content': result})
        return {'final_response': result, 'messages': messages, 'completed': True}
'''
REGISTRY_FIXTURE = '''
import json
class Registry:
    def __init__(self):
        self.entries = {}
    def register(self, name, toolset, schema, handler):
        self.entries[name] = (schema, handler)
    def deregister(self, name):
        self.entries.pop(name, None)
    def dispatch(self, name, args, **kwargs):
        return self.entries[name][1](args, **kwargs)
registry = Registry()
registry.register('read_file', 'file', {'name': 'read_file'}, lambda args, **kwargs: json.dumps(args))
'''
TOOLS_FIXTURE = '''
from tools.registry import registry
def get_tool_definitions(**kwargs):
    return [{'type': 'function', 'function': entry[0]} for entry in registry.entries.values()]
'''
DB_FIXTURE = '''
class SessionDB:
    def __init__(self, path):
        pass
    def get_resume_conversations(self, session):
        return ([], None)
    def close(self):
        pass
'''


class HermesBridgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='tokenbird-hermes-bridge-')
        root = Path(self.directory.name)
        (root / 'run_agent.py').write_text(FIXTURE, encoding='utf-8')
        (root / 'tools').mkdir()
        (root / 'tools/__init__.py').write_text('', encoding='utf-8')
        (root / 'tools/registry.py').write_text(REGISTRY_FIXTURE, encoding='utf-8')
        (root / 'model_tools.py').write_text(TOOLS_FIXTURE, encoding='utf-8')
        (root / 'hermes_state.py').write_text(DB_FIXTURE, encoding='utf-8')
        (root / 'toolsets.py').write_text('def create_custom_toolset(*args, **kwargs): pass', encoding='utf-8')
        self.process = subprocess.Popen([sys.executable, str(BRIDGE), '--hermes-root', str(root)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.addCleanup(self.cleanup)
        self.send({'id': 'init', 'method': 'initialize', 'params': {'protocolVersion': 1,
            'runtimeDataDirectory': str(root / 'isolated-home'), 'session': {'workingDirectory': str(root)},
            'connection': {'model': 'model', 'baseUrl': 'https://example.test/v1', 'customEndpoint': {'api': 'openai-completions'}},
            'credentials': {'apiKey': 'fixture-key'}, 'history': []}})
        self.assertEqual(self.read()['result']['capabilities'], ['resume', 'steering', 'nativeTools', 'hostTools', 'toolApproval'])

    def cleanup(self):
        self.process.kill()
        self.process.communicate(timeout=5)
        self.directory.cleanup()

    def send(self, value):
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', **value}) + '\n')
        self.process.stdin.flush()

    def read(self):
        # A watchdog makes a broken stdin/worker handshake fail instead of hanging CI.
        import threading
        watchdog = threading.Timer(10, self.process.kill)
        watchdog.start()
        try:
            line = self.process.stdout.readline()
            self.assertTrue(line, 'Hermes bridge terminated without a protocol response')
            return json.loads(line)
        finally:
            watchdog.cancel()

    def turn(self, request_id):
        self.send({'id': request_id, 'method': 'agent/chat', 'params': {'turnId': request_id,
            'message': 'Read the instructions', 'context': [], 'systemPrompt': 'User preference instructions',
            'model': 'model', 'tools': [{'name': 'Read', 'description': 'Read file', 'inputSchema': {'type': 'object'}}]}})
        events = []
        while True:
            message = self.read()
            if message.get('method') == 'host/tool':
                self.assertEqual(message['params']['toolName'], 'Read')
                self.assertEqual(message['params']['turnId'], request_id)
                self.send({'id': message['id'], 'result': {'content': 'approved host output', 'isError': False}})
            elif message.get('method') == 'host/authorize':
                self.assertEqual(message['params']['toolName'], 'Read')
                self.send({'id': message['id'], 'result': {'allowed': True, 'input': {'file_path': 'approved-native.md'}}})
            elif message.get('method') == 'agent/event':
                events.append(message['params']['event'])
            elif message.get('id') == request_id:
                self.assertNotIn('error', message)
                return events

    def test_native_executor_preserves_tools_preferences_approval_rewrites_streaming_and_history(self):
        first = self.turn('first')
        self.assertTrue(any(event == {'type': 'text_delta', 'text': 'native '} for event in first))
        completed = next(event['text'] for event in first if event['type'] == 'text_complete')
        self.assertIn('approved host output', completed)
        self.assertIn('approved-native.md', completed)
        self.assertIn('"limit": 20', completed)
        self.assertIn('history=0', completed)
        self.assertEqual(first[-1]['type'], 'complete')
        self.assertEqual(first[-1]['usage']['inputTokens'], 100)
        self.assertEqual(first[-1]['usage']['outputTokens'], 20)
        second = self.turn('second')
        self.assertIn('history=4', next(event['text'] for event in second if event['type'] == 'text_complete'))
        self.assertEqual(second[-1]['usage']['inputTokens'], 100)


if __name__ == '__main__':
    unittest.main()
