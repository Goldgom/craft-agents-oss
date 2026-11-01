# 权限交互设计约定

这是用户明确要求长期保留的产品设计。修改权限、Skill 加载、节点策略或模型适配器时，必须保持以下行为，并运行对应回归测试。

1. **权限不足应向用户弹窗申请。** 保持当前工具调用等待；用户批准后继续原调用，不把可申请的操作升级成红色「超级智能体操作失败」，也不要求用户修改设置后重新发起。弹窗挂载于 AppShell，用户切换页面后后台节点仍能申请权限。用户拒绝、取消或授权过期时结束等待。
2. **Skill 读取不能形成权限死锁。** 系统提示词列出的内置 Skill，其 `SKILL.md` 及包内参考资料均具有独立只读访问，不受工作目录、节点绑定列表、文件读取开关或工具前置读取条件阻挡。这只授权读取资料；资料描述的操作仍通过当前控制模式处理。
3. **完全控制是应用权限的总开关。** 开启时不再受能力开关、目录内外限制、数据源白名单、自定义禁止规则、人工审批、行动门、Auto-review 或 Skill 前置条件阻挡。运行中开启时恢复原先可执行的待授权调用；关闭后恢复原有细分配置，不留下临时全权。
4. **受限模式下审批决定由用户作出。** 自定义禁止规则与独立审查的拒绝意见进入申请说明，交用户决定，不能代替弹窗直接结束工具。批准绑定当前节点、调用 ID、完整参数、路径与策略版本；改参、重放或撤销不能复用。

主节点、后台规划、派工协调、执行子节点的职责和相邻通信拓扑及工具协议、每节点模型进程串行、真实可用的连接与凭据、所选容器的实际挂载及网络条件继续按架构执行。完全控制下后台规划与派工协调节点可直接读取目录外资料，仍不获得工作节点的写入、程序执行或额外模型进程工具。

截图故障的具体回归：`task-orchestration/SKILL.md` 位于安装目录、未在节点 `allowSkills` 中时，主节点、后台规划、派工协调及执行子节点均能读取；不会再返回 `Path is outside the node environment`。

关键测试：

- `packages/shared/src/agent/__tests__/base-agent-node-references.test.ts`
- `packages/shared/src/agent/core/__tests__/session-execution-policy.test.ts`
- `packages/shared/src/agent/core/__tests__/action-gates.test.ts`
- `packages/server-core/src/sessions/node-policy-permissions.test.ts`
- `packages/server-core/src/sessions/super-agent-session-settings.test.ts`
- `apps/electron/src/renderer/pages/super-agent/SuperAgentPermissionDialog.isolated.ts`

三节点拓扑回归：`packages/server-core/src/super-agent/SuperAgentTopology.test.ts`。完全控制不放开越级、广播或同级通信；执行进度不得直接唤醒主节点。

效率优化继续遵守上述边界：`super_agent_finish_turn` 仅供后台规划和派工协调结束没有新增工作的内部轮次；即使完全控制开启，主节点和执行子节点也不能使用。它不完成任务、计划或用户目标，不代替验收，不消除未知操作，也不覆盖真实鉴权、连接或取消错误。成功处理的内部通知只推进本轮固定批次的收件游标。

任务完成标记由当前版本、执行结果和验收要求统一计算。默认自检通过即可完成；用户或工作流明确要求独立验收时仍须通过验收。等待、未知结果、部分应用、拒绝和过期证据不能显示完成。减少重复规划、汇报和巡检不跳过权限申请，也不改变模型进程串行及实际执行环境。

未知操作只在宿主原始证据支持时缩小资源占用：已审计的桌面观察、焦点或移动操作只占用桌面；点击、拖动、输入、按键及来源不明的工具仍保留原任务资源锁。历史证据缺失、截断或不可读取时保守保留原锁，不将错误自动认定为未执行。相关回归：`SuperAgentEfficiency.test.ts`、共享层 `scheduling.test.ts` 及角色策略 `session-execution-policy.test.ts`。

浏览器长任务在智能体接管期间关闭任务页面的后台定时器限速，隐藏窗口也保持正常执行速度；释放控制、解绑、换绑或销毁时恢复接管前的设置。手动浏览页面保留原设置。此调度策略不授予操作权限、不跳过审批，也不改变所选执行环境；回归测试见 `apps/electron/src/main/__tests__/browser-pane-manager.isolated.ts`。
