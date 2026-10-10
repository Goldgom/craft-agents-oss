import { useTranslation } from 'react-i18next'
import { getModelsForProviderType, isImageGenerationModelId } from '@config/llm-connections'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import type { SuperAgentConfig, SuperAgentEnvironment, SuperAgentNode } from '@craft-agent/shared/super-agent'
import { PRESET_RECIPES, presetModels, presetStrings, nodePresetProfile, presetRequirements, type SuperAgentPreset } from './super-agent-presets'
export type { SuperAgentPreset } from './super-agent-presets'
import { improvementStrings } from './super-agent-improvement-strings'

const strings = {
  conversationErrorGeneral: ['超级智能体操作失败', 'Super Agent action failed'],
  conversationErrorConflict: ['共享状态已更新，本次操作未完成', 'Shared state changed; this action could not complete'],
  conversationErrorFormat: ['动作格式有误，未能执行', 'Invalid action format; the action could not run'],
  conversationErrorPartial: ['部分操作未完成', 'Some actions could not complete'],
  conversationErrorDetails: ['详情', 'Details'],
  ...improvementStrings,
  ...presetStrings,
  archiveLibrary: ['档案库', 'Archive library'],
  memoryLibrary: ['Memory 库', 'Memory library'],
  archiveLibraryHint: ['保存工程中间版本、报告和其他文件副本，可恢复到新目录。重启或清理历史后仍保留。', 'Save project versions, reports and other file snapshots; restore into a new directory. Retained across restarts and history cleanup.'],
  memoryLibraryHint: ['保存长期偏好、项目决策、已核实事实与经验，智能体可跨任务检索。', 'Store lasting preferences, project decisions, verified facts and lessons for agents to retrieve across tasks.'],
  librarySearch: ['搜索标题、标签和内容', 'Search titles, tags and content'],
  libraryTags: ['标签（逗号分隔）', 'Tags (comma separated)'],
  memoryAdd: ['添加记忆', 'Add memory'],
  memoryCategory: ['记忆类型', 'Memory category'],
  memoryEvidence: ['依据或来源', 'Evidence or source'],
  memoryPreference: ['稳定偏好', 'Preference'],
  memoryFact: ['已核实事实', 'Verified fact'],
  memoryDecision: ['项目决策', 'Decision'],
  memoryLesson: ['经验教训', 'Lesson'],
  memoryOther: ['其他', 'Other'],
  memoryEmpty: ['暂无长期记忆', 'No long-term memories yet'],
  memoryDeleteHint: ['删除这条长期记忆后，智能体将不再从记忆库检索它。', 'Once deleted, agents will no longer retrieve this entry from the memory library.'],
  archiveAdd: ['归档版本', 'Archive version'],
  archiveEmpty: ['暂无档案', 'No archives yet'],
  archiveSource: ['源文件或目录', 'Source file or directory'],
  archiveSourceHint: ['工作目录内的路径；复制实际文件，不改变原工程。最多 2000 项、256 MB，单文件 64 MB，不支持链接。', 'Path inside the working directory. Copies actual files. Up to 2000 entries, 256 MB total and 64 MB per file; links are unsupported.'],
  archiveVersion: ['版本说明', 'Version label'],
  archiveRestore: ['恢复副本', 'Restore copy'],
  archiveDestination: ['恢复到新目录', 'Restore into a new directory'],
  archiveRestoreHint: ['目录须位于工作目录内且尚不存在，父目录已存在。恢复时校验 SHA-256。', 'Use a new directory inside the working directory with an existing parent. SHA-256 is checked during restoration.'],
  archiveRestored: ['已恢复副本', 'Copy restored'],
  archiveFiles: ['文件', 'Files'],
  title: ['超级智能体', 'Super Agent'],
  subtitle: ['一个和你沟通的主节点，一组专注工作的独立节点。', 'One coordinator to talk with you, independent nodes to do the work.'],
  welcome: ['创建你的超级智能体', 'Create your Super Agent'],
  welcomeDescription: ['先为助手设置身份、至少一个主节点和一个工作节点，再指定它可以工作的环境。', 'Set up its identity, one coordinator and at least one worker, then choose where they can work.'],
  identity: ['助手身份', 'Assistant identity'],
  team: ['智能体节点', 'Agent nodes'],
  environment: ['工作环境', 'Work environment'],
  review: ['确认设置', 'Review setup'],
  name: ['名字', 'Name'],
  assistantName: ['超级智能体名字', 'Super Agent name'],
  defaultName: ['我的超级智能体', 'My Super Agent'],
  avatar: ['头像', 'Avatar'],
  uploadAvatar: ['上传头像', 'Upload avatar'],
  invalidAvatar: ['请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片。', 'Choose a PNG, JPEG or WebP image under 5 MB.'],
  connections: ['AI 提供商', 'AI providers'],
  reusedConnections: ['直接复用智能体的 AI 设置和 TokenNest 登录，凭据由原有设置统一管理。', 'Reuse your agent AI settings and TokenNest sign-in. Credentials stay in the existing settings.'],
  manageConnections: ['打开 AI 设置', 'Open AI settings'],
  login: ['登录 TokenNest', 'Sign in to TokenNest'],
  refresh: ['刷新', 'Refresh'],
  connected: ['已连接', 'Connected'],
  unauthenticated: ['需要登录', 'Sign-in needed'],
  preset: ['选择配置方案', 'Choose a setup'],
  custom: ['自定义', 'Custom'],
  customDescription: ['逐个设置模型、思考能力和工作偏好。', 'Choose each model, thinking level and work preferences.'],
  presetDescription: ['方案仅使用所选连接及当前分组可用的文本模型；优先按职责选择模型，不足时复用可用模型。全部设置可调整。', 'Setups use available text models in the selected connection and group, with role-based choices and fallback to available models. All settings remain editable.'],
  noConnections: ['尚无可用的 AI 连接。请登录 TokenNest 或在 AI 设置中添加提供商。', 'No AI connection is ready. Sign in to TokenNest or add a provider in AI settings.'],
  selectConnection: ['选择连接', 'Choose connection'],
  model: ['模型', 'Model'],
  modelPlaceholder: ['选择或输入模型 ID', 'Choose or enter a model ID'],
  inheritedGroup: ['使用 AI 设置中的分组：{{group}}', 'Uses the group from AI settings: {{group}}'],
  coordinator: ['意图主节点', 'Intent node'],
  orchestrator: ['编排节点', 'Orchestrator'],
  orchestratorName: ['任务编排', 'Task orchestrator'],
  orchestratorDescription: ['拆解意图、协调依赖与资源，依据工作节点报告验收。', 'Plan intent, coordinate dependencies and resources, and accept worker evidence.'],
  worker: ['工作节点', 'Worker'],
  taskSubmitted: ['已提交，待验收', 'Submitted, awaiting acceptance'],
  taskAccepted: ['已验收', 'Accepted'],
  taskRejected: ['验收未通过', 'Acceptance rejected'],
  taskDependencies: ['前置任务', 'Prerequisites'],
  coordinatorName: ['主智能体', 'Coordinator'],
  workerName: ['执行助手', 'Execution assistant'],
  researcherName: ['研究助手', 'Research assistant'],
  coordinatorDescription: ['理解用户目标、约束与验收条件，交给编排节点，转交结果。', 'Understand goals, constraints and acceptance; hand off to the orchestrator and relay results.'],
  workerDescription: ['执行分配的工作，向主节点报告进展、发现和结果。', 'Complete assigned work and report progress, findings and results.'],
  coordinatorRule: ['主节点理解意图与用户交互；编排节点拆解计划、协调依赖和验收；工作节点执行与核验。内部指令隐藏，对话只保留上游交接内容。', 'The main node handles intent and interaction; the orchestrator plans dependencies and acceptance; workers execute and verify. Internal instructions stay hidden.'],
  addWorker: ['添加工作节点', 'Add worker'],
  removeNode: ['移除节点', 'Remove node'],
  description: ['基本描述', 'Description'],
  thinking: ['思考能力', 'Thinking level'],
  speed: ['最大工作速度', 'Maximum work rate'],
  speedHint: ['每分钟最多开始的工作轮次。一轮可包含多个模型和工具调用；此设置不改变输出速度。', 'Maximum work turns started per minute. A turn may include several model and tool calls; this does not change output speed.'],
  rating: ['智能评级', 'Intelligence rating'],
  ratingHint: ['你对该节点能力的评级，用于描述和分工。', 'Your assessment of the node, used to describe its role.'],
  preferences: ['工作偏好', 'Work preferences'],
  preferencesPlaceholder: ['例如：先查证再下结论，结果用中文，优先复用现有文件。', 'For example: verify before concluding, write concise results, reuse existing files.'],
  idleInterval: ['空闲自检间隔（分钟）', 'Idle review interval (minutes)'],
  idleHint: ['可设置 1～1440 分钟。持续工作开启时，全队连续空闲达到此间隔后自检；关闭时只检查已有工作活动。运行中也可单独调整此间隔，保存后生效。', 'Set 1–1440 minutes. With continuous work, review after the whole team is idle for this interval; otherwise inspect existing activity only. The interval alone can be changed during work and takes effect on save.'],
  folder: ['指定文件夹', 'Folder'],
  sandbox: ['容器沙箱', 'Container sandbox'],
  vm: ['虚拟机', 'Virtual machine'],
  folderDescription: ['在所选目录中工作，文件和工具操作遵守下方权限。', 'Work in the selected folder with the file and tool permissions below.'],
  sandboxDescription: ['使用 Docker 或 Podman 隔离执行，服务端会验证运行时和镜像。', 'Execute in Docker or Podman. The server checks the runtime and image.'],
  vmDescription: ['连接虚拟机内的 TokenBird 服务工作区；服务端需设置 TOKENBIRD_EXECUTION_HOST=vm。', 'Connect a TokenBird server workspace inside your VM. The server must set TOKENBIRD_EXECUTION_HOST=vm.'],
  unavailableEnvironment: ['当前服务端尚未连接此执行环境。配置后不能启动工作。', 'This execution environment is not connected to the server yet. Work cannot start in it.'],
  folderIsolation: ['文件夹权限控制不提供操作系统级隔离。需要强隔离时请连接沙箱或虚拟机执行端。', 'Folder permissions do not provide operating system isolation. Connect a sandbox or VM executor for stronger isolation.'],
  folderPrograms: ['没有沙箱也可运行程序和脚本，但每次宿主命令必须由用户明确批准；完全控制模式无需审批。工作目录不提供沙箱隔离。', 'Programs and scripts can run without a sandbox. Every host command requires explicit user approval unless full control is enabled. A working folder provides no sandbox isolation.'],
  workingDirectory: ['工作目录', 'Working directory'],
  pickDirectory: ['选择文件夹', 'Choose folder'],
  containerImage: ['容器镜像', 'Container image'],
  containerRuntime: ['容器运行时', 'Container runtime'],
  vmWorkspace: ['虚拟机工作区 ID', 'VM workspace ID'],
  permissions: ['权限控制', 'Permissions'],
  fullControl: ['完全控制', 'Full control'],
  continuity: ['任务持续性与调度', 'Continuity and scheduling'],
  connectionConcurrency: ['每个连接的并发上限', 'Concurrency per connection'],
  connectionRate: ['每个连接每分钟启动上限', 'Turn starts per connection per minute'],
  stallMinutes: ['无有效进展提醒（分钟）', 'Progress reminder after minutes'],
  resumeAttempts: ['自动续做次数上限', 'Automatic resumptions'],
  capabilities: ['任务能力标签', 'Task capability tags'],
  capabilitiesHint: ['用逗号分隔，例如 coding、testing、research。任务声明必需标签后，宿主只选择匹配节点。', 'Comma separated, e.g. coding, testing, research. Required task tags are enforced by the scheduler.'],
  checkpoint: ['执行检查点', 'Execution checkpoint'],
  taskWaiting: ['等待条件', 'Waiting for condition'],
  taskUnknown: ['操作结果待核验', 'Operation outcome unknown'],
  taskStale: ['产物已变更，待复核', 'Artifact changed; recheck required'],
  resumeTask: ['从检查点继续', 'Resume from checkpoint'],
  goals: ['任务目标', 'Goals'],
  goalDelivered: ['已交付', 'Delivered'],
  continuityMetrics: ['执行 {{turns}} 轮 · 工具 {{tools}} 次 · 重试 {{retries}} 次 · 续做 {{resumes}} 次', '{{turns}} turns · {{tools}} tools · {{retries}} retries · {{resumes}} resumptions'],
  fullControlDescription: ['开启全部工作能力，文件工具可访问工作目录内外的宿主路径，跳过所有人工审批、行动门和自动审查。没有沙箱时可直接运行宿主程序和脚本；已有沙箱继续使用原容器。数据源和禁止规则仍生效。', 'Enable all worker capabilities and host file access, and skip human approvals, Action Gates and Auto-review. Programs and scripts can run directly on the host without a sandbox; configured sandboxes remain in use. Source and deny rules still apply.'],
  fullControlBoundary: ['完全控制已开启：范围内操作直接执行，正在等待的范围内审批会自动恢复。关闭后恢复审批规则。', 'Full control is on: operations within the execution boundary run directly, and pending approvals within that boundary resume automatically. Turn it off to restore approval rules.'],
  fullControlEnabled: ['完全控制（跳过所有审批）', 'Full control (skip all approvals)'],
  actionGates: ['行动门与独立审查', 'Action Gates and independent review'],
  actionGatesHint: ['关闭完全控制时，已验证的只读工具自主执行，写入、外部通信、消费、基础设施变更和未知操作需要人工批准。开启完全控制会跳过所有审批和自动审查。', 'With full control off, verified read-only tools run autonomously; writes, external communication, spending, infrastructure changes and unknown operations require human approval. Full control skips all approvals and Auto-review.'],
  autoReview: ['独立自动审查', 'Independent auto-review'],
  autoReviewHint: ['关闭完全控制时，使用当前连接另开无工具的审查请求，会消耗模型额度。审查可能出错，失败交人工决定，通过仍需审批。完全控制开启时不调用审查器，设置保留供关闭后使用。', 'With full control off, a separate tool-free review uses the current connection and model credits. Review can be wrong; failure requires human review and a consistent verdict still requires approval. Full control skips the reviewer and retains this setting for later.'],
  customRulesHint: ['按完整工具名称匹配，可禁止操作或增加人工审批。禁止规则始终生效；完全控制会跳过人工审批规则。脚本启动使用 script-run。', 'Match exact tool names to deny actions or require human approval. Deny rules always apply; full control skips human approval rules. Use script-run for registered scripts.'],
  ruleTool: ['完整工具名称', 'Exact tool name'],
  ruleReason: ['限制原因', 'Restriction reason'],
  ruleDeny: ['禁止执行', 'Deny'],
  ruleHuman: ['需要人工审批', 'Require human approval'],
  addCustomRule: ['添加限制规则', 'Add restriction rule'],
  advancedPermissions: ['高级权限', 'Advanced permissions'],
  limitedControl: ['按高级权限执行', 'Use advanced permissions'],
  readFiles: ['读取文件', 'Read files'],
  writeFiles: ['修改文件', 'Write files'],
  runPrograms: ['运行程序和脚本', 'Run programs and scripts'],
  browser: ['操作浏览器', 'Control browser'],
  permissionMode: ['执行模式', 'Execution mode'],
  allowAll: ['执行（Execute）', 'Execute'],
  executionModeHint: ['主节点与所有工作节点统一使用执行模式；具体操作仍受能力开关、工作环境和单次授权约束。', 'The coordinator and all workers use Execute. Capability switches, the work environment and scoped approvals still control access.'],
  permissionHint: ['能力开关决定可执行范围；只读操作自主执行，有副作用的操作由主聊天中的行动门逐次审批。范围外操作无法靠审批放行。', 'Capabilities define the execution boundary. Reads run autonomously; side effects require Action Gate approval in the main chat. Approval cannot allow an operation outside the boundary.'],
  next: ['下一步', 'Continue'],
  back: ['上一步', 'Back'],
  create: ['创建超级智能体', 'Create Super Agent'],
  save: ['保存设置', 'Save settings'],
  cancel: ['取消', 'Cancel'],
  setupComplete: ['已准备创建', 'Ready to create'],
  setupSummary: ['{{workers}} 个工作节点 · 1 个主节点 · 每 {{minutes}} 分钟检查', '{{workers}} workers · 1 coordinator · inspect every {{minutes}} minutes'],
  settings: ['设置', 'Settings'],
  reset: ['完全重置', 'Reset everything'],
  resetHint: ['清除超级智能体的全部配置与内容，返回首次配置页面。', 'Clear all Super Agent settings and content and return to initial setup.'],
  resetConfirm: ['确认完全重置超级智能体', 'Confirm complete Super Agent reset'],
  resetDescription: ['将停止节点与托管脚本，永久删除当前工作区超级智能体的配置、节点会话及附件、对话、任务、计划、共享板、记忆库、归档库、授权、脚本注册与运行记录（包括历史归档），无法恢复。', 'Stop nodes and managed scripts and permanently delete this workspace’s Super Agent settings, node conversations and attachments, messages, tasks, plans, shared board, memory library, archive library, permissions, script registrations and runtime history (including archives). This cannot be undone.'],
  resetPreserved: ['项目目录文件、AI 连接、工作区数据源和技能会保留。', 'Project files, AI connections, workspace sources and skills are preserved.'],
  resetting: ['正在完全重置…', 'Resetting everything…'],
  history: ['历史信息清理', 'History cleanup'],
  historyHint: ['选择清理范围并预览。未完成计划、当前节点会话及其依赖资料会保留。', 'Choose what to clean and review the scope. Unfinished plans, current node sessions and their dependencies are preserved.'],
  historyRuntime: ['运行历史', 'Runtime history'],
  historyRuntimeHint: ['归档并清理已结束任务、旧消息、已关闭计划和旧脚本日志。完整会话及项目文件保留。', 'Archive and clean finished tasks, old messages, closed plans and old script logs. Full conversations and project files are retained.'],
  historyCompact: ['模型上下文', 'Model context'],
  historyCompactHint: ['选择节点，将旧上下文压缩为摘要，保留目标、进展和必要引用。会调用模型，完整聊天记录保留。', 'Choose nodes to summarize older context while preserving goals, progress and references. Uses the model; full chat transcripts are retained.'],
  historySessions: ['旧会话及附件', 'Old sessions and attachments'],
  historySessionsHint: ['仅列出当前工作区已结束或归档的旧会话。删除会永久移除会话、附件和会话目录中的文件。', 'Lists old completed or archived sessions in this workspace. Deletion permanently removes the conversation, attachments and files in its session folder.'],
  historyPeriod: ['清理时间范围', 'Age filter'],
  historyAll: ['全部符合条件的历史', 'All eligible history'],
  historyOlder: ['{{days}} 天前', 'Older than {{days}} days'],
  historyKeep: ['保留最近消息', 'Keep recent messages'],
  historyKeepCount: ['{{count}} 条', '{{count}} messages'],
  historyPreview: ['可清理：{{tasks}} 个任务、{{messages}} 条消息、{{plans}} 个计划、{{logs}} 份脚本日志', 'Eligible: {{tasks}} tasks, {{messages}} messages, {{plans}} plans, {{logs}} script logs'],
  historyIdle: ['请等待节点、脚本及授权处理完成后再清理。', 'Wait for nodes, scripts and pending approvals to finish before cleaning history.'],
  historyNoNodes: ['还没有可压缩的节点会话。', 'No node sessions are available to compact.'],
  historyNoSessions: ['没有符合条件的旧会话。当前节点、未完成任务、星标、协作及任务流程关联的会话受到保护。', 'No eligible old sessions. Current nodes, unfinished work, flagged, collaboration and task workflow sessions are protected.'],
  historyArchive: ['归档并清理', 'Archive and clean'],
  historyCompactAction: ['压缩所选上下文', 'Compact selected context'],
  historyDeleteAction: ['删除所选会话', 'Delete selected sessions'],
  historySelected: ['已选 {{count}} 项', '{{count}} selected'],
  historyConfirm: ['确认清理范围', 'Confirm cleanup scope'],
  historyConfirmRuntime: ['将按预览范围先保存归档，再清理运行历史。', 'The previewed runtime history will be archived before it is cleaned.'],
  historyConfirmCompact: ['将为所选 {{count}} 个节点启动上下文压缩。摘要可能省略细节；可从原会话查阅完整记录。', 'Start context compaction for {{count}} selected nodes. Summaries may omit details; full transcripts remain available.'],
  historyConfirmDelete: ['永久删除所选 {{count}} 个会话及其附件和会话目录文件，无法撤销。项目目录中的文件保留。', 'Permanently delete {{count}} selected sessions, their attachments and session-folder files. This cannot be undone. Project-directory files are retained.'],
  historyDone: ['已清理 {{tasks}} 个任务、{{messages}} 条消息、{{plans}} 个计划、{{logs}} 份日志。', 'Cleaned {{tasks}} tasks, {{messages}} messages, {{plans}} plans and {{logs}} logs.'],
  historyQueued: ['已安排 {{count}} 个节点压缩上下文；进度与结果可在节点会话中查看。', 'Context compaction queued for {{count}} nodes. View progress and results in the node conversations.'],
  historyDeleted: ['已删除 {{count}} 个会话。', 'Deleted {{count}} sessions.'],
  historyArchiveOpen: ['查看归档文件', 'Show archive file'],
  historyFailed: ['{{count}} 项操作未完成，详见下方原因。', '{{count}} operations did not finish. Reasons are shown below.'],
  continuousWork: ['持续工作', 'Continuous work'],
  enabled: ['已开启', 'Enabled'],
  disabled: ['已关闭', 'Disabled'],
  continuousWorkHint: ['默认开启，主动推进已授权目标的未完成计划；全队连续空闲达到下方设置的间隔后自检。自检间隔可调整，程序运行期间生效。', 'Enabled by default. Advance unfinished authorized plans and review after the configured team idle interval. The interval is adjustable. Requires the server to be running.'],
  plans: ['计划列表', 'Plans'],
  planHint: ['主智能体按优先级安排工作，记录进展与阻碍，并核验完成情况。你也可以添加或调整计划。', 'The coordinator schedules work by priority, records progress and blockers, and verifies completion. You can also add or edit plans.'],
  noPlans: ['暂无计划。添加目标，或在聊天中让主智能体安排工作。', 'No plans yet. Add a goal or ask the coordinator to arrange work in chat.'],
  addPlan: ['添加计划', 'Add plan'],
  planStatus: ['计划状态', 'Plan status'],
  priority: ['优先级（1 最高）', 'Priority (1 is highest)'],
  planNote: ['进展与阻碍', 'Progress and blockers'],
  planned: ['待安排', 'Planned'],
  active: ['推进中', 'In progress'],
  blocked: ['受阻', 'Blocked'],
  settingsTitle: ['超级智能体设置', 'Super Agent settings'],
  generalSettings: ['基本设置', 'General settings'],
  backToAssistant: ['返回助手', 'Back to assistant'],
  workProgress: ['工作进展', 'Work progress'],
  workStatus: ['当前工作状态', 'Current work status'],
  workStatusIdle: ['摸鱼中', 'Taking a break'],
  workStatusThinking: ['思考中', 'Thinking'],
  workStatusUnavailable: ['暂不可用', 'Unavailable'],
  progressSummary: ['{{working}} 进行中 · {{queued}} 排队 · {{completed}} 完成', '{{working}} active · {{queued}} queued · {{completed}} completed'],
  conversation: ['助手', 'Assistant'],
  board: ['共享数据板', 'Shared board'],
  communication: ['节点通信', 'Node messages'],
  resources: ['数据源与能力', 'Sources & abilities'],
  scripts: ['脚本管理器', 'Script manager'],
  tasks: ['工作任务', 'Tasks'],
  ready: ['就绪', 'Ready'],
  idle: ['空闲', 'Idle'],
  working: ['工作中', 'Working'],
  preparing: ['准备环境', 'Preparing environment'],
  recovering: ['恢复中', 'Recovering'],
  recoveryNotice: ['请求暂时失败，将自动继续（第 {{attempt}} 次恢复）。', 'The request failed temporarily. Continuing automatically (recovery {{attempt}}).'],
  recoveryNext: ['下次尝试：{{time}}（仍遵守节点调用频率限制）', 'Next attempt: {{time}} (node call-rate limits still apply)'],
  recoveryDeadline: ['自动恢复截止：{{time}}', 'Automatic recovery deadline: {{time}}'],
  refreshNode: ['刷新节点', 'Refresh node'],
  retryNodeNow: ['立即重试', 'Retry now'],
  nodeRefreshHint: ['暂时故障最多自动恢复 10 分钟。登录、余额或权限问题请先处理，再刷新以继续原任务；执行结果不明时仅重置节点，不自动重跑。', 'Transient failures recover automatically for up to 10 minutes. Resolve login, billing or permission issues before refreshing to continue the task. Unknown outcomes only reset the node and are not replayed.'],
  error: ['异常', 'Error'],
  queued: ['排队中', 'Queued'],
  queueBlocked: ['受阻，暂时无法继续', 'Blocked'],
  queueBlockedCount: ['{{count}} 项受阻', '{{count}} blocked'],
  queueNextStep: ['请查看下方原因；补充所需信息或说明如何处理后，发送给智能体。也可以点击“检查并继续”重新评估。', 'Review the reasons below, then send the needed information or instructions. You can also select “Check and continue” to reassess.'],
  queueInspect: ['检查并继续', 'Check and continue'],
  goalChanged: ['目标已更新（{{detail}}），旧任务需要重新规划', 'Goal changed ({{detail}}); this task needs replanning'],
  goalCancelled: ['目标已取消：{{detail}}', 'Goal cancelled: {{detail}}'],
  dependencyCancelled: ['前置任务已取消：{{detail}}，需要重新规划依赖', 'Dependency cancelled: {{detail}}; replan dependencies'],
  dependencyMissing: ['找不到前置任务：{{detail}}，需要修正依赖', 'Missing dependency: {{detail}}; correct dependencies'],
  dependencyFailed: ['前置任务失败：{{detail}}，需要修复或重试', 'Dependency failed: {{detail}}; repair or retry it'],
  dependencyWaiting: ['等待前置任务完成并通过验收：{{detail}}', 'Waiting for dependency completion and acceptance: {{detail}}'],
  planBlocked: ['计划受阻：{{detail}}', 'Plan blocked: {{detail}}'],
  running: ['运行中', 'Running'],
  completed: ['已完成', 'Completed'],
  failed: ['失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'],
  stopped: ['已停止', 'Stopped'],
  untracked: ['进程状态待确认', 'Process status unknown'],
  missing: ['文件缺失', 'File missing'],
  openSession: ['查看会话与审批', 'View session & approvals'],
  editNode: ['编辑节点', 'Edit node'],
  inspect: ['检查并整理', 'Inspect & summarize'],
  stop: ['停止', 'Stop'],
  stopAll: ['停止全部工作', 'Stop all work'],
  messagePlaceholder: ['告诉主智能体你想完成什么…', 'Tell the coordinator what you want to accomplish…'],
  send: ['发送', 'Send'],
  introMessage: ['助手已准备就绪。向主智能体描述目标，它会通过工作节点完成任务并向你汇报。', 'Your assistant is ready. Describe your goal to the coordinator; workers will execute it and report back.'],
  liveActivity: ['实时工作动态', 'Live activity'],
  nodeActivity: ['节点动态', 'Node activity'],
  thinkingSummary: ['思考摘要', 'Thinking summary'],
  toolActivity: ['工具操作', 'Tool activity'],
  waitingPermission: ['等待授权', 'Waiting for approval'],
  permissionInbox: ['需要你的授权', 'Your approval is needed'],
  permissionHistory: ['最近授权记录', 'Recent approval decisions'],
  permissionManagement: ['权限管理', 'Permission management'],
  permissionManagementHint: ['所有节点共用当前工作区的审批列表。行动门逐次批准，不能共享；历史共享授权可查看与撤销。', 'All nodes use this workspace approval inbox. Action Gates require approval for each invocation and cannot be shared. Historic shared grants can be viewed and revoked.'],
  sharedPermissions: ['全队共享授权', 'Shared team approvals'],
  noSharedPermissions: ['暂无历史共享授权。新的行动门只能逐次批准。', 'No historic shared grants. New Action Gates require approval for each invocation.'],
  noPendingPermissions: ['当前没有待审批的权限申请。', 'No approval requests are pending.'],
  approveForTeam: ['全队记住此操作', 'Remember for all nodes'],
  sharedApprovalHint: ['全队授权会保存到当前工作区，仅复用相同工具、操作、执行目标与工作环境。可在权限管理中撤销；普通授权仍只对本轮有效。', 'Team approvals persist in this workspace and reuse only the same tool, operation, execution target, and environment. Revoke them in Permission management. Ordinary approvals still last only for this turn.'],
  revokeSharedPermission: ['撤销共享授权', 'Revoke shared approval'],
  searchPermissions: ['搜索工具、目标或操作…', 'Search tools, targets, or operations…'],
  noMatchingPermissions: ['没有匹配的权限。', 'No matching approvals.'],
  sharedPermissionCreator: ['由 {{name}} 的申请建立 · {{time}}', 'Created from {{name}}’s request · {{time}}'],
  permissionEnvironmentMismatch: ['属于其他工作环境，当前不会自动复用', 'Bound to another environment; not reused here'],
  fullControlPermissionHint: ['完全控制已开启：跳过所有人工审批、行动门和自动审查，范围内的等待操作自动恢复。关闭后恢复审批规则。', 'Full control is on: all human approvals, Action Gates and Auto-review are skipped, and pending operations within the boundary resume automatically. Turn it off to restore approval rules.'],
  approvalArchived: ['历史审批', 'Archived approval'],
  approvalDetails: ['查看审批详情', 'View approval details'],
  approvalReason: ['审批原因', 'Reason'],
  approved: ['已授权此操作', 'Operation approved'],
  denied: ['已拒绝', 'Denied'],
  expired: ['已过期', 'Expired'],
  approvalCount: ['{{count}} 项操作等待授权', '{{count}} operations await approval'],
  approvalOwner: ['{{name}} 请求授权', '{{name}} requests approval'],
  approvalTarget: ['操作目标', 'Target'],
  approvalOperation: ['操作内容', 'Operation'],
  approvalScope: ['权限范围', 'Permission boundary'],
  outsideEnvironment: ['工作环境之外', 'Outside the work environment'],
  hostOperation: ['宿主系统', 'Host system'],
  clientOperation: ['当前客户端', 'Current client'],
  sourceOperation: ['指定数据源', 'Specified source'],
  environmentOperation: ['当前工作环境', 'Current work environment'],
  exactApprovalHint: ['只授权当前节点执行所示操作，本轮结束或授权过期后失效。', 'Authorize only this node and operation. The grant ends with the current turn or its expiry.'],
  actionGateApprovalHint: ['只批准当前节点的这一次调用，完整参数和环境必须匹配；不能记住、共享或扩大权限。', 'Approve this node and invocation once. The complete parameters and environment must match. Approval cannot be remembered, shared or expand permissions.'],
  approveInvocation: ['批准此次调用', 'Approve this invocation'],
  approveThisTurn: ['授权此操作（本轮）', 'Approve operation for this turn'],
  allowOnce: ['允许一次', 'Allow once'],
  deny: ['拒绝', 'Deny'],
  sendWhileWorking: ['工作继续进行，你可以补充目标或要求', 'Work continues. You can add goals or instructions.'],
  noTasks: ['尚未分配工作', 'No tasks assigned yet'],
  createTask: ['分配任务', 'Assign task'],
  taskTitle: ['任务标题', 'Task title'],
  taskInstructions: ['工作说明', 'Instructions'],
  assignedNode: ['执行节点', 'Worker'],
  automatic: ['自动选择空闲工作节点', 'Choose an available worker'],
  result: ['结果', 'Result'],
  createdAt: ['创建于', 'Created'],
  emptyBoard: ['共享数据板还没有内容。节点可以在这里保存发现、进展和工作结果。', 'The board is empty. Nodes can share findings, progress and results here.'],
  addBoardItem: ['添加共享内容', 'Add shared entry'],
  boardTitle: ['标题', 'Title'],
  content: ['内容', 'Content'],
  edit: ['编辑', 'Edit'],
  delete: ['删除', 'Delete'],
  revision: ['版本 {{revision}}', 'Revision {{revision}}'],
  boardHint: ['所有节点共享；更新需要匹配版本，避免覆盖其他节点的修改。', 'Shared by all nodes. Updates require the current revision to prevent overwriting another node.'],
  from: ['发送节点', 'From node'],
  to: ['接收节点', 'To node'],
  broadcast: ['所有节点', 'All nodes'],
  messageBody: ['消息内容', 'Message'],
  user: ['你', 'You'],
  system: ['系统', 'System'],
  noMessages: ['暂无节点通信记录', 'No node messages yet'],
  communicationHint: ['消息携带发送者、接收者、类型、时间及任务关联。节点按任务汇报进展，通过共享数据板交接信息。', 'Messages carry sender, recipient, type, time and task links. Nodes report progress and use the board to hand off information.'],
  sources: ['数据源', 'Data sources'],
  sourcesHint: ['复用当前工作区的数据源。团队授权后，可在每个节点中进一步选择；外部数据源权限还由原有数据源设置控制。', 'Reuse workspace sources. Authorize them for the team, then select them per node. External access also follows the existing source permissions.'],
  noSources: ['当前工作区没有数据源。可在侧栏“数据源”中添加。', 'No sources in this workspace. Add one from Sources in the sidebar.'],
  abilities: ['能力档案库', 'Ability profiles'],
  abilityHint: ['保存可复用的工作说明，并绑定到指定节点。', 'Save reusable instructions and assign them to specific nodes.'],
  addAbility: ['添加能力档案', 'Add ability profile'],
  abilityName: ['档案名字', 'Profile name'],
  instructions: ['能力指令', 'Instructions'],
  noAbilities: ['尚无能力档案', 'No ability profiles yet'],
  workspaceSkills: ['工作区技能', 'Workspace skills'],
  importSkill: ['导入为能力档案', 'Import as profile'],
  scriptHint: ['监测用户或节点登记的脚本，将文件变更和运行结果同步给节点。文件变更不会自动运行脚本。', 'Watch scripts registered by you or a node and share changes and run results with nodes. File changes never run scripts automatically.'],
  addScript: ['登记脚本', 'Register script'],
  noScripts: ['尚未登记脚本', 'No scripts registered yet'],
  scriptName: ['脚本名字', 'Script name'],
  scriptPath: ['脚本路径', 'Script path'],
  scriptPathHint: ['必须位于工作目录内，支持 .js、.mjs、.cjs、.py、.sh、.ps1。', 'Must be inside the work folder. Supports .js, .mjs, .cjs, .py, .sh and .ps1.'],
  scriptPathFullControlHint: ['可使用工作目录内的相对路径，或执行机器上目录外的绝对路径。支持 .js、.mjs、.cjs、.py、.sh、.ps1。', 'Use a relative path inside the work folder or an absolute path elsewhere on the execution machine. Supports .js, .mjs, .cjs, .py, .sh and .ps1.'],
  hostScriptPermissions: ['宿主脚本没有沙箱隔离。受限控制需开启程序能力并确认当前脚本、参数和环境；完全控制无需审批。', 'Host scripts have no sandbox isolation. Restricted control requires program capability and approval of the current script, arguments and environment; full control skips approval.'],
  manualScriptPermissions: ['手动运行脚本需要开启“运行程序和脚本”。', 'Manual scripts require Run programs and scripts to be enabled.'],
  scriptArgs: ['参数（每行一个）', 'Arguments (one per line)'],
  timeout: ['运行超时（秒）', 'Timeout (seconds)'],
  syncNode: ['同步给节点', 'Notify node'],
  runScript: ['批准并运行', 'Approve and run'],
  runScriptDirect: ['运行', 'Run'],
  changedAt: ['文件变更', 'File changed'],
  exitCode: ['退出码', 'Exit code'],
  loading: ['正在加载超级智能体…', 'Loading Super Agent…'],
  loadFailed: ['无法加载超级智能体', 'Could not load Super Agent'],
  retry: ['重试', 'Retry'],
  workspaceRequired: ['先选择工作区', 'Choose a workspace first'],
  workspaceRequiredDescription: ['每个工作区拥有独立的超级智能体、数据板和工作环境。', 'Each workspace has its own Super Agent, shared board and work environment.'],
  saveFailed: ['保存失败', 'Save failed'],
  commandFailed: ['操作失败', 'Action failed'],
  nameRequired: ['请填写助手名字。', 'Enter an assistant name.'],
  nodesRequired: ['需要一个意图主节点、一个编排节点和至少一个工作节点。', 'Configure one intent node, one orchestrator and at least one worker.'],
  nodeRequired: ['请为每个节点填写名字，并选择已登录的 AI 连接与模型。', 'Each node needs a name, an authenticated AI connection and a model.'],
  invalidSpeed: ['工作速度必须为每分钟 0.1 至 60 轮。', 'Work rate must be between 0.1 and 60 turns per minute.'],
  pathRequired: ['请指定工作目录。', 'Choose a working directory.'],
  imageRequired: ['请填写容器镜像。', 'Enter a container image.'],
  vmWorkspaceRequired: ['请指定已连接虚拟机的工作区 ID。', 'Enter the connected VM workspace ID.'],
  invalidInterval: ['检查间隔必须为 1 至 1440 分钟。', 'Inspection interval must be between 1 and 1440 minutes.'],
  unsaved: ['修改后保存才会应用到节点。', 'Save changes to apply them to the nodes.'],
  lastInspection: ['上次检查', 'Last inspection'],
  teamStatus: ['团队状态', 'Team status'],
  pendingApproval: ['所有节点的授权请求会汇总到主聊天中。', 'Approval requests from all nodes appear in the main chat.'],
  confirmDelete: ['确认删除“{{name}}”？', 'Delete “{{name}}”?'],
  inspectionKind: ['检查', 'Inspection'],
  messageKind: ['消息', 'Message'],
  taskKind: ['任务', 'Task'],
  resultKind: ['结果', 'Result'],
  scriptKind: ['脚本', 'Script'],
  chatKind: ['对话', 'Chat'],
  errorKind: ['异常', 'Error'],
} as const

