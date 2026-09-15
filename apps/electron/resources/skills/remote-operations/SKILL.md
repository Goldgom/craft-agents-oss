---
name: remote-operations
description: Execute scoped local or remote shell operations and transfer files with SFTP when the corresponding session tools are configured.
---

# Remote operations

Use this skill only when `runshell`, `localbash`, or `sftp_transfer` is exposed and the requested target is within the user's scope.

Prefer the narrowest tool and command. Resolve the host, working directory, source, and destination explicitly; avoid broad globs and destructive commands. Never print credentials or embed secrets in command text.

Treat remote commands and transfers as state-changing actions subject to the current permission mode. Verify exit status and the requested remote artifact or state after execution. For SFTP, distinguish upload from download and confirm both endpoints before transferring.
