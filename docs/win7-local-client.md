# Win7 x64 本地版（原版 UI）

这不是远程客户端：TokenBird 的会话管理、Pi Agent 子进程、权限检查和文件工具都在本机运行，不需要另一台 TokenBird 服务器。使用云模型时仍需要网络和 API Key；安装包不含离线大模型。

当前原生交互安装修复版：`apps/win7-local/release/TokenBird-Win7-Local-OriginalUI-Tools-26.10.8-interactive.2-x64-Setup.exe`。旧版合集包保留。

未签名。构建完成后，安装包同目录的 `.exe.sha256` 文件记录该产物的 SHA-256。之前的简易配置实验版安装包保留，不覆盖。

2026-10-08 旧版合集包：544,731,218 字节（约 519.5 MiB），SHA-256：`e266e914fd61a84ab26410a7371ef3c31d24f8c00d0305111bcb3bf9a710b321`。新交互安装版校验值见相邻 `.sha256` 文件。

旧版 26.9.28 产物保留：116,848,660 字节（约 111.4 MiB）。其 SHA-256：

```text
fd684ff7730341d4f9af439bee183ce3cbdc2a52d1a422cbef33e7c583d20bce
```

复用原版 React App、首次配置向导、聊天、设置、工作区、来源、技能和 Studio 页面。不再启动独立的简易 API 表单，也不加载移动端控件。改动集中于 Electron 22 / Node 16 兼容层和本地桌面桥接；不代表所有高级功能已经获得 Win7 兼容认证。

## 使用

1. 在 Win7 SP1 x64 上安装并启动。安装包未签名；请确认来自自己的构建，首次启动先使用测试目录。
2. 安装程序的「可选外部工具」页可选择部分工具，全部不勾选即跳过；详细要求见下节。启动后按原版首次配置向导操作。API 配置选「其他提供商 → API Key」；使用代理时选 Custom，填写 Endpoint、协议和模型。OpenAI-compatible Chat Completions 与 Anthropic-compatible Messages 均可由本机 Pi 后端运行。没有 Git Bash 时会显示原版安装提示，请使用明确支持 Win7 的版本（不要直接安装最新 Git）。
3. 完成后进入原版工作区，首次使用会显示原版使用引导。工作目录在「设置 → 工作区」中选择；文件和目录选择使用 Windows 原生对话框。Ask 模式会在修改文件前确认；Explore/safe 模式会阻止写入。
4. 修改连接使用原版「设置 → AI」页面，也可以按 Ctrl+,。支持原版多连接配置，不再限定为一个 `win7-local-api` 连接。改变模型后建议新建会话，改变 API 地址时请重新检查凭据。

会话与配置独立存放于 `%APPDATA%\TokenBird-Win7-Local`，不会读取或覆盖普通 TokenBird / Win7 Remote 的配置。API Key 保存在使用 Windows safeStorage 保护主密钥的加密凭据库中，不写入 URL 或明文配置。备份可复制这个独立目录；移到另一台电脑/Windows 用户后可能需要重新填写 Key。

## 可选离线依赖安装

2026-10-08 已同步 `origin/TokenBird` 到 `1683f2ed`，保留本地 Win7 适配，并带入新版 Super Agent、Studio 和设置页面。合集包包含根目录 `win7_dependencies` 的全部六个文件，不在线下载第三方工具。

| 文件/工具 | 安装方式与兼容提醒 |
| --- | --- |
| Git 2.46.2 x64 | 打开原生安装向导；包含 Git Bash，路径/PATH 由原向导选择。 |
| Python 3.8.10 x64 | 打开原生安装向导；Python 3.8 是支持 Win7 的最后一代，仍需系统运行库与补丁。 |
| Oracle JDK 21.0.12 x64 | 原文件签名为 Oracle，**官方不支持 Win7**；默认不选，选择后需再次确认风险。 |
| Node.js 18.16.0 x64 ZIP | 自选父目录，解压到 `node-v18.16.0-win-x64`；**官方不支持 Win7**，没有因本次打包而获得兼容修复。 |
| MinGW-w64 GCC 16.2 UCRT 7z | 自选父目录，解压到 `mingw64`；PATH 对应其 `bin`。UCRT/具体二进制需 Win7 真机验证，KB3080149 不能替代 UCRT 补丁（如 KB2999226）。 |
| KB3080149 x64 MSU | 可选遥测相关更新，**不是必需运行库补丁**；调用系统 `wusa.exe`，不强制重启，不适用/已安装会按返回码报告。 |