export type SuperAgentTextKey = keyof typeof strings
export type SuperAgentText = (key: SuperAgentTextKey, values?: Record<string, string | number>) => string

/** Defaults also support standalone previews without the application's locale registry. */
export function useSuperAgentText(): SuperAgentText {
  const { t, i18n } = useTranslation()
  return (key, values) => t(`superAgent.${key}`, {
    defaultValue: strings[key][(i18n.resolvedLanguage ?? i18n.language)?.startsWith('zh') ? 0 : 1],
    ...values,
  })
}

export function nodeModels(connection: LlmConnectionWithStatus | undefined): string[] {
  if (!connection) return []
  const available = connection.models?.length
    ? connection.models
    : getModelsForProviderType(connection.providerType, connection.piAuthProvider)
  const group = connection.oauthProvider === 'tokennest'
    ? connection.channelGroups?.find(item => item.id === connection.channelGroup)
    : undefined
  const allowed = group?.models?.length ? new Set(group.models) : undefined
  return [...new Set(available.map(item => typeof item === 'string' ? item : item.id))]
    .filter(id => !isImageGenerationModelId(id) && (!allowed || allowed.has(id)))
}

export function createNode(
  role: SuperAgentNode['role'],
  connections: LlmConnectionWithStatus[],
  text: SuperAgentText,
  preferredSlug?: string,
): SuperAgentNode {
  const ready = connections.filter(item => item.isAuthenticated && nodeModels(item).length)
  const connection = ready.find(item => item.slug === preferredSlug) ?? ready.find(item => item.isDefault) ?? ready[0]
  const models = nodeModels(connection)
  return {
    id: crypto.randomUUID(), role,
    name: text(role === 'coordinator' ? 'coordinatorName' : role === 'orchestrator' ? 'orchestratorName' : 'workerName'),
    avatar: role === 'coordinator' ? '✦' : '◈',
    description: text(role === 'coordinator' ? 'coordinatorDescription' : role === 'orchestrator' ? 'orchestratorDescription' : 'workerDescription'),
    llmConnection: connection?.slug ?? '',
    model: connection?.defaultModel && models.includes(connection.defaultModel) ? connection.defaultModel : models[0] ?? '',
    thinkingLevel: role === 'coordinator' ? 'high' : 'medium',
    maxCallsPerMinute: 6, intelligenceRating: 3, workPreferences: '',
    sourceSlugs: [], abilityProfileIds: [],
  }
}

