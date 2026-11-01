# TokenBird product permission contract

The user's required design is recorded in `docs/super-agent/permission-contract.md`.
Preserve it when changing permissions, tools, skills, node policies or provider adapters:

- Missing operational permissions suspend the original call and open the user's approval dialog. Approval resumes that call. Do not turn a requestable permission into a red failure or tell the user to reconfigure and retry.
- App-advertised built-in skills and their reference files are readable independently of node skill bindings, project directory restrictions, file capability switches and prerequisite checks.
- Full control is the application permission master switch. It bypasses capability and source allowlists, custom deny rules, human approval, Action Gates, Auto-review and skill prerequisites. Turning it off restores the configured restrictions.
- Preserve team role/protocol validation, serialized model processes and the actual chosen execution environment. These are architectural contracts, separate from application permission checks.
- Update regression tests and the permission contract together. Do not restore obsolete tests or documentation that make deny rules override full control.

These rules describe the TokenBird product being implemented; they do not change the development agent's own execution policies.
