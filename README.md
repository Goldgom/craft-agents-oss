# Craft Agents

Craft Agents 是一个开源的 Agent 工作平台。它把大模型、工具、资料和长期会话放在同一个工作区中，让你可以用自然语言完成研究、写作、编程、资料整理和自动化操作。

项目以 **Claude Code 式的 Agent 体验** 为基础，同时集成 Claude Agent SDK 与 Pi SDK。你可以在桌面应用中管理多个会话，也可以把 Agent 部署到远程服务器，通过 Web、命令行或消息平台使用。

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

## 核心功能

### 多会话工作区

- 用工作区隔离项目文件、来源、技能和凭据。
- 在收件箱中集中管理多个会话，支持标记、归档和自定义状态流转。
- 会话历史持久化保存，可随时继续工作、重命名或分享。
- Agent 回复和工具调用实时流式显示，执行过程清晰可见。

### 多模型与多种登录方式

可按连接或工作区选择模型，并在不同任务之间切换：

- Anthropic Claude（API Key，或 Claude Max/Pro OAuth）。
- OpenAI / ChatGPT（含 Codex OAuth）。
- Google AI Studio（Gemini）。
- GitHub Copilot OAuth。
- OpenRouter、Ollama 以及其他兼容 Anthropic 或 OpenAI 协议的自定义端点。

### 连接任意数据源和工具

Agent 可以通过统一的来源（Sources）访问外部服务：

- **MCP 服务器**：支持远程 HTTP/SSE 和本地 stdio 进程，可连接 Craft、GitHub、Linear、Notion 等服务。
- **REST / OpenAPI**：根据 API 文档、端点或 OpenAPI 规范配置自定义接口。
- **本地内容**：访问工作区文件、Git 仓库、Obsidian vault 等本地目录。
- **OAuth 服务**：可配置 Gmail、Calendar、Drive、YouTube、Slack、Microsoft 等集成。

你可以直接告诉 Agent“连接一个来源”，由它读取文档、引导认证并完成配置；已有 MCP JSON 也可以直接导入。

### 技能与可扩展 Agent

- 在工作区保存可复用的技能（Skills）和专属指令，让 Agent 掌握团队流程与领域知识。
- 支持从 Claude Code 导入技能和 MCP 配置。
- 可以用自然语言创建或修改技能，不需要手动维护复杂配置。
- 修改来源或技能后立即生效，无需重启应用。

### 安全可控的执行权限

每个会话都可以选择执行模式：

| 模式 | 说明 |
| --- | --- |
| 探索 | 只读模式，禁止写文件和其他修改操作 |
| 请求确认 | 执行修改前询问用户（默认） |
| 自动 | 自动批准操作，适合受信任的环境 |

权限规则可按工具和工作区定制。凭据使用加密存储，工作区之间相互隔离。

### 文件、文档和浏览器工具

- 拖放图片、PDF、Office 文档等附件，自动提取或转换内容。
- 支持 Markdown、代码高亮、数学公式、表格和差异对比。
- 提供多文件 diff 窗口，集中查看 Agent 在一轮对话中的所有改动。
- Agent 可在受控浏览器窗口中打开网页、操作页面、查看网络请求，并将浏览器作为工作流的一部分。

### 自动化与后台任务

- 长时间任务在后台运行，显示进度并可随时取消。
- 根据标签变化、定时计划、工具调用等事件自动创建会话或触发 Agent。
- 适合定期汇总、同步资料、监控项目和批量处理等场景。

### 多种运行方式

同一套 Agent 能力可通过不同入口使用：

- **Electron 桌面端**：功能完整的图形界面，适合日常工作。
- **Web UI**：连接无头服务器，在浏览器中访问会话。
- **无头服务器**：部署在 VPS、局域网或 Docker 中，保持会话长期运行。
- **CLI 客户端**：通过 WebSocket 操作工作区和会话，支持脚本、CI/CD 及流式输出。
- **消息网关**：可将 Agent 接入 Telegram、WhatsApp 等消息渠道（具体渠道取决于部署配置）。
- **会话分享与查看器**：将会话记录上传并以只读网页分享。

## 快速开始

### 直接安装桌面应用

macOS / Linux：