export function createConfig(connections: LlmConnectionWithStatus[], text: SuperAgentText, preferredSlug?: string): SuperAgentConfig {
  const config: SuperAgentConfig = {
    version: 1, name: text('defaultName'), avatar: '✦',
    nodes: [createNode('coordinator', connections, text, preferredSlug), createNode('orchestrator', connections, text, preferredSlug), createNode('worker', connections, text, preferredSlug)],
    idleInspectionMinutes: 60,
    continuousWork: true,
    execution: { connectionConcurrency: 4, connectionCallsPerMinute: 60, stallMinutes: 15, maxResumeAttempts: 3 },
    environment: {
      kind: 'folder', workingDirectory: '', permissionMode: 'allow-all', fullControl: true,
      permissions: { readFiles: true, writeFiles: false, runPrograms: false, browser: false },
    },
    sourceSlugs: [], abilityProfiles: [], scripts: [],
  }
  const connection = connections.find(item => item.slug === config.nodes[0].llmConnection && item.isAuthenticated && nodeModels(item).length)
  return connection ? applyPreset(config, 'daily', connection, text) : config
}

/** Missing legacy settings inherit full control; an explicit limited mode is preserved. */
export function withExecuteMode(config: SuperAgentConfig): SuperAgentConfig {
  return { ...config, environment: { ...config.environment, permissionMode: 'allow-all', fullControl: config.environment.fullControl !== false } }
}

