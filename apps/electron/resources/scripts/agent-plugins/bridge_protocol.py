"""Bounded TokenBird JSON-RPC transport for native Python agent adapters."""
import concurrent.futures
import json
import sys
import threading
import uuid

MAX_FRAME = 4 * 1024 * 1024


class BridgeProtocol:
    def __init__(self):
        self.output = sys.stdout
        sys.stdout = sys.stderr
        self.write_lock = threading.Lock()
        self.pending_lock = threading.Lock()
        self.pending = {}
        self.turn = None
        self.secrets = []

    def send(self, message):
        encoded = json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > MAX_FRAME:
            raise ValueError("Bridge output frame is too large")
        with self.write_lock:
            self.output.write(encoded + "\n")
            self.output.flush()

    def event(self, value):
        if self.turn is not None:
            self.send({"method": "agent/event", "params": {"turnId": self.turn, "event": value}})

    def request_host(self, method, name, arguments):
        if self.turn is None:
            raise RuntimeError("No active TokenBird turn")
        request_id = "dsh-host-" + uuid.uuid4().hex
        future = concurrent.futures.Future()
        with self.pending_lock:
            if len(self.pending) >= 64:
                raise RuntimeError("Too many pending host tool calls")
            self.pending[request_id] = future
        try:
            self.send({"id": request_id, "method": method, "params": {
                "turnId": self.turn, "toolName": name, "input": arguments}})
            return future.result(timeout=310)
        finally:
            with self.pending_lock:
                self.pending.pop(request_id, None)

    def tool(self, name, arguments):
        return self.request_host("host/tool", name, arguments)

    def authorize(self, name, arguments):
        return self.request_host("host/authorize", name, arguments)

    def error(self, request_id, error):
        message = str(error).split('\nstderr tail:', 1)[0]
        for secret in self.secrets:
            if secret:
                message = message.replace(secret, "[redacted]")
        self.send({"id": request_id, "error": {"code": -32000, "message": message[:8000]}})

    def run(self, initialize, chat, close, steer=None):
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)

        def complete(request):
            try:
                result = chat(request.get("params") or {})
                self.turn = None
                self.send({"id": request["id"], "result": result})
            except Exception as error:
                self.turn = None
                self.error(request["id"], error)
            finally:
                self.turn = None

        try:
            while True:
                line = sys.stdin.buffer.readline(MAX_FRAME + 2)
                if not line:
                    break
                if len(line) > MAX_FRAME or not line.endswith(b"\n"):
                    raise ValueError("Invalid bridge frame")
                request = json.loads(line)
                if request.get("jsonrpc") != "2.0":
                    raise ValueError("Invalid JSON-RPC message")
                method = request.get("method")
                if method is None:
                    with self.pending_lock:
                        future = self.pending.get(request.get("id"))
                    if future and not future.done():
                        if request.get("error"):
                            future.set_exception(RuntimeError(request["error"].get("message", "Host tool failed")))
                        else:
                            future.set_result(request.get("result"))
                    continue
                try:
                    if method == "initialize" and self.turn is None:
                        self.send({"id": request["id"], "result": initialize(request.get("params") or {})})
                    elif method == "agent/chat" and self.turn is None:
                        self.turn = request.get("params", {}).get("turnId")
                        if not isinstance(self.turn, str) or not self.turn:
                            self.turn = None
                            raise ValueError("Missing turnId")
                        executor.submit(complete, request)
                    elif method == "agent/steer" and steer and self.turn == request.get("params", {}).get("turnId"):
                        result = steer(request.get("params") or {})
                        if request.get("id") is not None:
                            self.send({"id": request["id"], "result": result})
                    else:
                        raise ValueError("Unsupported or concurrent bridge request")
                except Exception as error:
                    self.error(request.get("id"), error)
        finally:
            with self.pending_lock:
                for future in self.pending.values():
                    if not future.done():
                        future.set_exception(RuntimeError("TokenBird host disconnected"))
            close()
            executor.shutdown(wait=False, cancel_futures=True)