- 默认全部不选，静默安装也不会自动安装第三方工具。所有文件在安装器内只保存一份，不放入 ASAR；跳过依赖时不释放依赖载荷。
- Git/Java/Python EXE 显式使用 `WindowStyle=Normal` 打开原生安装向导，不传 `/quiet`、`/passive`、`/silent` 等静默参数，即使外层 PowerShell 隐藏也不隐藏这些工具。EXE 以当前用户普通打开，由其自身清单/向导按需要请求 UAC，不再外层强制管理员身份，避免 Python 的用户安装进入另一个管理员配置。MSU 由原生 `wusa` 交互处理并请求 UAC。用户可以取消；一个工具失败不会阻止其他工具及 TokenBird 本体安装。
- Node/MinGW 分别提供目录浏览与「添加到当前用户 PATH」选项；默认不修改 PATH。已有同名工具目录会被拒绝，需选择新目录，不覆盖用户已有工具。
- PATH 使用 .NET 注册表接口追加并去重，保留已有值和注册表类型，不使用可能截断/展开变量的 `setx`，不修改系统 PATH。更改后建议重新登录或重启；安装器不主动重启 Windows。
- 安装前校验每份载荷及 7-Zip 的 SHA-256；构建时检查压缩包目录布局，拒绝路径越界和链接。每个工具先在目标目录内独立暂存，解压成功后才移动到最终子目录。
- 软件记录解压位置。首次启动时导入未被用户设置过的 Node/Python/Java 路径和 Git Bash 路径，同时向本应用子进程注入工具 PATH；即使没勾选用户 PATH，TokenBird 仍可找到已记录的工具。原生安装器非标准注册位置可在原版设置页手动指定。
- 日志：`%APPDATA%\TokenBird-Win7-Local\dependency-install.log`；新增 OS/SP/PowerShell/进程位数、显示模式、启动参数及十进制/十六进制退出码。Python 以 `/log` 开启完整交互式详细日志，文件为同目录 `python-setup.log` 及其附属 MSI 日志。用户虚拟机旧日志显示所有所选工具在 SHA-256 清理阶段因 `SHA256Managed.Dispose()` 不存在而失败，安装器未运行；`interactive.2` 改用 .NET 3.5 支持的公开 `Clear()` 并增加旧 API 表面回归测试。该修复不是系统补丁修复，不自动安装未提供的补丁；原生工具在 Win7 上的后续安装结果仍需复测。路径记录：同目录 `installed-tools.ini`。再次安装保留以前记录；已有设置不会被强制替换。卸载 TokenBird **不卸载这些外部工具，也不撤销外部工具 PATH**。
- 集合包保留提供的安装文件，但不能把官方不支持 Win7 的 Node/JDK 变成兼容版本。软件内置 Electron 22 / Node 16 不依赖这些外部版本，也不会被它们替换。

## 适配范围

- 核心目标：本地会话、模型流式回复、Pi 本地文件读取/写入/编辑/目录查看、Ask 权限确认和 safe 模式写入拦截。
- 桌面桥接：文件/目录对话框、拖放文件路径、新窗口、工作区窗口、菜单和快捷键、分层关闭窗口、系统主题、系统通知、保持唤醒、技能文件打开、聊天导出与思维导图本地读写。
- 本体不包含现代 Bun、Claude Code 原生二进制或普通桌面自动更新程序；外部 Node/Git/Python/Java/MinGW 通过上述独立可选安装流程提供。
- Claude Code / 原生 Codex 后端不支持，会明确提示；Claude API Key 配置会转为 Pi 兼容协议。不能开启尚未适配的原生浏览器自动化；自动更新不能安装普通新版桌面包，请手动更新 Win7 专用安装包。
- 来源、TokenNest、ChatGPT OAuth 的本地浏览器/回调桥接已接上，但没有使用真实账户验证登录。新版 Studio 画布客户端能力与原生文件保存已接上，充值复用原版隔离窗口；真实充值和完整 Agent 画布生成流程未验证。消息平台、第三方 MCP、跨服务器协作等高级链路不作为本版的兼容承诺，保留原页面并不等于已验证所有功能。
- `bash` 工具可使用选装 Git 的 Git Bash，不能使用最新 Git 替代。`grep`/`find` 仍需要自行安装支持 Win7 的 `rg`/`fd` 并加入 PATH；提供的六份依赖不含它们。自动下载工具已关闭，避免引入不支持 Win7 的新二进制。
- Python 为可选安装，不含额外 pip 包或 Python 文档工具的全部依赖；第三方 MCP、扩展和用户安装的命令可能有各自的系统要求。
- 不再强制关闭连接的图片支持；保留原版连接配置。图片、多媒体和第三方插件仍需分别验证。