export function scriptAccessGranted(environment: SuperAgentEnvironment): boolean {
  return environment.fullControl === true || environment.permissions.runPrograms
}

export function applyPreset(config: SuperAgentConfig, preset: SuperAgentPreset, connection: LlmConnectionWithStatus, text: SuperAgentText): SuperAgentConfig {
  const executionConfig = withExecuteMode(config)
  if (preset === 'custom') return executionConfig
  const models = nodeModels(connection)
  if (!connection.isAuthenticated || !models.length) return executionConfig
  const choices = presetModels(models, connection.defaultModel)
  const recipe = PRESET_RECIPES[preset]
  const used = new Set<string>()
  const nodes: SuperAgentNode[] = recipe.nodes.map(item => {
    const old = config.nodes.find(node => !used.has(node.id) && node.role === item.role
      && (item.role !== 'worker' || nodePresetProfile(node, text) === item.profile))
    if (old) used.add(old.id)
    return {
      ...createNode(item.role, [connection], text, connection.slug),
      ...(old ? { id: old.id, sourceSlugs: [...old.sourceSlugs], abilityProfileIds: [...old.abilityProfileIds] } : {}),
      presetProfile: item.profile, thinkingMode: old?.thinkingMode ?? 'task' as const,
      capabilities: [...new Set([...(old?.capabilities ?? []).filter(capability => capability !== old?.presetProfile), item.profile])],
      name: text(`${item.profile}Name`), description: text(`${item.profile}Description`), workPreferences: text(`${item.profile}Preferences`),
      model: choices[item.model], thinkingLevel: /luna/i.test(choices[item.model]) ? 'max' : item.thinking,
      maxCallsPerMinute: item.rate, intelligenceRating: item.rating,
    }
  })
  // Keep extra resource-bound nodes so choosing a smaller team never orphans scripts or bindings.
  nodes.push(...config.nodes.filter(node => !nodes.some(item => item.id === node.id)
    && (node.sourceSlugs.length || node.abilityProfileIds.length || node.capabilities?.some(capability => capability !== node.presetProfile) || config.scripts.some(script => script.nodeId === node.id))))
  return { ...executionConfig, nodes, requirements: presetRequirements(preset), workflow: { ...recipe.workflow }, continuousWork: recipe.continuousWork, idleInspectionMinutes: recipe.idleInspectionMinutes }
}

