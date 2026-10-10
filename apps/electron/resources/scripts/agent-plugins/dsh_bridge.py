"""TokenBird adapter for the official DeepSeek Harness Python SDK and native loop."""
import hashlib
import base64
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import PackageNotFoundError, version
import json
from pathlib import Path
import secrets
import threading
import uuid

from bridge_protocol import BridgeProtocol, MAX_FRAME
from native_tool_policy import host_policy_input

PROTOCOL = BridgeProtocol()
STATE = {"harness": None, "signature": None, "tools": []}
SUPPORTED_SDK_VERSION = "0.1.5rc1"


class ToolHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def authorized(self):
        return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + STATE["tool_token"])

    def reply(self, code, value):
        content = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        if not self.authorized():
            self.reply(403, {"error": "Forbidden"})
        elif self.path == "/tools":
            self.reply(200, STATE["tools"])
        else:
            self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if not self.authorized():
            self.reply(403, {"error": "Forbidden"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_FRAME:
                raise ValueError("Invalid tool request size")
            request = json.loads(self.rfile.read(length))
            if self.path == "/authorize-native":
                policy_name, policy_input = host_policy_input(request["name"], request["input"])
                decision = PROTOCOL.authorize(policy_name, policy_input)
                # DSH's pre-execute contract freezes arguments. Reject rewrites so
                # the model can retry; never execute the unapproved original input.
                if decision.get("allowed") and decision.get("input", policy_input) != policy_input:
                    decision = {"allowed": False, "reason": "Retry the native tool with the approved parameters: "
                        + json.dumps(decision["input"], ensure_ascii=False)}
                self.reply(200, decision)
                return
            if self.path != "/tool":
                raise ValueError("Unknown tool endpoint")
            names = {tool["name"] for tool in STATE["tools"]}
            if request.get("name") not in names or not isinstance(request.get("input"), dict):
                raise ValueError("Unknown tool or invalid input")
            self.reply(200, PROTOCOL.tool(request["name"], request["input"]))
        except Exception as error:
            self.reply(200, {"content": str(error), "isError": True})


def initialize(params):
    if params.get("protocolVersion") != 1:
        raise ValueError("Unsupported TokenBird plugin protocol")
    connection = params.get("connection") or {}
    if (connection.get("customEndpoint") or {}).get("api") not in (None, "openai-completions"):
        raise ValueError("DeepSeek Harness requires a Chat Completions compatible connection")
    try:
        sdk_version = version("deepseek-harness-sdk")
    except PackageNotFoundError:
        sdk_version = None
    if sdk_version != SUPPORTED_SDK_VERSION:
        raise ValueError("Install deepseek-harness-sdk==" + SUPPORTED_SDK_VERSION + " in the selected Python environment")
    from deepseek_harness import DeepSeekHarness
    close()
    STATE.update({"harness_class": DeepSeekHarness, "home": Path(params["runtimeDataDirectory"]),
        "connection": connection, "credentials": params.get("credentials") or {},
        "cwd": params["session"]["workingDirectory"], "history": params.get("history") or [],
        "framework": params.get("framework") or {},
        "visible_history": list(params.get("history") or []),
        # SDK 0.1.5rc1 cannot reopen a persisted session. Host history recovers
        # into a fresh native session; the adapter never claims native resume.
        "session_id": "tokenbird-" + uuid.uuid4().hex,
        "tool_token": secrets.token_urlsafe(32), "tools": []})
    PROTOCOL.secrets = [*STATE["credentials"].values(), STATE["tool_token"]]
    PROTOCOL.secrets = [value for value in PROTOCOL.secrets if isinstance(value, str)]
    server = ThreadingHTTPServer(("127.0.0.1", 0), ToolHandler)
    server.daemon_threads = True
    STATE["server"] = server
    STATE["tool_url"] = "http://127.0.0.1:" + str(server.server_port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if params.get("probe"):
        # Boot the actual native runtime without starting a model turn.
        create_harness({"model": "deepseek-v4-flash", "systemPrompt": "TokenBird local framework test", "tools": []}).start()
    return {"protocolVersion": 1, "capabilities": ["nativeTools", "hostTools", "toolApproval"]}


def create_harness(params):
    tools = params.get("tools") or []
    STATE["tools"] = tools
    model = params.get("model") or STATE["connection"].get("model")
    if not isinstance(model, str) or not model:
        raise ValueError("Select a model for DeepSeek Harness")
    model = model.removeprefix("pi/")
    signature = hashlib.sha256(json.dumps([tools, model, params.get("systemPrompt"), params.get("framework"), params.get("thinkingLevel")], sort_keys=True).encode()).hexdigest()
    if STATE["harness"] and signature == STATE["signature"]:
        return STATE["harness"]
    if STATE["harness"]:
        STATE["harness"].close()
        STATE["harness"] = None
        STATE["session_id"] = "tokenbird-" + uuid.uuid4().hex
        STATE["history"] = list(STATE["visible_history"])
    home = STATE["home"]
    home.mkdir(parents=True, exist_ok=True)
    patch = home / "tokenbird.patch.json"
    framework = params.get("framework") or STATE["framework"]
    native = framework.get("nativeOptions") or {}
    rows = []
    if framework.get("features", {}).get("files", "native") != "native":
        rows += [{"id": row, "disabled": True} for row in ["persistent-bash", "persistent-pwsh", "tool-bash", "tool-pwsh", "tool-fs", "tool-fs-search"]]
    rows += [{"id": "system-prompt", "config": {"includeHarnessIdentity": True,
        "includeRuntimeContext": True, "personaPrefix": params.get("systemPrompt", "")}},
        {"insert": [{"id": "tokenbird-host-tools", "name": str(Path(__file__).with_name("dsh_host_tools.mjs").resolve()),
            "config": {"url": STATE["tool_url"], "token": STATE["tool_token"]}}]}]
    patch.write_text(json.dumps(rows), encoding="utf-8")
    connection, credentials = STATE["connection"], STATE["credentials"]
    base_url = connection.get("baseUrl")
    if not base_url:
        if connection.get("piAuthProvider") == "deepseek":
            base_url = "https://api.deepseek.com"
        elif connection.get("providerType") == "pi" and connection.get("piAuthProvider") == "openai":
            base_url = "https://api.openai.com/v1"
        else:
            raise ValueError("Configure the model endpoint for DeepSeek Harness")
    STATE["harness"] = STATE["harness_class"](provider="deepseek-official", model=model,
        cwd=STATE["cwd"], dsh_home=str(home), profile=native.get("profile", "sdk"), patches=(str(patch),),
        reasoning_effort=params.get("thinkingLevel") if params.get("thinkingLevel") not in (None, "off") else None,
        base_url=base_url, api_key=credentials.get("apiKey") or credentials.get("accessToken"),
        initialize_timeout_seconds=90, request_timeout_seconds=1800)
    STATE["signature"] = signature
    return STATE["harness"]


def notification(value):
    if value.method != "session.event" or value.payload.get("sessionId") != STATE["session_id"]:
        return
    event = value.payload.get("event") or {}
    data = event.get("data") or {}
    if event.get("type") == "tool/call" and not str(data.get("name", "")).startswith("tokenbird_"):
        arguments = data.get("arguments") or "{}"
        if isinstance(arguments, str):
            try: arguments = json.loads(arguments)
            except ValueError: arguments = {"raw": arguments}
        name, arguments = host_policy_input(data["name"], arguments)
        call_id = "dsh-native-" + uuid.uuid4().hex
        STATE["native_calls"][data["callId"]] = (call_id, name)
        PROTOCOL.event({"type": "tool_start", "toolUseId": call_id, "toolName": name, "input": arguments})
    elif event.get("type") == "tool/result":
        for block in (data.get("message") or {}).get("content") or []:
            call = STATE["native_calls"].pop(block.get("toolCallId"), None)
            if call:
                text = "\n".join(item.get("text", "") for item in block.get("content") or [] if item.get("type") == "text")
                PROTOCOL.event({"type": "tool_result", "toolUseId": call[0], "toolName": call[1],
                    "result": text[:128000], "isError": bool(block.get("isError"))})
    if event.get("type") == "assistant/message":
        reported_usage = data.get("usage") or {}
        for key, native_key in {"inputTokens": "inputTokens", "outputTokens": "outputTokens",
            "cacheReadTokens": "cacheReadTokens", "cacheCreationTokens": "cacheWriteTokens"}.items():
            value = reported_usage.get(native_key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                STATE["usage"][key] = STATE["usage"].get(key, 0) + value
        message = data.get("message") or data
        for block in message.get("content") or []:
            if block.get("type") == "text" and block.get("text"):
                PROTOCOL.event({"type": "text_delta", "text": block["text"]})


def chat(params):
    if "harness_class" not in STATE:
        raise ValueError("Initialize DeepSeek Harness first")
    harness = create_harness(params)
    STATE["native_calls"] = {}
    STATE["usage"] = {"inputTokens": 0, "outputTokens": 0}
    message = "\n\n".join([*params.get("context", []), params["message"]])
    if STATE["history"]:
        message = "Previous visible conversation:\n" + json.dumps(STATE["history"], ensure_ascii=False) + "\n\n" + message
    images = []
    for attachment in params.get("attachments") or []:
        if attachment.get("type") == "image" or str(attachment.get("mimeType", "")).startswith("image/"):
            data = attachment.get("base64")
            if not data:
                path = Path(attachment.get("storedPath") or attachment["path"])
                if path.stat().st_size > 20 * 1024 * 1024:
                    raise ValueError("Image attachment is too large")
                data = base64.b64encode(path.read_bytes()).decode("ascii")
            images.append({"type": "image", "mimeType": attachment["mimeType"], "data": data})
            continue
        path = attachment.get("storedPath") or attachment.get("path")
        if path:
            message += "\nAttached file (use Read): " + str(path)
    content = [{"type": "text", "text": message}, *images] if images else message
    result = harness.run(content, session_id=STATE["session_id"], on_notification=notification)
    if result.finish_reason != "completed":
        raise RuntimeError("DeepSeek Harness turn ended: " + str(result.finish_reason))
    STATE["history"] = []
    STATE["visible_history"] = (STATE["visible_history"] + [
        {"type": "user", "content": params["message"]},
        {"type": "assistant", "content": result.final_response}])[-40:]
    while len(STATE["visible_history"]) > 2 and len(json.dumps(STATE["visible_history"]).encode()) > 512 * 1024:
        del STATE["visible_history"][:2]
    PROTOCOL.event({"type": "text_complete", "text": result.final_response})
    PROTOCOL.event({"type": "complete", **({"usage": STATE["usage"]} if any(STATE["usage"].values()) else {})})
    return {}


def close():
    if STATE.get("harness"):
        STATE["harness"].close()
        STATE["harness"] = None
        STATE["signature"] = None
    if STATE.get("server"):
        STATE["server"].shutdown()
        STATE["server"].server_close()
        STATE["server"] = None


if __name__ == "__main__":
    PROTOCOL.run(initialize, chat, close)
