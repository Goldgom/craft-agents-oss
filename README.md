# Craft Agents Community Edition

Craft Agents Community Edition（Craft Agents 社区版）是一个面向本地优先、可自托管和可扩展 Agent 工作流的开源桌面与服务端项目。社区版在 Apache 2.0 许可下维护，支持桌面端、无头服务端、CLI 和 Android 客户端；你可以在自己的设备或服务器上运行会话、模型、工具、自动化和消息连接。

> 本仓库是社区版代码库。社区版不依赖 Craft 的托管服务，也不承诺与商业版功能、品牌或云端接口保持一致。请通过 Issue、Pull Request 和 Discussions 参与建设。

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)

## How it Works (Video)
To understand what Craft Agents does and how it works watch this video.

[![Demo Video](https://img.youtube.com/vi/xQouiAIilvU/hqdefault.jpg)](https://www.youtube.com/watch?v=xQouiAIilvU)

[Click Here (or on the image above) to watch the video on YouTube →](https://www.youtube.com/watch?v=xQouiAIilvU)


## Why the Community Edition

社区版的目标是把 Agent 工作流的控制权交给使用者和贡献者：会话数据保存在本地或自有服务器，模型和 API 可按工作区选择，工具、技能、自动化和消息平台都可以由社区扩展。

它提供多会话收件箱、流式 Agent 交互、工具调用可视化、文件和文档处理，以及面向开发者的 CLI、无头服务端和 WebSocket 连接。桌面端适合日常使用，服务端适合长时间运行，Android 端可以在本地提供前端服务并连接远程 WebSocket 服务端。

社区版同时集成 Claude Agent SDK 和 Pi SDK，并通过统一的工作区、会话和权限模型承载不同的 Agent 后端。项目强调 Agent Native 工作流：很多配置、工具和扩展都可以在对话中完成，也可以通过代码和配置文件精确控制。

Craft Agents Community Edition is open source under the Apache 2.0 license. You can fork it, self-host it, add providers, create integrations, and share improvements with the community.

社区版由使用者和贡献者共同维护，欢迎提交新模型适配器、来源、技能、自动化、消息平台和客户端改进。

<img width="1578" height="894" alt="image" src="https://github.com/user-attachments/assets/3f1f2fe8-7cf6-4487-99ff-76f6c8c0a3fb" />

## What you can extend

**How do I connect to Linear, Gmail, Slack...?**
Tell the agent to add a source, or configure an MCP/REST/OpenAPI source directly. The source system stores connection metadata and credentials separately, so integrations can be shared without putting secrets in the repository.

**I already have my MCP config JSON.**
Paste it. The agent handles the rest.

**What about local MCPs?**
Fully supported. Stdio-based MCP servers run as local subprocesses on your machine. Point it at an npx command, a Python script, or any local binary. It just works.

**Can it handle custom APIs?**
Yes. Paste an OpenAPI spec, some endpoint URLs, screenshots of docs, whatever you have. It figures it out and guides you through the rest.

**APIs too? Not just MCPs?**
Craft Agents connects to anything. We have it hooked up to a direct Postgres DB behind a jumpbox. Skills + Sources = magic.

**How do I import my Claude Code skills and MCPs?**
Tell the agent you want to import your skills from Claude Code. It handles the migration.

**How do I create a new skill?**
Describe what the skill should do, give it context. The agent takes care of the rest.

**Do I need to restart after changes?**
No. Everything is instant. Mention new skills or sources with `@`, even mid-conversation.

**So I can just ask it anything?**
Yes. That's the core idea behind agent-native software. You describe what you want, and it figures out how. That's a good use of tokens.


## Installation

社区版目前推荐从源码构建。预编译包和发行渠道由社区维护者根据目标平台单独发布；使用第三方构建时，请核对发布者、校验和以及版本说明。

### Build from Source

```bash
git clone https://github.com/Goldgom/craft-agents-oss.git
cd craft-agents-oss
bun install
bun run electron:start
```

开发环境要求：

- [Bun](https://bun.sh/)（建议使用当前稳定版）
- Node.js 兼容运行时（Bun 会负责大部分脚本执行）
- 桌面构建需要 Electron 的平台依赖
- Android 构建额外需要 JDK 17、Android SDK 和 Gradle 工具链（见 [Android 客户端](#android-客户端)）

## Features

- **多会话工作区**：收件箱、归档、状态流转、收藏、会话重命名和持久化。
- **流式 Agent 交互**：实时文本、工具调用状态、权限请求、后台任务和多文件 Diff。
- **多模型提供商**：支持 Anthropic、Google AI Studio、OpenAI 兼容接口、OpenRouter、Ollama、GitHub Copilot、ChatGPT/Codex OAuth 等连接方式；模型、提供商、思考级别和运行模式可以按工作区或任务选择。
- **来源与技能**：接入 MCP、REST/OpenAPI、本地文件系统和 Git 仓库；技能按工作区存储，可通过 `@` 在会话中引用。
- **自动化系统**：响应标签、状态、权限、工具调用、会话生命周期和定时事件；支持 cron、时区、启停、历史、重放、托管脚本触发、脚本元数据，以及为自动化会话设置模型提供商、模型和运行模式。
- **Messaging Gateway**：支持 Telegram、WhatsApp、Lark/飞书、企业微信和 QQ Bot；提供绑定、配对码、访问控制、待处理发送者、命令别名、自定义帮助消息，以及向绑定会话发送文本、文件、图片、视频和语音。
- **官方 QQ Bot SDK worker**：QQ Bot 的鉴权、Gateway WebSocket、心跳、重连、消息接收和媒体发送由独立 worker 维护，并使用腾讯官方 `@tencent-connect/qqbot-nodejs` SDK。
- **权限与安全**：Explore、Ask to Edit、Auto 三种权限模式；凭据使用加密存储，本地 MCP 子进程会过滤敏感环境变量。
- **跨端运行**：Electron 桌面端、无头服务端、CLI 客户端和 Android 客户端；Android 可在本地运行前端服务，远程服务器仅提供 WebSocket/RPC。

## Quick Start

1. **Launch the app** with `bun run electron:start`.
2. **Configure an LLM connection**: choose a provider, API key/OAuth credential, model and optional custom endpoint.
3. **Create a workspace**: workspace settings hold sources, skills, statuses, automations and Messaging bindings.
4. **Connect sources** (optional): add MCP servers, REST/OpenAPI APIs or local filesystems.
5. **Start chatting**: create a session and choose the required permission mode.
6. **Enable integrations** (optional): configure automations or connect Telegram, WhatsApp, Lark/飞书、企业微信 or QQ Bot.

## Desktop App Features

### Session Management

- **Inbox/Archive**: Sessions organized by workflow status
- **Flagging**: Mark important sessions for quick access
- **Status Workflow**: Todo → In Progress → Needs Review → Done
- **Session Naming**: AI-generated titles or manual naming
- **Session Persistence**: Full conversation history saved to disk

### Sources

Connect external data sources to your workspace:

| Type | Examples |
|------|----------|
| **MCP Servers** | Craft, Linear, GitHub, Notion, custom servers |
| **REST APIs** | Google (Gmail, Calendar, Drive, YouTube, Search Console), Slack, Microsoft |
| **Local Files** | Filesystem, Obsidian vaults, Git repos |

### Permission Modes

| Mode | Display | Behavior |
|------|---------|----------|
| `safe` | Explore | Read-only, blocks all write operations |
| `ask` | Ask to Edit | Prompts for approval (default) |
| `allow-all` | Auto | Auto-approves all commands |

Use **SHIFT+TAB** to cycle through modes in the chat interface.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+N` | New chat |
| `Cmd+1/2/3` | Focus sidebar/list/chat |
| `Cmd+/` | Keyboard shortcuts dialog |
| `SHIFT+TAB` | Cycle permission modes |
| `Enter` | Send message |
| `Shift+Enter` | New line |

## Messaging Gateway

Messaging Gateway 将外部聊天平台映射到工作区会话。平台凭据保存在本地加密凭据存储中，绑定关系和访问策略按工作区保存。

### Supported platforms

| Platform | Connection | Supported capabilities |
|----------|------------|-------------------------------|
| Telegram | Bot API / polling | 文本、文件、图片、视频、语音、主题和配对码 |
| WhatsApp | 独立 worker，基于 Baileys | 文本、按钮、文件和媒体转发 |
| Lark / 飞书 | Long connection | 文本、卡片和平台原生事件 |
| 企业微信 | Long connection | 文本、媒体和模板卡片 |
| QQ Bot | 官方 `@tencent-connect/qqbot-nodejs` SDK worker | C2C/群消息、文本及文件/图片/视频/语音发送 |

### Commands and aliases

在设置 → Messaging → Commands and messages 中，可以分别启用或禁用 `/new`、`/bind`、`/pair`、`/unbind`、`/help`、`/status` 和 `/stop`，并为每个命令增加别名。例如：

```text
/new       aliases: /start, /create
/help      aliases: /h
```

帮助消息和未绑定聊天提示支持 `{commands}` 占位符，用于插入当前已启用命令列表；未知斜杠命令可以选择显示帮助或静默忽略。配置保存后立即生效，无需重启消息 worker。

### QQ Bot setup

QQ Bot 使用 QQ 开放平台的 **App ID + AppSecret**。在 QQ Bot 控制台启用所需的 C2C/群消息 intents 后，在社区版设置中填写凭据并测试连接。QQ Bot worker 会在后台维护 Gateway 会话；如果出现 `invalid session/token` 或 `READY timeout`，请先确认 App ID、AppSecret、机器人 intents、网络连通性和同一 App 是否被其他实例占用。

## Remote Server (Headless)

Craft Agents can run as a headless server on a remote machine (e.g., a Linux VPS), with the desktop app connecting as a thin client. This lets you keep long-running sessions alive, access them from multiple machines, and run compute-heavy tasks on a powerful server.

### Quick Start

From the monorepo root:

```bash
# Generate a token and start the server
CRAFT_SERVER_TOKEN=$(openssl rand -hex 32) bun run packages/server/src/index.ts
```

The server prints the connection details on startup:

```
CRAFT_SERVER_URL=ws://203.0.113.5:9100
CRAFT_SERVER_TOKEN=<generated-token>
```

Copy these values and use them to connect the desktop app.

### Connecting the Desktop App

Launch the Electron app in thin-client mode by passing the server URL and token:

```bash
CRAFT_SERVER_URL=wss://203.0.113.5:9100 CRAFT_SERVER_TOKEN=<token> bun run electron:start
```

In thin-client mode, the desktop app renders the UI but all session logic, tool execution, and LLM calls run on the remote server.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CRAFT_SERVER_TOKEN` | Yes | — | Bearer token for client authentication |
| `CRAFT_RPC_HOST` | No | `127.0.0.1` | Bind address (`0.0.0.0` for remote access) |
| `CRAFT_RPC_PORT` | No | `9100` | Bind port |
| `CRAFT_RPC_TLS_CERT` | No | — | Path to PEM certificate file (enables `wss://`) |
| `CRAFT_RPC_TLS_KEY` | No | — | Path to PEM private key file (required with cert) |
| `CRAFT_RPC_TLS_CA` | No | — | Path to PEM CA chain file (optional, for client cert verification) |
| `CRAFT_DEBUG` | No | `false` | Enable debug logging |

### TLS (Recommended for Remote Access)

When exposing the server over the network, TLS encrypts the WebSocket connection (`wss://` instead of `ws://`).

**Generate a self-signed certificate (development/testing):**

```bash
./scripts/generate-dev-cert.sh
# Creates certs/cert.pem and certs/key.pem (valid 365 days)
```

**Start the server with TLS:**

```bash
CRAFT_SERVER_TOKEN=<token> \
CRAFT_RPC_HOST=0.0.0.0 \
CRAFT_RPC_TLS_CERT=certs/cert.pem \
CRAFT_RPC_TLS_KEY=certs/key.pem \
bun run packages/server/src/index.ts
```

The server will print `CRAFT_SERVER_URL=wss://<your-public-ip>:9100`.

**For production**, use certificates from a trusted CA (e.g., Let's Encrypt) or place the server behind a reverse proxy (nginx, Caddy) that terminates TLS.

### Docker

```bash
docker run -d \
  -p 9100:9100 \
  -e CRAFT_SERVER_TOKEN=<token> \
  -e CRAFT_RPC_HOST=0.0.0.0 \
  -v craft-data:/root/.craft-agent \
  craft-agents-server
```

To enable TLS in Docker, mount your certificates and set the env vars:

```bash
docker run -d \
  -p 9100:9100 \
  -e CRAFT_SERVER_TOKEN=<token> \
  -e CRAFT_RPC_HOST=0.0.0.0 \
  -e CRAFT_RPC_TLS_CERT=/certs/cert.pem \
  -e CRAFT_RPC_TLS_KEY=/certs/key.pem \
  -v ./certs:/certs:ro \
  -v craft-data:/root/.craft-agent \
  craft-agents-server
```

## Android 客户端

社区版包含一个 Android 客户端。APK 内置 WebUI 静态资源，并在设备本地启动仅监听 loopback 的 HTTP 服务，因此前端页面不依赖远程服务器托管；会话、Agent、自动化、Messaging 和模型调用仍通过 WebSocket/RPC 连接远程 Craft Agent 服务端。

### Android 构建

要求：

- Android SDK platform `android-36`
- Android Build Tools `36.1.0` 或更高版本
- JDK 17（构建脚本可在 `.toolchains/android/jdk17` 下载便携版）
- 首次构建需要网络访问 Gradle 和 Android Gradle Plugin 依赖

```powershell
# 准备 SDK（如果尚未安装）
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.1.0"

# 构建签名 debug APK
bun run android:build

# 将默认远程 WebSocket 地址写入 APK
bun run android:build -- -ServerUrl "wss://your-agent-server.example:9100"
```

产物位于 `dist/android/craft-agent-debug.apk`。发布构建：

```powershell
powershell -ExecutionPolicy Bypass -File apps/android/build.ps1 `
  -Release `
  -ServerUrl "wss://your-agent-server.example:9100"
```

Release APK 默认是 unsigned 产物，正式分发前请在自己的流水线中配置签名。安装后可以在客户端的 **Change server** 中修改远程 WebSocket URL 和 bearer token；生产环境建议使用 `wss://`。

## CLI Client

A terminal client that connects to a running Craft Agent server over WebSocket (`ws://` or `wss://`). Use it for scripting, CI/CD pipelines, server validation, or when you prefer the command line.

### Installation

```bash
# From the monorepo (requires Bun)
bun run apps/cli/src/index.ts --help

# Or add to your PATH
alias craft-cli="bun run $(pwd)/apps/cli/src/index.ts"
```

### Connection

The CLI reads connection details from flags or environment variables:

```bash
# Via environment (set once)
export CRAFT_SERVER_URL=ws://127.0.0.1:9100
export CRAFT_SERVER_TOKEN=<your-token>

# Or via flags
craft-cli --url ws://127.0.0.1:9100 --token <token> ping
```

For TLS connections (`wss://`), use `--tls-ca <path>` for self-signed certificates.

### Commands

| Command | Description |
|---------|-------------|
| `ping` | Verify connectivity (clientId + latency) |
| `health` | Check credential store health |
| `versions` | Show server runtime versions |
| `workspaces` | List workspaces |
| `sessions` | List sessions in workspace |
| `connections` | List LLM connections |
| `sources` | List configured sources |
| `session create` | Create a session (`--name`, `--mode`) |
| `session messages <id>` | Print session message history |
| `session delete <id>` | Delete a session |
| `send <id> <message>` | Send message and stream AI response |
| `cancel <id>` | Cancel in-progress processing |
| `invoke <channel> [args]` | Raw RPC call with JSON args |
| `listen <channel>` | Subscribe to push events (Ctrl+C to stop) |
| `run <prompt>` | Self-contained: spawn server, run prompt, stream response, exit |
| `--validate-server` | 21-step integration test (auto-spawns server if no `--url`) |

#### Run Command Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--workspace-dir <path>` | — | Register a workspace directory before running |
| `--source <slug>` | — | Enable a source (repeatable) |
| `--output-format <fmt>` | `text` | Output format: `text` or `stream-json` |
| `--mode <mode>` | `allow-all` | Permission mode for the session |
| `--no-cleanup` | `false` | Skip session deletion on exit |
| `--server-entry <path>` | — | Custom server entry point |
| `--provider <name>` | `anthropic` | LLM provider (`anthropic`, `openai`, `google`, `openrouter`, `groq`, `mistral`, `xai`, etc.) |
| `--model <id>` | (provider default) | Model ID (e.g., `claude-sonnet-4-5-20250929`, `gpt-4o`, `gemini-2.0-flash`) |
| `--api-key <key>` | — | API key (or `$LLM_API_KEY`, or provider-specific env var) |
| `--base-url <url>` | — | Custom API endpoint for proxies or self-hosted models |

The `run` command is fully self-contained — it spawns a headless server, creates a session, sends the prompt, streams the response, and exits. No separate server setup needed. An API key is resolved from `--api-key`, `$LLM_API_KEY`, or a provider-specific env var (e.g., `$ANTHROPIC_API_KEY`, `$OPENAI_API_KEY`).

### Examples

```bash
# Quick connectivity check
craft-cli ping

# List sessions (human-readable)
craft-cli sessions

# Send a message and stream the AI response
craft-cli send abc-123 "What files are in the current directory?"

# Pipe input
echo "Summarize this" | craft-cli send abc-123

# JSON output for scripting
craft-cli --json workspaces | jq '.[].name'

# Self-contained run (spawns its own server)
craft-cli run "Summarize the README"
craft-cli run --workspace-dir ./my-project --source github "List open PRs"

# Multi-provider support
craft-cli run --provider openai --model gpt-4o "Summarize this repo"
GOOGLE_API_KEY=... craft-cli run --provider google --model gemini-2.0-flash "Hello"
craft-cli run --provider anthropic --base-url https://openrouter.ai/api/v1 --api-key $OR_KEY "Hello"

# Validate the server (auto-spawns if no --url)
craft-cli --validate-server
craft-cli --validate-server --url ws://127.0.0.1:9100 --token <token>
```

## Architecture

```
craft-agent/
├── apps/
│   ├── cli/                   # Terminal client (CLI)
│   ├── android/               # Android client with local WebUI service
│   ├── webui/                 # Browser frontend bundled by Android/server
│   └── electron/              # Desktop GUI
│       └── src/
│           ├── main/          # Electron main process
│           ├── preload/       # Context bridge
│           └── renderer/      # React UI (Vite + shadcn)
└── packages/
    ├── core/                  # Shared types
    ├── messaging-gateway/     # Platform adapters, bindings and commands
    ├── messaging-qqbot-worker/# Official QQ Bot SDK worker
    ├── messaging-whatsapp-worker/ # WhatsApp worker
    ├── server/                # Standalone headless server
    ├── server-core/           # RPC, sessions and server services
    └── shared/                # Business logic
        └── src/
            ├── agent/         # CraftAgent, permissions
            ├── auth/          # OAuth, tokens
            ├── config/        # Storage, preferences, themes
            ├── credentials/   # AES-256-GCM encrypted storage
            ├── sessions/      # Session persistence
            ├── sources/       # MCP, API, local sources
            └── statuses/      # Dynamic status system
```

## Development

```bash
# Hot reload development
bun run electron:dev

# Build and run
bun run electron:start

# Type checking
bun run typecheck:all

# Build the Android client
bun run android:build

# Build the standalone server
bun run server:build

# Debug logging (writes to ~/Library/Logs/@craft-agent/electron/)
# Logs are automatically enabled in development
```

## Community Edition scope and limitations

- 部分模型提供商需要用户自行准备 API key、OAuth 凭据或兼容网关；社区版不代管这些凭据。
- QQ Bot、WhatsApp、Lark、企业微信等平台受各自官方权限、intents、速率限制和网络条件约束。
- Android 客户端当前提供本地前端服务；Agent 运行时、自动化调度和消息 worker 仍由服务端或本地桌面服务负责。
- Release Android APK 默认未签名；桌面端和服务端的发行包也应由部署者在自己的 CI 中签名和校验。

### Environment Variables

OAuth integrations (Slack, Microsoft) require credentials baked into the build. Create a `.env` file:

```bash
MICROSOFT_OAUTH_CLIENT_ID=your-client-id
SLACK_OAUTH_CLIENT_ID=your-slack-client-id
SLACK_OAUTH_CLIENT_SECRET=your-slack-client-secret
```

**Note:** Google OAuth credentials are NOT baked into the build. Users provide their own credentials via source configuration. See the [Google OAuth Setup](#google-oauth-setup-gmail-calendar-drive) section below.

### Google OAuth Setup (Gmail, Calendar, Drive, YouTube, Search Console)

Google integrations require you to create your own OAuth credentials. This is a one-time setup.

#### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Note your Project ID

#### 2. Enable Required APIs

Go to **APIs & Services → Library** and enable the APIs you need:
- **Gmail API** - for email integration
- **Google Calendar API** - for calendar integration
- **Google Drive API** - for file storage integration

#### 3. Configure OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Select **External** user type (unless you have Google Workspace)
3. Fill in required fields:
   - App name: e.g., "My Craft Agent"
   - User support email: your email
   - Developer contact: your email
4. Add scopes (optional - can leave default)
5. Add yourself as a test user (required for External apps in testing mode)
6. Complete the wizard

#### 4. Create OAuth Credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth Client ID**
3. Application type: **Desktop app**
4. Name: e.g., "Craft Agent Desktop"
5. Click **Create**
6. Note the **Client ID** and **Client Secret**

#### 5. Configure in Craft Agent

When setting up a Google source (Gmail, Calendar, Drive, YouTube, Search Console, etc.), add these fields to your source's `config.json`:

```json
{
  "api": {
    "googleService": "gmail",
    "googleOAuthClientId": "your-client-id.apps.googleusercontent.com",
    "googleOAuthClientSecret": "your-client-secret"
  }
}
```

Or simply tell the agent you want to connect Gmail/Calendar/Drive - it will guide you through entering your credentials.

#### Security Notes

- Your OAuth credentials are stored encrypted alongside other source credentials
- Never commit credentials to version control
- For production use, consider getting your OAuth consent screen verified by Google

## Supported LLM Providers

Craft Agents supports multiple ways to connect to LLM providers:

### Direct Connections

| Provider | Auth | Notes |
|----------|------|-------|
| **Anthropic** | API key or Claude Max/Pro OAuth | Direct Claude connection via the Claude Agent SDK |
| **Google AI Studio** | API key | Gemini models with native Google Search grounding built in |
| **ChatGPT Plus / Pro** | Codex OAuth | Sign in with your ChatGPT subscription — uses OpenAI's Codex models |
| **GitHub Copilot** | OAuth (device code) | One-click authentication with your Copilot subscription |

### Third-Party & Self-Hosted Providers

Additional providers are supported through the **Claude / Anthropic API Key** connection by choosing a custom endpoint:

| Provider | Endpoint | Notes |
|----------|----------|-------|
| **OpenRouter** | `https://openrouter.ai/api` | Access Claude, GPT, Llama, Gemini, and hundreds of other models through a single API key. Use `provider/model-name` format (e.g. `anthropic/claude-opus-4.7`). |
| **Vercel AI Gateway** | `https://ai-gateway.vercel.sh` | Route requests through Vercel's AI Gateway with built-in observability and caching. |
| **Ollama** | `http://localhost:11434` | Run open-source models locally. No API key required. |
| **Custom** | Any URL | Any OpenAI-compatible or Anthropic-compatible endpoint. |

### Architecture

Craft Agents uses two agent backends:

- **Claude** — powered by the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which natively supports custom base URLs and provider routing. Anthropic API key, Claude Max/Pro OAuth, and all third-party endpoints use this backend.
- **Pi** — powered by the Pi SDK, which handles Google AI Studio, ChatGPT Plus (Codex OAuth), GitHub Copilot OAuth, and OpenAI API key connections. Pi connections route through their own provider infrastructure.

## Configuration

Configuration is stored at `~/.craft-agent/`:

```
~/.craft-agent/
├── config.json              # Main config (workspaces, LLM connections)
├── credentials.enc          # Encrypted credentials (AES-256-GCM)
├── preferences.json         # User preferences
├── theme.json               # App-level theme
└── workspaces/
    └── {id}/
        ├── config.json      # Workspace settings
        ├── theme.json       # Workspace theme override
        ├── automations.json  # Event-driven automations
        ├── automations-history.jsonl # Automation execution history
        ├── messaging/        # messaging/config.json and bindings
        ├── sessions/        # Session data (JSONL)
        ├── sources/         # Connected sources
        ├── skills/          # Custom skills
        └── statuses/        # Status configuration
```

### Automations

Automations let you automate workflows by triggering actions when events happen — labels change, sessions start, tools run, or on a cron schedule.

**Just ask the agent:**
- "Set up a daily standup briefing every weekday at 9am"
- "Notify me when a session is labelled urgent"
- "Track permission mode changes and summarise them"
- "Every Friday at 5pm, summarise this week's completed tasks"

Or configure manually in `~/.craft-agent/workspaces/{id}/automations.json`:

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "cron": "0 9 * * 1-5",
        "timezone": "America/New_York",
        "labels": ["Scheduled"],
        "actions": [
          { "type": "prompt", "prompt": "Check @github for new issues assigned to me" }
        ]
      }
    ],
    "LabelAdd": [
      {
        "matcher": "^urgent$",
        "actions": [
          { "type": "prompt", "prompt": "An urgent label was added. Triage the session and summarise what needs attention." }
        ]
      }
    ]
  }
}
```

**Prompt actions** create a new agent session with a prompt. They support `@mentions` for sources and skills, and environment variables like `$CRAFT_LABEL` and `$CRAFT_SESSION_ID` are expanded automatically.

**Supported events:** `LabelAdd`, `LabelRemove`, `PermissionModeChange`, `FlagChange`, `SessionStatusChange`, `SchedulerTick`, `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, and more.

#### 定时任务与托管脚本

- **定时任务（`SchedulerTick`）** 使用 cron 表达式和时区触发，可在 UI 中查看启用状态、执行历史和最近一次运行时间。
- **托管脚本（`HostedScriptTick`）** 由 AI 或用户生成 JavaScript 脚本，按秒、分钟或小时配置轮询间隔；脚本返回 truthy 值时才会继续触发动作。
- 脚本运行在隔离 VM 中，默认不能访问 `require`、文件系统、`process` 或网络；可使用 `input`（包含工作区、时间戳和 metadata）与 `metadata` 读取上下文。
- 脚本可配置超时时间和 JSON 附加信息。附加信息会传入脚本上下文，并随 `scriptInfo` 进入后续自动化事件，便于携带服务名、检查结果或外部资源标识。
- 自动化动作支持独立设置模型提供商/连接、模型、思考级别和权限运行模式；未填写时继承工作区默认值。
- 自动化详情页会展示触发类型、间隔、脚本超时、附加信息及动作级运行时配置。

示例（托管脚本返回对象即触发）：

```json
{
  "event": "HostedScriptTick",
  "matchers": [
    {
      "name": "check-service",
      "script": "return { healthy: metadata.expected === 'ok', checkedAt: Date.now() }",
      "intervalMs": 60000,
      "scriptTimeoutMs": 5000,
      "scriptMetadata": { "service": "example-api", "expected": "ok" },
      "actions": [
        {
          "type": "prompt",
          "prompt": "检查服务状态并通知我异常原因",
          "llmConnection": "openai-main",
          "model": "gpt-5",
          "thinkingLevel": "medium",
          "mode": "ask"
        }
      ]
    }
  ]
}
```

See the [Automations section above](#automations) for the community edition reference.

## Advanced Features

### Large Response Handling

Tool responses exceeding ~60KB are automatically summarized using Claude Haiku with intent-aware context. The `_intent` field is injected into MCP tool schemas to preserve summarization focus.

### Deep Linking

External apps can navigate using `craftagents://` URLs:

```
craftagents://allSessions                      # All sessions view
craftagents://allSessions/session/session123   # Specific session
craftagents://settings                         # Settings
craftagents://sources/source/github            # Source info
craftagents://action/new-chat                  # Create new session
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | [Bun](https://bun.sh/) |
| AI | [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| AI (Pi) | Pi SDK agent server |
| Desktop | [Electron](https://www.electronjs.org/) + React |
| UI | [shadcn/ui](https://ui.shadcn.com/) + Tailwind CSS v4 |
| Build | esbuild (main) + Vite (renderer) |
| Credentials | AES-256-GCM encrypted file storage |

## Troubleshooting

### Debug Mode

To launch the packaged app with verbose logging enabled, use `-- --debug` (note the double dash separator):

**macOS:**
```bash
/Applications/Craft\ Agents.app/Contents/MacOS/Craft\ Agents -- --debug
```

**Windows (PowerShell):**
```powershell
& "$env:LOCALAPPDATA\Programs\@craft-agentelectron\Craft Agents.exe" -- --debug
```

**Linux:**
```bash
./craft-agents -- --debug
```

Logs are written to:
- **macOS:** `~/Library/Logs/@craft-agent/electron/main.log`
- **Windows:** `%APPDATA%\@craft-agent\electron\logs\main.log`
- **Linux:** `~/.config/@craft-agent/electron/logs/main.log`

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

### Third-Party Licenses

This project uses the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which is subject to [Anthropic's Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms).

### Trademark

"Craft" and "Craft Agents" are trademarks of Craft Docs Ltd. See [TRADEMARK.md](TRADEMARK.md) for usage guidelines.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

### Local MCP Server Isolation

When spawning local MCP servers (stdio transport), sensitive environment variables are filtered out to prevent credential leakage to subprocesses. Blocked variables include:

- `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (app auth)
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
- `GITHUB_TOKEN`, `GH_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `STRIPE_SECRET_KEY`, `NPM_TOKEN`

To explicitly pass an env var to a specific MCP server, use the `env` field in the source config.

To report security vulnerabilities, please see [SECURITY.md](SECURITY.md).