## 构建

在现代 Windows 构建机上使用仓库的 Bun/Node 工具链（目标 Win7 不需要安装它们）：

```powershell
bun install --ignore-scripts
bun run win7:local:build
bun run win7:local:dist
```

`--backend-only` 只重建本地运行层；`--reuse-ui` 使用此前已经生成的本地兼容 UI。默认构建会重新生成 UI，不依赖远程客户端的输出。

制作合集包时必须提供 `installer/dependencies.json` 对应的六份离线文件；缺失或包含未配置的新文件会让构建失败，避免悄悄漏打包。构建会暂存并生成哈希清单，NSIS 通过 `installer/dependencies.nsh` 加入自定义页面和载荷。完成后可运行 `bun run scripts/verify-win7-installer.ts` 核对最终 EXE 的六份原始载荷及 x64 本体，并生成相邻 `.sha256` 文件。

本地包使用 Electron 22.3.27 / Chromium 108 / 内置 Node 16.17.1。兼容处理仅在此构建中生效，包括 HTTP/stream/crypto/AbortSignal 补充、Unicode-set 正则转译、旧运行时的 glob 替代和 Electron Node 模式子进程启动。正常桌面包的 Electron、Bun 与 SDK 版本保持不变。

运行验证脚本时必须清空 `ELECTRON_RUN_AS_NODE`，并使用 Electron 22：

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
node scripts/run-win7-local-smoke.cjs
node scripts/run-win7-local-smoke.cjs --packaged-app
```

测试使用独立临时目录与本机模拟模型 API，不需要用户账户或远程 Agent 服务器。前端复用了 Win7 Remote 的 Chromium 108 颜色兼容方案。

已在构建机的 Electron 22 / Node 16 上，针对开发目录和打包后的 ASAR 应用分别验证 OpenAI-compatible / Anthropic-compatible 两种协议：流式回复、Write/Read/Edit/Ls 工具、含中文/空格路径、Ask 授权、safe 模式写入拦截、操作系统保护的凭据库，以及退出后重新启动时恢复会话和凭据。应用本体 PE 架构为 x64（`0x8664`）。这些测试不是 Win7 真机测试。

依赖逻辑新增 7 项自动测试：全部跳过、全选干运行（绝不运行原生安装器）、中文空格目录、PATH 去重/应用内查找、拒绝覆盖、单项失败后继续、拒绝被篡改载荷。纯 PATH 测试检查长值、变量保留、大小写/引号去重和超长拒绝，不修改构建机注册表。独立 NSIS 空安装向导实际验证默认跳过、两种工具目录页、PATH 默认关闭和返回导航；也打开正式安装包核对选择页后关闭，未点击安装。真实 Node ZIP / MinGW 7z 已在独立中文临时目录解压，验证路径记录和 x64 PE 后清理，未执行其中二进制或修改 PATH。最终 EXE 逐字节核对六份依赖与提取器/脚本完整载荷，ASAR 中没有重复依赖或旧版简易设置页。所供 EXE/MSU 的实际安装和 Win7 运行结果仍未验证。

原版 UI 版本额外检查首次配置页和原版设置菜单、多窗口创建/关闭、通知设置读取、文件选择桥接（对话框返回值由测试桩控制）、Chromium 真实 File 的绝对路径传递、思维导图本地写入/读取/删除，以及 Markdown、Word、PDF、PNG 基本聊天导出。测试没有替换原版页面组件；模型服务使用本机模拟 API。没有覆盖每个页面按钮、真实 OAuth 账户、超长 PNG 或全部高级功能。

## 验证边界与风险

即使本地自动测试全部通过，也只证明旧运行时上的功能链路；**尚未在真实 Win7 或 Win7 虚拟机上验证**。Win7 上的系统补丁、运行库、TLS 和具体硬件问题需真机测试。请把启动失败提示/截图和操作日志反馈后再进一步适配。

Electron 22、Node 16 与 Win7 均已停止常规维护。本版不能视为安全更新完整的生产版本，仅建议在隔离、受控环境中测试；不要打开不可信项目、扩展或网页。
