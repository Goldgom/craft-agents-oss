# Windows Computer Use

Windows 版词元鸟内置 `computer_use` 和 Desktop Control 组件，随安装包交付，无需安装第三方桌面自动化软件或 Python 库。

在聊天中描述目标，例如“帮我在记事本输入这段文字”。模型可读取截图和 Windows 界面元素、列出并聚焦窗口、移动鼠标、单击或双击、拖拽、滚动、输入中文和使用快捷键。操作后可再次截图核对结果。

## 权限与运行条件

- Explore 允许观察，鼠标和键盘操作需要 Ask 或 Allow All；Ask 会使用现有会话授权提示。
- Windows 桌面必须已登录并解锁。普通权限进程不能操控管理员应用，组件不处理 UAC 安全桌面。
- 操作对象是运行会话的 Windows 主机。远程连接不会将操作转发到另一台客户端电脑。
- 受环境限制的 Super Agent 节点不能调用主机桌面操作；具有主机完全控制权的节点沿用现有权限规则。
- 截图可能包含其他窗口内容，并随任务发送到当前模型服务。组件的临时文件会在返回后删除；会话记录仍可能保存工具返回内容。
- 自绘软件可能缺少界面元素信息，可通过截图定位。Windows PowerShell、.NET Framework、Win32 与 UI Automation 为系统组件；没有独立后台服务。

## 配套命令

安装包同时提供 `desktop-control` / `desktop-control.cmd`，支持 `help`、`status`、`windows`、`snapshot`、`focus`、`screenshot`、`position`、`move`、`click`、`drag`、`scroll`、`type`、`key` 和 `wait`。应用启动时将命令目录加入代理运行环境。完整说明位于内置 `windows-desktop-control` 技能。

## 开发验证

```powershell
bun test packages/session-tools-core/src/handlers/computer-use.test.ts packages/shared/src/agent/__tests__/computer-use-permissions.test.ts
bun run scripts/test-windows-computer-use.ts
# 验证生成的 Windows 应用目录中的组件与 MCP 截图传输
bun run scripts/test-windows-computer-use.ts apps/electron/release/win-unpacked/resources/app
```

第二条命令会短暂打开专用测试窗口，实际验证截图、窗口读取、焦点、单击、拖拽、滚动、快捷键和中文输入，并在结束时关闭窗口。无需模型 API。
