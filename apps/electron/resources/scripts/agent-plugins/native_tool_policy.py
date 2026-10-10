"""Map native tool inputs to the host's permission checks, without executing them."""
import json


def host_policy_input(name, arguments):
    path = arguments.get("file_path") or arguments.get("path") or arguments.get("file")
    if name == "str_replace_editor":
        if arguments.get("command") == "view":
            return "Read", {"file_path": path}
        if arguments.get("command") == "create":
            return "Write", {"file_path": path, "content": arguments.get("file_text", "")}
        return "Edit", {"file_path": path, "old_string": arguments.get("old_str", ""), "new_string": arguments.get("new_str", "")}
    if name in ("read_file", "read", "read_image", "Read"):
        return "Read", {"file_path": path}
    if name in ("write_file", "write", "Write"):
        return "Write", {"file_path": path, "content": arguments.get("content", "")}
    if name in ("patch", "edit_file", "edit", "Edit") and path:
        return "Edit", {"file_path": path, "old_string": arguments.get("old_string", ""), "new_string": arguments.get("new_string", "")}
    if name in ("search_files", "glob", "grep", "Grep"):
        return "Grep", {"path": path, "pattern": arguments.get("pattern", "")}
    if name in ("terminal", "bash", "pwsh", "Bash"):
        return "Bash", {"command": arguments.get("command") or arguments.get("script") or ""}
    return "Bash", {"command": "native-tool " + name + " " + json.dumps(arguments, ensure_ascii=False)}


def approved_native_input(name, arguments, approved):
    """Apply host rewrites without losing the native tool's additional options."""
    _, original = host_policy_input(name, arguments)
    result = dict(arguments)
    aliases = {
        "file_path": ("file_path", "path", "file"),
        "command": ("command", "script"),
        "content": ("file_text", "content") if name == "str_replace_editor" else ("content",),
        "old_string": ("old_str",) if name == "str_replace_editor" else ("old_string",),
        "new_string": ("new_str",) if name == "str_replace_editor" else ("new_string",),
        "path": ("path", "file_path", "file"), "pattern": ("pattern",),
    }
    for key in set(original) | set(approved):
        if original.get(key) == approved.get(key):
            continue
        native_key = next((item for item in aliases.get(key, ()) if item in arguments), None)
        if native_key is None or key not in approved:
            raise ValueError("Native tool cannot apply the approved parameters; retry with " + json.dumps(approved, ensure_ascii=False))
        result[native_key] = approved[key]
    return result
