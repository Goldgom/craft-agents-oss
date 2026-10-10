# Windows 7 x64 远程客户端（实验版）

这是独立的 TokenBird 远程客户端，不是普通桌面版的 Win7 移植。它使用最后支持
Windows 7 的 Electron 22.3.27（Chromium 108 / Node.js 16），在本机加载打包的
Web UI，通过 WebSocket 连接已有 TokenBird 服务器。

## 安装和连接

安装包位于 `apps/win7-client/release/TokenBird-Win7-Remote-26.9.28-x64-Setup.exe`。
安装后的进程名为 `TokenBird-Win7-Remote.exe`，不会覆盖普通版 TokenBird。

1. 在 Windows 7 SP1 x64 上安装客户端。建议先安装系统更新和所需的 VC++ 运行库。
2. 打开应用，填写服务器的 `ws://` 或 `wss://` 地址（包括反向代理要求的路径）。
3. 填写服务器的 `CRAFT_SERVER_TOKEN`，不是模型 API Key。
4. 可选填写服务器工作区 ID；留空后在界面选择服务器工作区。
5. 点击“连接服务器”。按 `Ctrl+Shift+S` 可重新设置服务器。

令牌不会放进 URL，也不会默认保存到磁盘。勾选“记住令牌”时，通过 Electron
`safeStorage` 使用 Windows 加密保护保存；系统无法安全加密时会拒绝保存。
设置目录是 `%APPDATA%\TokenBird-Win7-Remote`。

`ws://` 没有传输加密，仅用于可信局域网或 SSH 隧道。公网使用 `wss://` 和受信任的
证书；客户端不会关闭证书验证。Win7 的系统根证书过旧也可能导致连接失败。

## 服务器

服务器需要运行匹配的 `TokenBird` 分支，部署在支持现代 Bun 的 Windows 10/11
或 Linux/macOS 上。例如，在服务器仓库目录运行：

```bash
bun install --frozen-lockfile
bun run server:build:subprocess
CRAFT_SERVER_TOKEN='替换为至少16字符的随机令牌' \
CRAFT_RPC_HOST=0.0.0.0 \
bun run server:start
```

服务器会打印实际 WebSocket 地址；默认端口是 `9100`。Windows 服务器可在
PowerShell 中先设置对应的 `$env:CRAFT_SERVER_TOKEN` 和 `$env:CRAFT_RPC_HOST`。
允许端口的防火墙访问；跨公网请配置 TLS、反向代理或 SSH 隧道。
界面资源已打进安装包，服务器不需要另外部署 Web UI。

先在服务器上配置好工作区、模型连接和需要 OAuth 的数据源，再用客户端连接。
所有 Agent、工作区文件和工具执行都在服务器端，不是在 Win7 本机。

## 从源码构建

构建机需要现代 Windows x64、Node.js、Bun 和已安装的项目依赖；不要在 Win7 上
运行当前仓库的构建工具链。

```powershell
bun install --frozen-lockfile
bun run win7:build   # 只生成客户端及前端资源
bun run win7:dist    # 生成 x64 NSIS 安装包，不上传、不发布
```

第一次打包会下载 Electron 22.3.27 和 NSIS 工具。网络受限时可按 Electron 下载器的
规范设置 `ELECTRON_MIRROR`。不能为了绕过下载失败而改用 Electron 23 或更新版本。

原有 `electron:dist:win`、Web UI 和 Android 的运行方式不变。
`win7` Vite 模式输出到独立目录，增加 JavaScript API 补齐和现代颜色函数的 RGB
兼容层，不改变普通版的 Electron 版本或安装包标识。

## 验证和限制

```powershell
bun test scripts/win7-client.test.ts
bun run webui:typecheck
```

可使用 Electron 22 运行 `apps/win7-client/smoke.cjs --remote-smoke-test`，测试本地
模拟服务器握手、加载会话与工作区、基础颜色和明暗切换。测试使用独立临时
设置目录，不读取或修改用户的普通版配置。

- 这是未签名的实验安装包，Windows 可能显示未知发布者警告。
- Electron 22 和 Win7 均已停止安全维护，不适合不可信网页或高风险使用。
- 不包含本地 Agent、Bun、Git Bash、Python、Node.js 工具链，不支持本地 shell。
- 本地文件夹选择、系统集成和客户端内的 OAuth 回调不具备普通桌面版能力。
  需要 OAuth 的连接请先在服务器或正常桌面版配置。
- 不自动更新，避免升级到不能在 Win7 运行的普通版。
- 旧 Chromium 对少数动态阴影、第三方主题、高级编辑器或文档预览可能仍有差异；
  默认明暗主题和基础聊天流程是本次试验的验证重点。
- 在新 Windows 上用 Electron 22 启动成功，不等于在 Win7 上已经验证。
  交付前后仍需在真实 Win7 SP1 x64 或虚拟机上验证安装、启动、服务器连接、
  收发消息、文件上传和重连。
