# TokenNest 需要实现的 TokenBird 云服务接口

## 1. 服务间认证

TokenNest 和云服务器配置相同的随机密钥 `TOKENBIRD_CLOUD_SERVICE_KEY`（至少 32 字符）。下述 `/api/internal/tokenbird/*` 接口仅允许 `Authorization: Bearer <service-key>`，使用恒定时间比较；不可接受普通用户 API key 或网站 Cookie 替代服务密钥。生产使用 HTTPS，可限制云服务器出口 IP。密钥及 `access_token` 不写入访问日志。

统一成功响应：`{"success":true,"data":{...}}`；失败使用对应 401/403/404/5xx，`{"success":false,"message":"..."}`。不要在错误中包含凭据。

## 2. 校验 TokenNest 登录

`POST /api/internal/tokenbird/identity`

请求：

```json
{"access_token":"TokenNest OAuth access token"}
```

响应：

```json
{"success":true,"data":{"subject":"user:123","expires_at":1791543600000}}
```

实现要求：

- 使用现有 OAuth grant 校验流程核验 access token 的哈希、到期时间、撤销状态、所属应用及用户状态。
- 仅接受已允许使用 TokenBird 云功能的客户端，例如当前原生应用 `tnc_craft_agents_community`。现有原生登录 scope 无需变更；不要因添加新 scope 影响现有登录。
- `subject` 为稳定、唯一的账户标识（如 `user:<数据库用户ID>`），所有设备、列表及连接操作使用它。不可相信请求传入的用户 ID。
- `expires_at` 是实际访问令牌过期时间，Unix **毫秒**。账号禁用、grant 撤销、token 无效时返回 401/403。
- 不返回 refresh token、模型 key、用户密码或其他隐私信息。

云端每次登记、列表、聊天共享及主机心跳均调用本接口，主机心跳间隔为 30 秒。可在 TokenNest 侧做几秒以内的撤销感知缓存。

## 3. 记录设备

`POST /api/internal/tokenbird/devices/upsert`

请求：

```json
{
  "subject":"user:123",
  "device":{
    "id":"550e8400-e29b-41d4-a716-446655440000",
    "name":"我的电脑",
    "online":true,
    "lastSeen":1791540000000,
    "wsUrl":"wss://agent.tokenbird.goldgom.top/v1/connect/550e8400-e29b-41d4-a716-446655440000"
  }
}
```

响应：`{"success":true,"data":{"ok":true}}`

建议表 `tokenbird_devices`：`device_id` 唯一、`user_id`、`name`、`cloud_server_url`、`ws_url`、`online`、`last_seen_at`、`updated_at`。按用户和更新时间建立索引。设备 ID 的归属一旦创建不得被另一个 subject 覆盖。

云服务在登记、连接、心跳及断开时更新记录。云服务器突然宕机不能发送离线事件：网站展示在线状态需同时满足 `online=true` 且 `lastSeen` 不超过 90 秒。连接申请仍由云端以当前隧道状态判定。

`wsUrl` 只允许配置中受信任的云服务器 origin 和 `/v1/connect/<device_id>` 路径，不将客户端提供的任意 URL 用作 HTTP 请求目标。记录中不存储设备本地密钥和连接票据。

## 4. 网站设备列表和连接按钮

TokenNest 新增“TokenBird 设备”页，使用当前网站登录用户读取此用户的设备记录。建议接口：

- `GET /api/tokenbird/devices`：当前用户的记录列表；未登录返回 401。
- `POST /api/tokenbird/devices/:id/connect`：验证网站登录、CSRF 和设备归属后，通过服务密钥向固定的云服务器请求连接票据。
- `POST /api/tokenbird/devices/:id/revoke`：验证网站登录、CSRF 和设备归属后，撤销此设备访问。

服务端请求云服务：

```http
POST https://agent.tokenbird.goldgom.top/v1/internal/devices/:id/connect
Authorization: Bearer <service-key>
Content-Type: application/json

{"subject":"user:123"}
```

云端直接返回：

```json
{
  "url":"wss://agent.tokenbird.goldgom.top/v1/connect/<device-id>",
  "token":"opaque-temporary-ticket",
  "browserUrl":"https://agent.tokenbird.goldgom.top/connect/<device-id>#ticket=<opaque-temporary-ticket>",
  "expiresAt":1791540600000
}
```

网站响应设置 `Cache-Control: no-store`，打开 `browserUrl` 即可。票据放在 URL fragment，不放在 query。页面加载后立即移除地址栏中的票据；浏览器不持有 TokenNest OAuth 凭据或设备本地密钥。已连接页面最多使用一小时，到期用户再次点击网站连接按钮。TokenBird 原生软件使用相同 RPC 隧道协议。

撤销请求使用同样的 body 和服务认证，地址为 `/v1/internal/devices/:id/revoke`。撤销立即关闭隧道与已连接客户端、清除该设备临时票据，设备自动重连会被拒绝。用户必须在主机上重新启用并保存才能恢复访问。

两种请求都必须由 TokenNest 后端发起，不将 `service-key` 给浏览器。subject 由网站会话解析，不接受前端自行填写。云端再次检查 subject 与设备归属。

## 5. 验收场景

1. A 账户启用设备，网站只在 A 的设备列表出现，记录的公网地址使用指定云域名。
2. B 账户无法列出、申请票据或连接 A 的设备。更改前端设备 ID 或 subject 不得越权。
3. A 在另一台设备登录网站，点击在线设备，通过浏览器操作主机 TokenBird；不需要主机公网 IP 或端口转发。
4. 软件关闭、网络断开或授权被撤销后，网站显示离线并拒绝新连接；心跳超时最多 90 秒。
5. 网站撤销访问会断开现有客户端；主机自动重连不能绕过撤销。
6. 分享聊天生成的链接可以公开读取，撤销后为 404；页面不会执行聊天中的 HTML/脚本。
7. 云服务重启保留设备归属、撤销状态和共享记录，原有临时票据失效。


## 远程访问设备请求文件

TokenBird 会在远程连接的提示词中说明服务端和访问设备的环境区别，并提供 `request_client_files` 工具。该工具通过现有云隧道的双向 RPC 向发起本轮消息的设备请求用户选择的文件，不需要 TokenNest 新增文件上传接口或读取用户主机文件。网站打开 TokenBird WebUI 后，WebUI 负责显示用途、文件选择按钮以及取消操作。上传文件最多 5 个、总计 8 MiB，仅保存到设备上的会话目录，不保存至 TokenNest 网站或云服务器数据库。