```bash
curl -fsSL https://thecraftagents.com/install-app.sh | bash
```

Windows PowerShell：

```powershell
irm https://thecraftagents.com/install-app.ps1 | iex
```

启动后，选择一个模型连接，创建工作区即可开始对话。来源和技能均为可选配置。

### 从源码运行

需要 [Bun](https://bun.sh/)（建议使用仓库锁定的最新稳定版本）：

```bash
git clone https://github.com/lukilabs/craft-agents-oss.git
cd craft-agents-oss
bun install
bun run electron:dev
```

常用命令：

```bash
bun run electron:dev       # Electron 开发模式
bun run electron:start     # 构建并启动桌面端
bun run webui:dev          # Web UI 开发服务器
bun run server:start       # 启动无头服务器
bun run typecheck:all      # 全量类型检查
bun test                   # 运行测试
```

### 使用 CLI

CLI 位于 `apps/cli`，可以连接已有服务器，也可以由 `run` 命令自动启动本地服务器：

```bash
# 自包含运行：启动服务器、创建会话、输出流式结果后退出
bun run apps/cli/src/index.ts run "总结当前仓库的结构"

# 连接已有服务器
export CRAFT_SERVER_URL=ws://127.0.0.1:9100
export CRAFT_SERVER_TOKEN=<你的令牌>
bun run apps/cli/src/index.ts sessions
bun run apps/cli/src/index.ts send <会话ID> "列出待处理事项"
```

执行 `bun run apps/cli/src/index.ts --help` 查看完整命令，包括工作区、来源、模型、输出格式、取消任务和服务器验证。

## 远程服务器

无头服务器使用 WebSocket 与桌面端、Web UI 或 CLI 通信。适合把会话和工具放在一台持续运行的 Linux 机器上：

```bash
CRAFT_SERVER_TOKEN=$(openssl rand -hex 32) \
CRAFT_RPC_HOST=0.0.0.0 \
bun run packages/server/src/index.ts
```

服务器启动时会打印 `CRAFT_SERVER_URL` 和令牌。跨公网使用时请启用 TLS（`wss://`），或放在 nginx / Caddy 等反向代理之后。也可以使用仓库提供的 `Dockerfile.server` 构建容器。

常用环境变量：

| 变量 | 作用 |
| --- | --- |
| `CRAFT_SERVER_TOKEN` | 客户端认证令牌（必填） |
| `CRAFT_RPC_HOST` | 监听地址，默认 `127.0.0.1` |
| `CRAFT_RPC_PORT` | 监听端口，默认 `9100` |
| `CRAFT_RPC_TLS_CERT` / `CRAFT_RPC_TLS_KEY` | 启用 TLS 的证书和私钥 |
| `CRAFT_DEBUG` | 开启调试日志 |

详细的服务器构建、Docker、TLS 和部署说明见 [`docs/build-guide.md`](docs/build-guide.md)，CLI 参考见 [`docs/cli.md`](docs/cli.md)。

## 项目结构

```text
apps/
  electron/       Electron 桌面应用
  webui/          浏览器端工作区界面
  viewer/         会话分享与查看器
  cli/            命令行客户端
  android/        Android 客户端相关工程
packages/
  shared/         Agent、认证、来源、会话等共享业务逻辑
  server/         Bun 无头服务器
  server-core/    可复用的服务器与 RPC 基础设施
  core/           类型、存储和核心 Agent 逻辑
  ui/             共享 React UI 组件
  messaging-*     Telegram、WhatsApp、QQ 等消息渠道适配
```

## 配置与安全

- API Key、OAuth Token 和来源凭据保存在本地加密存储中。
- 不要将 `.env`、令牌或 OAuth 密钥提交到版本库；可复制 [`.env.example`](.env.example) 作为开发配置模板。
- 远程部署请使用强随机令牌，并通过 TLS 保护 WebSocket 连接。
- 生产部署和自定义 OAuth 的具体步骤请参考 [`docs/`](docs/) 中的文档。

## 参与贡献

欢迎提交 Issue、改进代码和补充文档。请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 和 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。

Craft Agents 以 Apache License 2.0 发布，详见 [`LICENSE`](LICENSE)。
