# 小黄鸟桌面形象

在 **设置 → 外观 → 小黄鸟虚拟形象** 中调整两个独立开关：

- **常驻显示小黄鸟**：默认关闭。开启后小黄鸟留在桌面，普通任务也会显示“词元鸟正在思考 / 搜索 / 编辑”等进度。
- **使用电脑时自动显示**：默认开启。会话尝试调用 `computer_use` 或内置 `desktop-control` 命令时出现；等待授权时也会出现。关闭此选项后不会因电脑操作而自动弹出。

小黄鸟使用原软件图标做分层 2D 动画，保留黑色外套、蓝色面板和挥翅姿势，带呼吸、眨眼、说话和跳跃动作。它是独立的透明桌面窗口，软件最小化后仍可显示，出现时不会抢走当前窗口焦点。拖动小黄鸟可调整位置，点击可打招呼，气泡的关闭按钮会暂时隐藏形象，到新任务时恢复。系统开启减少动态效果时，小黄鸟使用静态形象。

气泡显示当前操作和已完成的工具步骤数；同时执行多个任务时会标注任务数量。它不猜测百分比，也不展示输入文字、密码、原始工具返回值或聊天正文。结束、异常和中断分别提示；结束通知保留 10 秒，自动显示模式随后收起，常驻模式回到待命状态。执行结束不等同于目标已验证成功，请在聊天中查看最终结果。

设置保存在本机 `preferences.json` 的 `birdCompanion` 字段，连接远程服务器时也使用本机设置。桌面形象目前由 Electron 客户端提供，网页版和 Android 不显示此设置。自动进度跟随标准会话工具事件；通过其他任意脚本间接调用系统自动化的行为没有统一识别保证。

Windows 上使用系统的捕获排除机制，防止小黄鸟遮挡 computer use 的截图；其他系统的捕获排除效果取决于操作系统支持。

## 开发验证

```powershell
bun test apps/electron/src/main/__tests__/bird-companion-progress.test.ts
bun run typecheck:electron
bun run electron:build:main
bun run electron:build:preload
bun run electron:build:renderer
bun run scripts/tokenbird-bird-companion.smoke.ts
```