export function configError(config: SuperAgentConfig, connections: LlmConnectionWithStatus[], text: SuperAgentText): string | null {
  if (!config.name.trim()) return text('nameRequired')
  if (config.workflow?.independentReview && config.nodes.filter(node => node.role === 'worker').length < 2) return text('reviewWorkersRequired')
  // Loaded legacy teams can still change permissions/intervals while migration waits for idle.
  if (config.nodes.filter(node => node.role === 'coordinator').length !== 1 || config.nodes.filter(node => node.role === 'orchestrator').length > 1 || !config.nodes.some(node => node.role === 'worker')) return text('nodesRequired')
  for (const node of config.nodes) {
    const connection = connections.find(item => item.slug === node.llmConnection)
    const models = nodeModels(connection)
    if (!node.name.trim() || !node.model.trim() || !connection?.isAuthenticated || (models.length > 0 && !models.includes(node.model))) return text('nodeRequired')
    if (!Number.isFinite(node.maxCallsPerMinute) || node.maxCallsPerMinute < 0.1 || node.maxCallsPerMinute > 60) return text('invalidSpeed')
  }
  if (!config.environment.workingDirectory.trim()) return text('pathRequired')
  if (config.environment.kind === 'sandbox' && !config.environment.sandbox?.image.trim()) return text('imageRequired')
  if (config.environment.kind === 'vm' && !config.environment.vm?.workspaceId.trim()) return text('vmWorkspaceRequired')
  if (!Number.isInteger(config.idleInspectionMinutes) || config.idleInspectionMinutes < 1 || config.idleInspectionMinutes > 1440) return text('invalidInterval')
  return null
}

export function formatTimestamp(value?: number, includeSeconds = false): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(includeSeconds ? { second: '2-digit' as const } : {}) }).format(value)
}
