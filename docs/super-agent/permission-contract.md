# 权限交互设计约定

这是用户明确要求长期保留的产品设计。修改权限、Skill 加载、节点策略或模型适配器时，必须保持以下行为，并运行对应回归测试。

1. **权限不足应向用户弹窗申请。** 保持当前工具调用等待；用户批准后继续原调用，不把可申请的操作升级成红色「超级智能体操作失败」，也不要求用户修改设置后重新发起。弹窗挂载于 AppShell，用户切换页面后后台节点仍能申请权限。用户拒绝、取消或授权过期时结束等待。
2. **Skill 读取不能形成权限死锁。** 系统提示词列出的内置 Skill，其 `SKILL.md` 及包内参考资料均具有独立只读访问，不受工作目录、节点绑定列表、文件读取开关或工具前置读取条件阻挡。这只授权读取资料；资料描述的操作仍通过当前控制模式处理。
3. **完全控制是应用权限的总开关。** 开启时不再受能力开关、目录内外限制、数据源白名单、自定义禁止规则、人工审批、行动门、Auto-review 或 Skill 前置条件阻挡。运行中开启时恢复原先可执行的待授权调用；关闭后恢复原有细分配置，不留下临时全权。
4. **受限模式下审批决定由用户作出。** 自定义禁止规则与独立审查的拒绝意见进入申请说明，交用户决定，不能代替弹窗直接结束工具。批准绑定当前节点、调用 ID、完整参数、路径与策略版本；改参、重放或撤销不能复用。

5. **视频工具沿用同一权限约定。** `video_tool` 的文件读取、写入、FFmpeg 执行和外部生成服务访问不足时，等待用户批准原调用；外部付费生成进入 financial 行动门。完全控制跳过能力、数据源、自定义规则和审查限制。`video-production/SKILL.md` 及其参考文件与其他内置技能一样可独立读取。视频生成服务密钥只通过工作台安全表单配置，不作为模型工具参数。节点在自身模型进程中分析脚本并保存分镜，不再启动额外分析 Agent；宿主通过独立执行上下文禁止节点自动分析，后台任务在真正分析前再次强制检查。模型参数不能放开该约束，前置检查后分镜被其他请求清空也不能间接启动 Agent。取消任务后仍保留同项目运行锁，直到旧执行、子进程与网络清理实际结束，避免新旧任务写回重叠。选定容器的节点不能通过视频服务转到宿主机执行 FFmpeg，可在所选容器中使用 Bash 与 FFmpeg。工作台按钮发起的视频任务明确运行在该工作区所在服务端。

主节点、后台规划、派工协调、执行子节点的职责和相邻通信拓扑及工具协议、每节点模型进程串行、真实可用的连接与凭据、所选容器的实际挂载及网络条件继续按架构执行。完全控制下后台规划与派工协调节点可直接读取目录外资料，仍不获得工作节点的写入、程序执行或额外模型进程工具。

视频任务的取消锁覆盖其执行 Promise、FFmpeg 子进程及下载清理。工作台独立分析会话仍由现有 SessionManager 处理停止；移除结果订阅与取消检查防止旧分析写回，不表示所有模型进程已同步退出。

截图故障的具体回归：`task-orchestration/SKILL.md` 位于安装目录、未在节点 `allowSkills` 中时，主节点、后台规划、派工协调及执行子节点均能读取；不会再返回 `Path is outside the node environment`。

关键测试：

- `packages/shared/src/agent/__tests__/base-agent-node-references.test.ts`
- `packages/shared/src/agent/core/__tests__/session-execution-policy.test.ts`
- `packages/shared/src/agent/core/__tests__/action-gates.test.ts`
- `packages/shared/src/agent/core/__tests__/video-permissions.test.ts`
- `packages/server-core/src/services/video/session-tool.test.ts`
- `packages/server-core/src/services/video/service.test.ts`
- `packages/server-core/src/sessions/node-policy-permissions.test.ts`
- `packages/server-core/src/sessions/super-agent-session-settings.test.ts`
- `apps/electron/src/renderer/pages/super-agent/SuperAgentPermissionDialog.isolated.ts`

三节点拓扑回归：`packages/server-core/src/super-agent/SuperAgentTopology.test.ts`。完全控制不放开越级、广播或同级通信；执行进度不得直接唤醒主节点。

效率优化继续遵守上述边界：`super_agent_finish_turn` 仅供后台规划和派工协调结束没有新增工作的内部轮次；即使完全控制开启，主节点和执行子节点也不能使用。它不完成任务、计划或用户目标，不代替验收，不消除未知操作，也不覆盖真实鉴权、连接或取消错误。成功处理的内部通知只推进本轮固定批次的收件游标。

