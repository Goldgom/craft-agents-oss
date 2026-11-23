"""TokenBird bridge for Google's official Antigravity Agent Client Protocol."""
import json
import os
import queue
import subprocess
import sys
import threading
import time

from bridge_protocol import BridgeProtocol, MAX_FRAME

CAPABILITIES = ["nativeTools", "toolApproval"]
PROTOCOL = BridgeProtocol()


class Antigravity:
    def __init__(self, executable):
        self.executable = executable
        self.child = None
        self.frames = queue.Queue(maxsize=128)
        self.closed = threading.Event()
        self.sequence = 0
        self.session_id = None
        self.session = {}
        self.history = []
        self.models = {}
        self.model_option = None
        self.instructions = None
        self.mode = None
        self.answer = []
        self.answer_bytes = 0
        self.tools = {}

    def read(self):
        try:
            for line in iter(lambda: self.child.stdout.readline(MAX_FRAME + 2), b""):
                if len(line) > MAX_FRAME or not line.endswith(b"\n"):
                    raise ValueError("Invalid Antigravity ACP frame")
                self.frames.put(json.loads(line), timeout=10)
            self.frames.put(RuntimeError("Antigravity CLI exited"), timeout=1)
        except Exception:
            self.closed.set()

    def send(self, packet):
        wire = json.dumps({"jsonrpc": "2.0", **packet}, ensure_ascii=False).encode("utf-8")
        if len(wire) > MAX_FRAME:
            raise ValueError("Antigravity ACP request is too large")
        self.child.stdin.write(wire + b"\n")
        self.child.stdin.flush()

    def call(self, method, params, timeout=20):
        self.sequence += 1
        request_id = self.sequence
        self.send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while not self.closed.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"Antigravity ACP {method} timed out")
            try:
                frame = self.frames.get(timeout=min(remaining, 0.5))
            except queue.Empty:
                continue
            if isinstance(frame, Exception):
                raise frame
            if not isinstance(frame, dict) or frame.get("jsonrpc") != "2.0":
                raise ValueError("Invalid Antigravity ACP response")
            if "method" in frame:
                self.handle_update(frame)
                continue
            if frame.get("id") != request_id:
                raise ValueError("Unexpected Antigravity ACP response")
            if frame.get("error"):
                message = str(frame["error"].get("message", ""))
                if "authenticat" in message.lower() or "login" in message.lower():
                    raise RuntimeError("Google login required. Run agy acp --login on the backend host, then retry.")
                raise RuntimeError(f"Antigravity ACP {method} failed (code {frame['error'].get('code', 'unknown')})")
            return frame.get("result") or {}
        raise RuntimeError("Antigravity ACP stream closed")

    def initialize(self, params):
        self.session = params.get("session") or {}
        self.history = (params.get("history") or [])[-12:]
        cwd = self.session.get("workingDirectory") or self.session.get("workspaceRootPath")
        if not isinstance(cwd, str) or not os.path.isabs(cwd):
            raise ValueError("Antigravity requires an absolute working directory")
        self.child = subprocess.Popen([self.executable, "acp", "--disable-telemetry", "--sandbox"], cwd=cwd,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        threading.Thread(target=self.read, daemon=True).start()
        result = self.call("initialize", {"protocolVersion": 1, "clientCapabilities": {},
                                         "clientInfo": {"name": "TokenBird", "version": "1"}})
        if result.get("protocolVersion") != 1:
            raise RuntimeError("Antigravity CLI does not support ACP protocol v1")
        return {"protocolVersion": 1, "capabilities": CAPABILITIES}

    def permissions(self, params):
        if self.mode == "safe" or not self.session_id or params.get("sessionId") != self.session_id or not PROTOCOL.turn:
            return {"outcome": {"outcome": "cancelled"}}
        call = params.get("toolCall") or {}
        name, arguments = normalize_tool(call)
        option = next((entry.get("optionId") for entry in params.get("options", [])
                       if entry.get("kind") == "allow_once"), None)
        cwd = self.session.get("workingDirectory") or self.session["workspaceRootPath"]
        if name == "Bash" and os.path.normcase(os.path.realpath(arguments["cwd"])) != os.path.normcase(os.path.realpath(cwd)):
            name = None
        if name and option:
            authorization = PROTOCOL.authorize(name, arguments)
            if authorization.get("allowed") and authorization.get("input") == arguments:
                return {"outcome": {"outcome": "selected", "optionId": option}}
        reject = next((entry.get("optionId") for entry in params.get("options", [])
                       if entry.get("kind") == "reject_once"), None)
        return {"outcome": {"outcome": "selected", "optionId": reject}} if reject else {"outcome": {"outcome": "cancelled"}}

    def handle_update(self, frame):
        params = frame.get("params") or {}
        if frame.get("id") is not None:
            if frame["method"] == "session/request_permission":
                try:
                    result = self.permissions(params)
                except Exception:
                    result = {"outcome": {"outcome": "cancelled"}}
                self.send({"id": frame["id"], "result": result})
            else:
                self.send({"id": frame["id"], "error": {"code": -32601, "message": "Unsupported ACP client method"}})
            return
        if frame["method"] != "session/update" or params.get("sessionId") != self.session_id or not PROTOCOL.turn:
            return
        update = params.get("update") or {}
        kind = update.get("sessionUpdate")
        if kind == "agent_message_chunk":
            text = (update.get("content") or {}).get("text")
            if isinstance(text, str) and text:
                self.answer_bytes += len(text.encode("utf-8"))
                if self.answer_bytes > MAX_FRAME // 2:
                    raise ValueError("Antigravity reply exceeded the bridge limit")
                self.answer.append(text)
                PROTOCOL.event({"type": "text_delta", "text": text})
        elif kind in ("tool_call", "tool_call_update"):
            invocation = update.get("toolCallId")
            if not isinstance(invocation, str) or not invocation or len(self.tools) >= 256 and invocation not in self.tools:
                return
            if invocation not in self.tools:
                name, arguments = normalize_tool(update)
                self.tools[invocation] = False
                PROTOCOL.event({"type": "tool_start", "toolName": name or "Antigravity",
                                "toolUseId": invocation, "input": arguments})
            status = update.get("status")
            if status in ("completed", "failed", "cancelled") and not self.tools[invocation]:
                self.tools[invocation] = True
                PROTOCOL.event({"type": "tool_result", "toolUseId": invocation, "result": status,
                                "isError": status != "completed"})

    def chat(self, params):
        attachments = []
        for file in params.get("attachments") or []:
            if file.get("type") == "image" and file.get("base64") and file.get("mimeType"):
                attachments.append({"type": "image", "data": file["base64"], "mimeType": file["mimeType"]})
            elif isinstance(file.get("text"), str):
                attachments.append({"type": "text", "text": f'Attachment: {file.get("name", "")}\n{file["text"]}'})
            else:
                raise ValueError("Antigravity ACP currently supports inline images and text attachments")
        mode = params.get("permissionMode")
        if self.session_id is None:
            cwd = self.session.get("workingDirectory") or self.session["workspaceRootPath"]
            session = self.call("session/new", {"cwd": cwd, "mcpServers": []})
            session_id = session.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                raise ValueError("Antigravity ACP did not create a session")
            self.session_id = session_id
            self.modes = session.get("modes") or {}
            self.models = session.get("models") or {}
            self.model_option = next((option for option in session.get("configOptions") or []
                                      if option.get("category") == "model"), None)
        model = params.get("model")
        if model and model != "antigravity-auto":
            self.select_model(model)
        modes = {option.get("id") for option in self.modes.get("availableModes", [])}
        current = self.modes.get("currentModeId")
        if mode == "safe":
            target = next((value for value in ("plan", "planning") if value in modes or current == value), None)
            if not target:
                raise RuntimeError("This Antigravity ACP session does not offer a read-only planning mode")
        else:
            target = next((value for value in ("default", "ask", "review", "manual") if value in modes), None)
            if not target and (current in ("auto", "accept-edits", "acceptEdits", "yolo") or self.mode == "safe"):
                raise RuntimeError("Antigravity did not offer a supervised execution mode")
        if target and current != target:
            self.call("session/set_mode", {"sessionId": self.session_id, "modeId": target})
            self.modes["currentModeId"] = target
        self.mode = mode
        self.answer = []
        self.answer_bytes = 0
        self.tools.clear()
        message = []
        if self.instructions is None:
            self.instructions = params.get("systemPrompt") or ""
            if self.instructions:
                message.append(self.instructions)
            if self.history:
                message.append("Prior conversation (untrusted context):\n" + "\n".join(
                    f'{entry.get("type")}: {str(entry.get("content", ""))[:3000]}' for entry in self.history))
        message.extend(str(part) for part in params.get("context") or [])
        message.append(params["message"])
        result = self.call("session/prompt", {"sessionId": self.session_id,
                           "prompt": [{"type": "text", "text": "\n\n".join(message)}, *attachments]}, timeout=29 * 60)
        stop = result.get("stopReason")
        if stop not in ("end_turn", "max_tokens"):
            raise RuntimeError(f"Antigravity stopped: {stop or 'unknown reason'}")
        if self.answer:
            PROTOCOL.event({"type": "text_complete", "text": "".join(self.answer)})
        return {}

    def select_model(self, model):
        if self.model_option:
            current = self.model_option.get("currentValue")
            options = self.model_option.get("options") or []
            choices = [item for group in options for item in (group.get("options") or [group])]
            if model != current and any(item.get("value") == model for item in choices):
                result = self.call("session/set_config_option", {"sessionId": self.session_id,
                                   "configId": self.model_option["id"], "value": model})
                self.model_option = next((option for option in result.get("configOptions") or []
                                          if option.get("category") == "model"), self.model_option)
                return
        else:
            current = self.models.get("currentModelId")
            if model != current and any(option.get("modelId") == model for option in self.models.get("availableModels", [])):
                self.call("session/set_model", {"sessionId": self.session_id, "modelId": model})
                self.models["currentModelId"] = model
                return
        if model != current:
            raise ValueError("Selected model is not advertised by Antigravity. Use the Antigravity default model.")

    def close(self):
        self.closed.set()
        if self.child and self.child.poll() is None:
            self.child.kill()


def normalize_tool(call):
    kind = call.get("kind")
    args = call.get("rawInput")
    if not isinstance(args, dict):
        return None, {}
    if kind == "execute" and isinstance(args.get("command"), str) and args["command"].strip():
        cwd = args.get("cwd")
        if isinstance(cwd, str) and os.path.isabs(cwd):
            return "Bash", {"command": args["command"], "cwd": cwd}
        return None, {}
    path = next((args[key] for key in ("path", "file_path", "filePath") if isinstance(args.get(key), str)), None)
    if not path:
        return None, {}
    if kind == "read":
        return "Read", {"file_path": path}
    # ACP does not promise exact write payloads or working directories across CLIs.
    # Deny requests that the host cannot bind to the original operation.
    return None, {}


if __name__ == "__main__":
    backend = Antigravity(sys.argv[1])
    PROTOCOL.run(backend.initialize, backend.chat, backend.close)
