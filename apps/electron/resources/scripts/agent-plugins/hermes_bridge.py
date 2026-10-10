"""Hermes' native loop, registry, memory, skills, compression and session database.

TokenBird adds tools and an approval gate; Hermes retains its own tool executor.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid

from bridge_protocol import BridgeProtocol
from native_tool_policy import host_policy_input, approved_native_input

PROTOCOL = BridgeProtocol()
STATE = {"agent": None, "history": [], "aliases": {}, "registry": None, "db": None}
CAPABILITIES = ["resume", "steering", "nativeTools", "hostTools", "toolApproval"]


def initialize(params, hermes_root):
    if params.get("protocolVersion") != 1:
        raise ValueError("Unsupported TokenBird plugin protocol")
    connection = params.get("connection") or {}
    if (connection.get("customEndpoint") or {}).get("api") not in (None, "openai-completions"):
        raise ValueError("Hermes requires an OpenAI Chat Completions compatible connection")
    root = Path(hermes_root).resolve(strict=True)
    if not (root / "run_agent.py").is_file():
        raise ValueError("Hermes checkout must contain run_agent.py")
    home = Path(params.get("nativeHomeDirectory") or params["runtimeDataDirectory"])
    home.mkdir(parents=True, exist_ok=True)
    os.environ["HERMES_HOME"] = str(home)
    os.environ["TERMINAL_CWD"] = params["session"]["workingDirectory"]
    sys.path.insert(0, str(root))
    from run_agent import AIAgent
    from tools.registry import registry
    from hermes_state import SessionDB
    if not hasattr(AIAgent, "steer"):
        raise ValueError("This Hermes version does not provide native steering; use the managed installation")
    if params.get("probe"):
        import pm.shell
        if not pm.shell.bash():
            raise ValueError("Hermes native tools require Bash; install the complete desktop build or configure HERMES_GIT_BASH_PATH")
    STATE.update({"agent_class": AIAgent, "registry": registry, "connection": connection,
        "credentials": params.get("credentials") or {}, "cwd": params["session"]["workingDirectory"],
        "session_id": params["session"].get("nativeSessionId") or "tokenbird-" + uuid.uuid4().hex,
        "framework": params.get("framework") or {}, "db": SessionDB(home / "state.db")})
    PROTOCOL.secrets = [value for value in STATE["credentials"].values() if isinstance(value, str)]
    resumed = STATE["db"].get_resume_conversations(STATE["session_id"])[0] if params["session"].get("nativeSessionId") else []
    STATE["history"] = resumed or [{"role": row["type"], "content": row["content"]} for row in params.get("history") or []]
    native_dispatch = registry.dispatch

    def approved_dispatch(name, arguments, **kwargs):
        if name not in STATE["aliases"]:
            policy_name, policy_args = host_policy_input(name, arguments)
            approved = PROTOCOL.authorize(policy_name, policy_args)
            if not approved.get("allowed"):
                return json.dumps({"error": approved.get("reason") or "Permission denied"})
            try:
                arguments = approved_native_input(name, arguments, approved.get("input", policy_args))
            except ValueError as error:
                return json.dumps({"error": str(error)})
            policy_name, policy_args = host_policy_input(name, arguments)
            call_id = "hermes-native-" + uuid.uuid4().hex
            PROTOCOL.event({"type": "tool_start", "toolUseId": call_id, "toolName": policy_name, "input": policy_args})
            result = native_dispatch(name, arguments, **kwargs)
            text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
            PROTOCOL.event({"type": "tool_result", "toolUseId": call_id, "toolName": policy_name,
                "result": text[:128000], "isError": isinstance(result, dict) and bool(result.get("error"))
                    or isinstance(result, str) and result.lstrip().startswith('{"error"')})
            return result
        return native_dispatch(name, arguments, **kwargs)

    registry.dispatch = approved_dispatch
    return {"protocolVersion": 1, "capabilities": CAPABILITIES, "sessionId": STATE["session_id"]}


def chat(params):
    connection, credentials = STATE["connection"], STATE["credentials"]
    model = (params.get("model") or connection.get("model", "")).removeprefix("pi/")
    framework = params.get("framework") or STATE["framework"]
    native = framework.get("nativeOptions") or {}
    tools = params.get("tools") or []
    registry = STATE["registry"]
    for alias in STATE["aliases"]:
        registry.deregister(alias)
    STATE["aliases"] = {"tokenbird_" + str(index): tool["name"] for index, tool in enumerate(tools)}
    for alias, tool in zip(STATE["aliases"], tools):
        def execute(arguments, _name=tool["name"], **_kwargs):
            result = PROTOCOL.tool(_name, arguments)
            return json.dumps({"error" if result.get("isError") else "result": result.get("content", "")}, ensure_ascii=False)
        registry.register(name=alias, toolset="tokenbird", schema={"name": alias,
            "description": tool.get("description", ""), "parameters": tool.get("inputSchema", {})}, handler=execute)
    # Registry-only toolsets are discovered by Hermes' plugin namespace rules.
    # Register our host toolset through the native runtime toolset API as well.
    from toolsets import create_custom_toolset
    create_custom_toolset("tokenbird", "TokenBird shared tools and sources", tools=list(STATE["aliases"]))
    disabled = []
    if framework.get("features", {}).get("files", "native") != "native":
        disabled += ["terminal", "file", "code_execution"]
    if framework.get("features", {}).get("browser") == "disabled":
        disabled.append("browser")
    if framework.get("features", {}).get("sources") == "disabled":
        disabled.append("mcp")
    if not native.get("skills", True):
        disabled.append("skills")
    signature = hashlib.sha256(json.dumps([model, framework, tools, params.get("systemPrompt"), params.get("thinkingLevel")], sort_keys=True).encode()).hexdigest()
    if STATE["agent"] is None or STATE.get("signature") != signature:
        if STATE["agent"]:
            STATE["agent"].close()
        effort = params.get("thinkingLevel")
        STATE["agent"] = STATE["agent_class"](model=model,
            api_key=credentials.get("apiKey") or credentials.get("accessToken"),
            base_url=connection.get("baseUrl") or ("https://api.deepseek.com" if connection.get("piAuthProvider") == "deepseek" else None),
            provider="custom" if connection.get("baseUrl") or connection.get("piAuthProvider") == "deepseek" else "openai",
            enabled_toolsets=[*(native.get("toolsets") or ["hermes-cli"]), "tokenbird"], disabled_toolsets=disabled,
            ephemeral_system_prompt=params.get("systemPrompt", ""),
            quiet_mode=True, skip_context_files=not native.get("projectInstructions", True),
            skip_memory=not native.get("memory", True), skip_background_review=not native.get("memory", True),
            save_trajectories=True, load_soul_identity=True, cwd=STATE["cwd"],
            session_id=STATE["session_id"], session_db=STATE["db"],
            reasoning_config={"enabled": effort != "off", "effort": effort or "medium"})
        STATE["signature"] = signature
    agent = STATE["agent"]
    streamed = []

    def delta(value):
        if isinstance(value, str) and value:
            streamed.append(value); PROTOCOL.event({"type": "text_delta", "text": value})

    message = "\n\n".join([*params.get("context", []), params["message"]])
    images = []
    for item in params.get("attachments") or []:
        if item.get("type") == "image" or str(item.get("mimeType", "")).startswith("image/"):
            data = item.get("base64")
            if not data:
                path = Path(item.get("storedPath") or item["path"])
                if path.stat().st_size > 20 * 1024 * 1024:
                    raise ValueError("Image attachment is too large")
                data = base64.b64encode(path.read_bytes()).decode("ascii")
            images.append({"type": "image_url", "image_url": {"url": "data:" + item["mimeType"] + ";base64," + data}})
        else:
            message += "\nAttached file: " + str(item.get("storedPath") or item.get("path"))
    if images:
        message = [{"type": "text", "text": message}, *images]
    agent.ephemeral_system_prompt = params.get("systemPrompt", "")
    usage_fields = {"inputTokens": "session_input_tokens", "outputTokens": "session_output_tokens",
        "cacheReadTokens": "session_cache_read_tokens", "cacheCreationTokens": "session_cache_write_tokens"}
    before_usage = {key: getattr(agent, attr, 0) for key, attr in usage_fields.items()}
    result = agent.run_conversation(message, conversation_history=STATE["history"], task_id=PROTOCOL.turn, stream_callback=delta)
    if not isinstance(result, dict):
        raise ValueError("Unsupported Hermes conversation response")
    STATE["history"] = result.get("messages", STATE["history"])
    STATE["session_id"] = agent.session_id
    if result.get("error") or result.get("completed") is False:
        PROTOCOL.event({"type": "error", "message": str(result.get("error") or result.get("final_response") or "Hermes turn failed")})
    else:
        PROTOCOL.event({"type": "text_complete", "text": result.get("final_response") or "".join(streamed)})
    usage = {key: max(0, getattr(agent, attr, 0) - before_usage[key]) for key, attr in usage_fields.items()}
    PROTOCOL.event({"type": "complete", **({"usage": usage} if any(usage.values()) else {})})
    return {"sessionId": STATE["session_id"]}


def close():
    if STATE.get("agent"):
        STATE["agent"].close(); STATE["agent"] = None
    if STATE.get("db"):
        STATE["db"].close(); STATE["db"] = None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--hermes-root", required=True)
    arguments = parser.parse_args()
    PROTOCOL.run(lambda params: initialize(params, arguments.hermes_root), chat, close,
        steer=lambda params: STATE["agent"].steer(params["message"]) if STATE.get("agent") else False)
