# 接入原生智能体

首批支持 Codex、Pi、Claude Code、Hermes、DeepSeek Harness（DSH）。现有数据源、页面、会话、偏好、技能、浏览器和 Super Agent 编排继续由词元鸟提供，各后端保留自己的推理循环。

在 **设置 → AI → 后端框架** 展开所需框架，本机缺失时点击“一键下载安装”。可选择官方源或国内 npm/PyPI 镜像，安装成功后自动验证并填写位置，再在模型连接中选择后端。也可以填写已有运行程序的位置。配置属于运行智能体的服务器，桌面、远程 Web 工作台共享同一目录。

安装使用词元鸟独立目录 `runtime/frameworks/<框架>/<安装 ID>`；失败或取消保留当前配置，成功验证后才切换位置。下载过程不继承模型凭据、用户 npm 配置或 Git 认证，不修改系统智能体配置。每个框架可分别重新安装，旧环境保留，便于仍在执行的会话继续使用。

固定验证版本：Codex 0.154.0、Claude Agent SDK 0.3.258（原生程序 2.1.258）、Pi 0.85.1、DSH SDK 0.1.5rc1、Hermes 提交 `dce1e9b37581dd62e480a9064dc04a709c2940d3`。Python 环境使用 3.14.7，通过 uv 0.13.0 获取；uv 下载校验官方 SHA-256，Hermes 校验提交。Pi 使用匹配的词元鸟 Pi 服务；Windows 原生工具使用软件携带的 Git Bash。

## Hermes

提供了 `apps/electron/resources/scripts/agent-plugins/hermes_bridge.py` 和 `hermes.manifest.example.json`。

1. 点击一键下载安装，或准备兼容版本的 Hermes checkout 及 Python 环境。桥接器使用 `run_agent.AIAgent`、原生 tools registry 和 SessionDB。
2. 在设置中填写该环境的 Python 路径和项目目录。手工配置时使用 `tokenbird:bridge:hermes`，宿主会解析当前安装中的脚本路径。
3. 使用 DeepSeek 或 OpenAI Chat Completions 兼容模型连接，保存配置，选择 Hermes。

Hermes 保留原生推理循环、工具执行器、工具发现、技能、项目指令、记忆、后台复盘和上下文压缩。词元鸟的工具与数据源追加到其原生 registry，原生工具执行前接入宿主审批。共享用户偏好补充到原生系统提示词。设置中可切换原生项目指令、技能、记忆和工具集；文件工具可选择原生、宿主或关闭。`HERMES_HOME` 为词元鸟管理的连接级目录，允许同连接跨会话共享原生记忆，SessionDB 保存会话和工具历史。

原生会话恢复读取 SessionDB 的完整工具历史与压缩记录；执行中追加指令调用原生 `steer()`。图片转为原生多模态消息，能否理解图片取决于所选模型。标题和辅助推理仍可由宿主补充。Hermes 内部 API 可能随版本变化，安装器固定上述经过验证的提交；实际安装版本已通过本地确定性模型服务测试原生文件工具、原生工具发现、共享数据源、偏好和进程重启恢复，没有调用生产模型。

## DeepSeek Harness（DSH）

