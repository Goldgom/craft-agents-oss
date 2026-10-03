# TokenNest 应用内充值接口约定

TokenBird 客户端已按下述约定接入。桌面端将一次性 URL 打开在独立、无 Node.js 和应用 preload 的充值窗口；窗口关闭后重新查询现有余额接口。旧部署返回 404 时回退到 `/wallet` 并提示可能需要网页登录。

## 1. 创建充值会话

```http
POST /api/oauth2/recharge-session
Authorization: Bearer <OAuth access token>
Accept: application/json
```

请求无 body。沿用现有 OAuth `api` scope，无须给既有授权追加 scope。只生成充值页面的一次性入口，不创建支付订单、不扣款。身份必须来自 Bearer Token 对应的用户和客户端，不能接收外部 user_id。

成功响应：

```json
{
  "data": {
    "url": "https://openai.goldgom.top/oauth/recharge?ticket=<opaque-ticket>",
    "expires_in": 60
  }
}
```

客户端要求 `url` 是上述 HTTPS 域名下的 `/oauth/recharge`，带非空 `ticket`；`expires_in` 大于 0 且不超过 60 秒。不得把 OAuth access/refresh token 填入 URL。

错误返回非 2xx HTTP 状态码：401 表示 Token 过期、失效或撤销；403 表示客户端/用户禁用或权限不足；429 表示频率限制。格式沿用现有 OAuth JSON 错误 `{ "error": "invalid_token", "error_description": "..." }`。客户端只对 401 自动刷新一次凭据重试；只对 404 回退普通钱包页面。

## 2. 一次性入口和充值页面

新增 `GET /oauth/recharge?ticket=...`：

- 使用随机不透明票据，服务端只存哈希，绑定用户、OAuth grant 和 client，最多 60 秒有效。原子兑换，重复使用或过期返回明确失败页。
- 创建和兑换时都检查用户、客户端、grant、auth version、禁用状态与撤销状态。
- 兑换后设置仅允许钱包、支付订单与余额操作的 HttpOnly、Secure Cookie；随后 303 跳转到不带票据的充值页面。限定会话寿命，例如 30 分钟；不要把票据写入 localStorage。
- 不创建可访问账户设置、密钥管理、授权管理或管理员页面的完整网页登录态。钱包所调用的 API 必须同样执行会话权限限制，不能只隐藏导航。
- 支付方式、金额确认、订单生成及支付回调复用现有钱包流程。用户必须在页面主动确认支付。
- 页面显示当前充值账户，兑换票据时覆盖旧充值会话，避免窗口中残留另一个账户。
- 创建接口、兑换响应使用 `Cache-Control: no-store`；入口设置 `Referrer-Policy: no-referrer`，日志不记录票据和 Bearer Token。支付写操作校验 Origin/CSRF，默认关闭额外权限请求。

充值无需回调 TokenBird，也无需暴露订单密钥：关闭充值窗口后，客户端调用现有 `GET /api/oauth2/balance` 更新余额。不会自动重发之前失败的模型请求。

## 3. 余额不足错误

建议模型接口统一返回：

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json
```

```json
{
  "error": {
    "code": "insufficient_user_quota",
    "type": "billing_error",
    "message": "用户额度不足，请充值后重试"
  }
}
```

客户端已识别此代码，以及 `insufficient_balance`、`insufficient_quota`、`余额不足`、`额度不足` 等形式；仅对当前使用且已登录的 TokenNest OAuth 连接自动打开充值页面。
