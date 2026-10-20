# Debian Binance 凭据代理托管

针对服务器已有的 `tools/binance-cli-mcp` 只读代理：独立 systemd 服务负责开机启动、退出后自动恢复与 30 秒 watchdog。它不属于 craft-server 的 cgroup，聊天结束或 TokenBird 服务重启不会终止代理。

`launch.ts` 每次启动从服务器凭据库读取当前工作区的命名凭据（username 为 API key，value 为 secret），只注入子进程环境，不写入 unit、参数、日志或明文文件。凭据更新后重启此服务以重新读取。加密库不可读或凭据缺失时启动失败并重试，禁止降级为无认证代理。

示例 unit 包含这台 Debian 的工作目录、Python、Bun、配置目录和工作区 ID；其他机器必须先修改这些非秘密字段。安装前备份源文件，核对当前版本，运行 `install.py <现有代理目录>`、Python 生命周期测试和原 `test_safety.py`，再安装、启用 unit。`install.py` 不更改 CLI、出口代理、只读命令白名单和交易拒绝门。

Unix socket 目录为 0700，socket 为 0600；独占文件锁避免并发启动。只清除已验证为拒绝连接的 socket，保留普通文件、符号链接及活跃 socket。正常关闭清理自己的 socket；强制退出后的残留由下一次启动清理。READY 和 watchdog 通过 systemd 通知 socket 发送；健康请求只在本地检查响应，不访问交易所。

```sh
systemctl status tokenbird-binance-broker
systemctl restart tokenbird-binance-broker
systemctl is-enabled tokenbird-binance-broker
```

`get_capabilities` 新增 `credential_broker_ready`，实际探测代理响应；原 socket 存在字段仅表示文件存在。代理健康不代表币安认证、网络或账户产品权限已经验证。部署验收需分别检查本地健康、强制退出后的自动恢复、只读实际查询结果和提交/撤单仍被拒绝。