接入 [DeepSeek 官方 Harness](https://github.com/deepseek-ai/deepseek-harness)，使用官方 Python SDK 及其匹配的原生运行时。

1. 点击一键下载安装，或在独立 Python 环境安装 `deepseek-harness-sdk==0.1.5rc1`。
2. 在设置的“后端框架”中展开 DeepSeek Harness，填写这个环境的 Python 程序路径，并点击“测试有效性”。也可使用 `dsh.manifest.example.json`，其 `tokenbird:bridge:dsh` 自动指向当前安装中的桥接器。
3. 选择 DeepSeek 连接，或配置 Chat Completions 兼容的 API 端点和模型，再选择 DeepSeek Harness 后端。

桥接器使用独立 `DSH_HOME` 和完整 `sdk` 配置，保留原生工具、插件、身份提示、上下文管理、会话日志与技能能力。宿主共享工具通过 Cordis 插件追加，原生工具执行前通过 `tools/pre-execute` 接入词元鸟审批，执行仍由 DSH 完成；原生工具过程显示在现有聊天页面。可配置原生 profile，文件与命令工具选择宿主或关闭时禁用对应原生工具插件。模型凭据只传给该连接的 API 端点，数据源凭据留在宿主连接池。

SDK 0.1.5rc1 的 SDK 入口不能重新打开已持久化的原生会话，因此不声明原生恢复能力。进程内连续对话由 DSH 维护；重启后，以及工具目录、模型或配置变化时，用可见对话恢复到新原生会话。支持原生思考参数和图片消息，流中引导尚未适配。SDK 冻结原生工具参数，宿主要求修改参数时返回拒绝及重试参数，避免执行未经批准的原始参数。该 SDK 处于开发预览阶段，其他版本会提示明确错误。

已用真实 Windows DSH 原生运行时和本地确定性模型服务验证原生文件写入、拒绝执行、共享工具、偏好和历史恢复；这项验证没有调用生产模型 API。

Hermes 的原生会话计数和 DSH 的原生模型事件会把每轮输入、输出及缓存 Token 用量传回现有会话统计。仅上报框架实际提供的数据，不估算缺失的用量或费用。

## 任意后端的桥接协议 v1

启动命令直接执行，不经过 shell。stdin/stdout 使用逐行 UTF-8 JSON-RPC 2.0；日志写 stderr。每帧最大 4 MiB，进程退出、错误输出和请求超时结束当前会话轮次。用户停止会终止插件进程及其子进程。

| 方法 | 方向 | 用途 |
| --- | --- | --- |
| `initialize` | 宿主 → 插件 | 协商协议与能力，传递连接描述、隔离目录、会话身份、可见历史及显式授权的连接凭据 |
| `agent/chat` | 宿主 → 插件 | 原生推理；接收模型、思考强度、系统提示词、动态上下文、附件与宿主工具列表 |
| `agent/event` | 插件 → 宿主通知 | `{ turnId, event }`；流式文本、工具记录、用量与完成事件 |
| `host/tool` | 插件 → 宿主请求 | `{ turnId, toolName, input }`；由词元鸟审批并执行共享工具 |
| `host/authorize` | 插件 → 宿主请求 | 原生工具执行前审批；返回 `{ allowed, input, reason? }`，必须使用返回的参数 |
| `agent/steer` | 宿主 → 插件通知 | 声明 steering 能力后才接收流中引导 |
| `agent/query` | 宿主 → 插件 | 声明 utilityCompletion 能力后接收无工具辅助推理，返回 `{ text, model?, inputTokens?, outputTokens? }` |

`initialize` 返回 `{ protocolVersion: 1, capabilities: [...], sessionId?: string }`。能力必须与清单匹配。清单启用 `useConnectionCredentials` 后，宿主只传递当前连接的 API key 或有效 OAuth access token，刷新令牌不传出；自动继承的环境只包含基本运行路径。其他认证可由明确配置的插件环境管理。

`agent/chat` 的请求 ID 用于 JSON-RPC 响应，`params.turnId` 用于流与工具调用。必须在最后事件之后回复该请求，返回 `{ sessionId?: string }`。旧轮次的迟到通知不会混入新轮次。工具列表中 `name` 与 `inputSchema` 是宿主标准；桥接器可以映射成本后端合法的函数名称，但 `host/tool` 必须还原原名。

示例通知：

```json
{"jsonrpc":"2.0","method":"agent/event","params":{"turnId":"host-turn-id","event":{"type":"text_delta","text":"你好"}}}
```

已有 Pi、Claude Code、Codex 插件保持各自行为。Codex 对第三方连接仍使用明确的兼容运行时，外部插件不参与这条凭据选择逻辑。

## 偏好迁移

偏好 JSON 包使用 `format: tokenbird-agent-profile`、`version: 1`。导出用户身份、时区、位置、备注、共同署名设置、可编辑系统指令、能力开关、默认思考强度及工作空间偏好提示词。导入先验证全部数据，再更新已有存储；同 ID 的工作空间指令合并，其他工作空间配置保留。

也可导入 AGENTS.md、CLAUDE.md、SOUL.md 或任意纯文本指令。内容以工作空间偏好保存，重复导入相同内容不会重复创建。自由文本完整保留，请在界面检查后应用。

模型凭据、OAuth grants、机器路径与代理连接设置不作为结构化偏好导出。原生后端隐藏状态和未完成工具执行不能跨后端迁移。

## 验证命令

```powershell
cd packages/shared
bun test ./src/agent-plugins/plugins.isolated.ts
cd ../server-core
bun test src/sessions/agent-runtime-migration.test.ts
cd ../..
python scripts/agent-plugins/test_hermes_bridge.py
# 使用安装目录的 Python，并设置 TOKENBIRD_HERMES_ROOT 到 Hermes 源码目录
python scripts/agent-plugins/test_hermes_native.py
# 在已安装 SDK 的 Python 环境验证真实 DSH 原生运行时（模型端点为本地 fixture）
python scripts/agent-plugins/test_dsh_bridge.py
```
