# 云服务器端

云服务器端是独立的 TokenBird 发布目标，承载共享聊天和设备远程访问；原有 agent 执行服务器仍负责本机工作区和模型调用。

## 编译

```powershell
bun run cloud-server:build                 # Linux x64 独立可执行文件 + WebUI + 部署文件
bun run cloud-server:build:linux-arm64     # Linux arm64
bun run build:all cloud-server            # 纳入统一编译与校验和
```

输出目录：`dist/cloud-server/`，压缩包名：`tokenbird-cloud-server-<version>-linux-<arch>.tar.gz`。包中带有运行时，不需要在服务器上另外安装 Bun 或模型 SDK。也可以使用 `Dockerfile.cloud` 构建容器。

## 部署

1. DNS 将 `agent.tokenbird.goldgom.top` 指向服务器，开放 TCP 80/443。
2. 解压到 `/opt/tokenbird-cloud`，建立 `tokenbird` 系统用户及 `data` 目录，并让此用户可读软件文件、可写 `data`。
3. 将 `deploy/cloud.env.example` 复制为 `deploy/cloud.env`，填入随机的 `TOKENBIRD_CLOUD_SERVICE_KEY`。TokenNest 使用相同密钥。保护此配置文件，仅运行用户可读。
4. 安装 Caddy，使用包内 `deploy/Caddyfile`。Caddy 自动签发 TLS 证书、处理 WebSocket 转发，并将 80 重定向到 443。后端监听 `127.0.0.1:8080`。
5. 安装 `deploy/tokenbird-cloud.service`，执行 `systemctl daemon-reload`、`systemctl enable --now tokenbird-cloud`。
6. 检查 `https://agent.tokenbird.goldgom.top/healthz`。备份 `data/cloud.sqlite`，运行中备份需使用 SQLite 在线备份，或停止服务后一起备份数据库和 WAL 文件。

`TOKENNEST_URL` 默认 `https://openai.goldgom.top`。修改域名时同步修改 Caddy 和 `TOKENBIRD_CLOUD_PUBLIC_URL`。生产客户端要求 HTTPS；HTTP 仅用于 localhost 联调。

## 应用使用

- 设置 → 服务器 → 云服务器端。默认服务器为 `https://agent.tokenbird.goldgom.top`（443；80 由网关重定向）。选择已登录的 TokenNest 连接，填写设备名，保存。
- 打开“启用云端远程访问”后，设备主动建立出站隧道，无需在路由器设置端口转发。无需同时开启原有局域网服务器模式；本机随机监听端口也可以转发。
- 在另一台设备的 TokenBird 中登录同一 TokenNest 账户，设置云服务器，保存后点击“刷新设备与共享记录”。可以通过浏览器或 TokenBird 连接在线设备。
- 浏览器访问适用于手机和平板。TokenNest 网站也可从设备记录中申请连接票据并打开同一页面，详见接口文档。
- 聊天标题菜单 → 共享聊天记录 → 发布快照。只上传用户及助手的最终聊天文字；不上传附件、工具调用、工具结果、工作区配置或凭据字段。用户写入聊天正文的秘密仍可能被分享，应在发布前检查。
- 共享链接是公开只读链接，持有链接即可阅读。服务器设置中可以查看及撤销共享。快照不随聊天自动更新，再次发布会创建新的链接。每个账户最多保留 100 个共享快照。
- 设备列表依据账户归属校验。网站撤销远程访问后，自动重连不会恢复访问，必须在主机设置中再次启用并保存。

## 远程模式提示词与请求文件

通过云端、直接远程服务器或远程工作区连接发起对话时，每一轮发给 AI 的上下文都会说明当前处于远程访问模式：AI 的普通文件和命令工具运行在会话主机，访问设备是另一套环境，不能直接套用访问设备的文件路径。

AI 可调用 `request_client_files`，填写用途说明，向发起本轮对话的访问设备请求文件。桌面端打开原生文件选择器；浏览器和 Android 显示用途与“选择并上传”按钮，由用户点击并选择文件。支持取消，最多 5 个文件，总大小不超过 8 MiB，不需要配置 SFTP。选中的文件上传至会话目录的 `data/client-files/`，工具只返回保存后的主机路径、文件名和大小，AI 可以继续读取或处理文件。

文件请求绑定到本轮发起连接，排队消息保留各自的连接身份。发起设备断开、不支持文件请求或用户取消时，不会改向其他设备请求文件。受限超级智能体节点不能通过该工具获取其环境外文件。请求最长等待 5 分钟。已有会话将在下一次发送消息时识别当前连接模式。

## 连接生命周期

临时连接票据有效期最多 10 分钟，已连接的客户端每次连接最多持续 1 小时，到期需要重新申请票据。TokenBird 远程配置中保存的是票据，长期使用或票据过期后从云设备列表重新连接。设备每 30 秒重新验证 TokenNest 登录并更新记录；断网/退出登录/授权失效后隧道断开，未收到有效心跳超过 90 秒时云端关闭访问。云服务重启后设备自动重连；所有临时票据失效，聊天快照和设备归属保留。

公网共享的是 TokenBird 的远程 WebSocket 服务，不支持任意 TCP 端口、SSH 或远程桌面。设备访问权限等同于操作该设备上的 TokenBird。

## TokenNest 配合

必须先实现 [TokenNest 云服务接口](tokennest-cloud-server-api.md) 中的账户校验和设备登记接口。当前仓库包含 TokenBird 及云服务代码；没有修改、部署或验证 TokenNest 生产服务。