任务完成标记由当前版本、执行结果和验收要求统一计算。默认自检通过即可完成；用户或工作流明确要求独立验收时仍须通过验收。等待、未知结果、部分应用、拒绝和过期证据不能显示完成。减少重复规划、汇报和巡检不跳过权限申请，也不改变模型进程串行及实际执行环境。

未知操作只在宿主原始证据支持时缩小资源占用：已审计的桌面观察、焦点或移动操作只占用桌面；点击、拖动、输入、按键及来源不明的工具仍保留原任务资源锁。历史证据缺失、截断或不可读取时保守保留原锁，不将错误自动认定为未执行。相关回归：`SuperAgentEfficiency.test.ts`、共享层 `scheduling.test.ts` 及角色策略 `session-execution-policy.test.ts`。

浏览器长任务在智能体接管期间关闭任务页面的后台定时器限速，隐藏窗口也保持正常执行速度；释放控制、解绑、换绑或销毁时恢复接管前的设置。手动浏览页面保留原设置。此调度策略不授予操作权限、不跳过审批，也不改变所选执行环境；回归测试见 `apps/electron/src/main/__tests__/browser-pane-manager.isolated.ts`。

`super_agent_task action=recover` 是宿主原回执恢复接口，后台规划、派工协调及拥有该操作可见性的执行节点可使用；主节点仍不能调用内部任务工具。恢复读取宿主私有回执和原会话存档，不授予任意文件读取/写入或跨工作区权限。只按真实终止证据结清指定调用，保留任务失败记录、输出、已发生写入和独立业务验收；活跃执行或证据不足时继续阻塞，其他未知操作锁保持。重复请求幂等并持久审计，不要求另一个验证任务先完成，不新增用户审批。完全控制仍不绕过这些身份、证据和进程约束。回归：`SuperAgentOperationRecovery.test.ts`、`SuperAgentEfficiency.test.ts`、`session-execution-policy.test.ts`。

团队恢复采用保留主要节点进度、通信及任务板并重建执行子节点的方式。`recover-workers` 与彻底重置分开：先提交持久恢复屏障和执行代次，确认旧会话及受管准备操作停止后解除 worker 会话绑定；保留原会话、检查点、任务 ID、执行尝试、已提交协作动作及报告游标。主节点、规划节点和派工协调节点的健康会话保留；被中断的主要节点使用新会话接续已提交工作。恢复沿用当前权限、角色拓扑、连接和真实执行环境，不继承旧调用的一次性批准，不取消用户明确的停止、任务取消和用户阻塞。

新执行代次拒绝旧会话派发操作和提交任务，但可将匹配的迟到终止回执补入原操作归档。未知原生 `Read/Glob/Grep/LS` 只读尝试可登记为 `executionOutcome=interrupted`，表示该尝试已结束，不表示读取成功或任务完成；其他未知副作用及未跟踪进程继续保留相关资源占用。完全控制不跳过执行代次、停止确认、证据对账、通信去重及资源串行要求。工具显示分类不得修改执行工具身份；参数哈希使用版本化规范化，旧回执继续按原规则核对。历史 Bash/Read 哈希仅在原私有日志的调用身份、完整参数及原结果均匹配时修复并审计。回归：`SuperAgentWorkerRecovery.test.ts`、`SuperAgentOperationRecovery.test.ts`、`SuperAgentNodeRecovery.test.ts`、`SuperAgentWorkerRecovery.isolated.ts`。

画布 `canvas_tool action=generate_gif` 沿用原画布客户端通道与工具授权流程：可申请限制等待用户批准原调用，完全控制跳过应用限制；图像编码不调用额外模型、不启动程序或外部服务。导出路径仍通过桌面已有文件保存通道处理，拒绝覆盖现有文件。回归：`canvas-gif-permissions.test.ts`、`canvas-gif-schema.test.ts`、`scripts/test-studio-gif.ts`。

模型自动选择后端时沿用会话和节点的执行策略。Codex 受控会话通过宿主动态工具执行文件与程序操作，关闭原生 Shell、文件编辑与图片读取工具。Claude Code 和 Codex 保留 CLI 自带的系统提示词，应用上下文作为会话消息传入。回归见 `native-codex-policy.isolated.ts` 和 `native-codex-agent.test.ts`。

Auto 根据本回合的模型 ID 和执行主机支持的后端选路，手动选择优先。会话在下一次发送时切换运行时，运行中的回合继续由原进程处理。Android 本地使用 APK 自带的 Pi，远程会话由服务端执行。Claude Messages 网关通过当前连接的密钥使用 Claude Code。

审批响应晚于原操作有效期时，宿主立即以拒绝释放原调用，并持久保存卡片的过期状态。等待用户决策的任务不会触发无进展巡检汇报。
