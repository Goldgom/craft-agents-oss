import { useTranslation } from 'react-i18next'
import { getModelsForProviderType, isImageGenerationModelId } from '@config/llm-connections'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import type { SuperAgentConfig, SuperAgentEnvironment, SuperAgentNode } from '@craft-agent/shared/super-agent'
import { PRESET_RECIPES, presetModels, presetStrings, type SuperAgentPreset } from './super-agent-presets'
export type { SuperAgentPreset } from './super-agent-presets'

const strings = {
  ...presetStrings,
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
  coordinator: ['主智能体', 'Coordinator'],
  worker: ['工作节点', 'Worker'],
  coordinatorName: ['主智能体', 'Coordinator'],
  workerName: ['执行助手', 'Execution assistant'],
  researcherName: ['研究助手', 'Research assistant'],
  coordinatorDescription: ['与用户交互、分配工作、定期检查节点状态并整理结果。', 'Talk with the user, assign work, inspect node status and assemble results.'],
  workerDescription: ['执行分配的工作，向主节点报告进展、发现和结果。', 'Complete assigned work and report progress, findings and results.'],
  coordinatorRule: ['主节点只负责用户交互、理解需求和转交结果；问答、分析、工具操作与验证均交工作节点。没有必要回复时保持静默，主节点思考和内部活动不在聊天中展示。', 'The main agent handles user interaction, understands needs and conveys results. Workers answer questions, analyze, use tools and verify. Remain silent unless a reply is useful; main-agent reasoning and internal activity stay out of chat.'],
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
  folderPrograms: ['文件夹模式中的宿主程序操作可能需要单独授权。容器沙箱可隔离程序执行。', 'Host program operations in folder mode may need scoped approval. A container sandbox isolates program execution.'],
  workingDirectory: ['工作目录', 'Working directory'],
  pickDirectory: ['选择文件夹', 'Choose folder'],
  containerImage: ['容器镜像', 'Container image'],
  containerRuntime: ['容器运行时', 'Container runtime'],
  vmWorkspace: ['虚拟机工作区 ID', 'VM workspace ID'],
  permissions: ['权限控制', 'Permissions'],
  fullControl: ['完全控制', 'Full control'],
  fullControlDescription: ['开启后，所有节点无需工具审批即可读写文件、运行程序、操作浏览器，并访问工作目录之外的位置。', 'When enabled, all nodes can read and write files, run programs, use the browser and access locations outside the work folder without tool approvals.'],
  fullControlBoundary: ['操作使用已连接宿主机、客户端或虚拟机的账号权限；所选沙箱与虚拟机的隔离仍然生效。', 'Operations use the connected host, client or VM account. The selected sandbox and VM isolation still apply.'],
  fullControlEnabled: ['完全控制（无需工具审批）', 'Full control (no tool approvals)'],
  advancedPermissions: ['高级权限', 'Advanced permissions'],
  limitedControl: ['按高级权限执行', 'Use advanced permissions'],
  readFiles: ['读取文件', 'Read files'],
  writeFiles: ['修改文件', 'Write files'],
  runPrograms: ['运行程序和脚本', 'Run programs and scripts'],
  browser: ['操作浏览器', 'Control browser'],
  permissionMode: ['执行模式', 'Execution mode'],
  allowAll: ['执行（Execute）', 'Execute'],
  executionModeHint: ['主节点与所有工作节点统一使用执行模式；具体操作仍受能力开关、工作环境和单次授权约束。', 'The coordinator and all workers use Execute. Capability switches, the work environment and scoped approvals still control access.'],
  permissionHint: ['已开启的能力在授权范围内直接执行，需要额外授权的操作会显示在主聊天中。', 'Enabled capabilities execute within their authorized scope. Operations needing additional approval appear in the main chat.'],
  next: ['下一步', 'Continue'],
  back: ['上一步', 'Back'],
  create: ['创建超级智能体', 'Create Super Agent'],
  save: ['保存设置', 'Save settings'],
  cancel: ['取消', 'Cancel'],
  setupComplete: ['已准备创建', 'Ready to create'],
  setupSummary: ['{{workers}} 个工作节点 · 1 个主节点 · 每 {{minutes}} 分钟检查', '{{workers}} workers · 1 coordinator · inspect every {{minutes}} minutes'],
  settings: ['设置', 'Settings'],
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
  permissionManagementHint: ['所有节点共用当前工作区的一份授权列表。可处理待审批申请，记住精确文件或程序操作，随时撤销共享授权。登录、管理员审批及未绑定稳定目标的浏览器操作仅支持本次授权；不会扩大到整个目录或全部工具。', 'All nodes share one approval list in this workspace. Review requests, remember exact file or program operations, and revoke shared approvals. Login, administrator approvals, and browser operations without stable targets remain one-time approvals; no entire directory or tool is granted.'],
  sharedPermissions: ['全队共享授权', 'Shared team approvals'],
  noSharedPermissions: ['暂无共享授权。审批时选择「全队记住此操作」后会显示在这里。', 'No shared approvals. Choose “Remember for all nodes” when reviewing a request.'],
  noPendingPermissions: ['当前没有待审批的权限申请。', 'No approval requests are pending.'],
  approveForTeam: ['全队记住此操作', 'Remember for all nodes'],
  sharedApprovalHint: ['全队授权会保存到当前工作区，仅复用相同工具、操作、执行目标与工作环境。可在权限管理中撤销；普通授权仍只对本轮有效。', 'Team approvals persist in this workspace and reuse only the same tool, operation, execution target, and environment. Revoke them in Permission management. Ordinary approvals still last only for this turn.'],
  revokeSharedPermission: ['撤销共享授权', 'Revoke shared approval'],
  searchPermissions: ['搜索工具、目标或操作…', 'Search tools, targets, or operations…'],
  noMatchingPermissions: ['没有匹配的权限。', 'No matching approvals.'],
  sharedPermissionCreator: ['由 {{name}} 的申请建立 · {{time}}', 'Created from {{name}}’s request · {{time}}'],
  permissionEnvironmentMismatch: ['属于其他工作环境，当前不会自动复用', 'Bound to another environment; not reused here'],
  fullControlPermissionHint: ['完全控制已开启：工作节点按完全控制执行，撤销共享授权不会关闭完全控制。若需要逐项审批，请在工作环境中关闭完全控制。', 'Full control is enabled. Workers follow full control; revoking a shared approval does not disable it. Turn full control off in Environment settings to require individual approvals.'],
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
  hostScriptPermissions: ['在宿主文件夹运行脚本需要明确开启全部能力。脚本有宿主权限；需要隔离时选择容器沙箱。', 'Host scripts require all capabilities to be explicitly enabled. They run with host access; use a container sandbox for isolation.'],
  manualScriptPermissions: ['手动运行脚本需要开启“运行程序和脚本”。', 'Manual scripts require Run programs and scripts to be enabled.'],
  scriptArgs: ['参数（每行一个）', 'Arguments (one per line)'],
  timeout: ['运行超时（秒）', 'Timeout (seconds)'],
  syncNode: ['同步给节点', 'Notify node'],
  runScript: ['运行脚本', 'Run script'],
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
  nodesRequired: ['必须配置且仅配置一个主节点，以及至少一个工作节点。', 'Configure exactly one coordinator and at least one worker.'],
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
    name: text(role === 'coordinator' ? 'coordinatorName' : 'workerName'),
    avatar: role === 'coordinator' ? '✦' : '◈',
    description: text(role === 'coordinator' ? 'coordinatorDescription' : 'workerDescription'),
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
    nodes: [createNode('coordinator', connections, text, preferredSlug), createNode('worker', connections, text, preferredSlug)],
    idleInspectionMinutes: 60,
    continuousWork: true,
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
  return environment.fullControl === true || (environment.permissions.runPrograms
    && (environment.kind !== 'folder' || Object.values(environment.permissions).every(Boolean)))
}

export function applyPreset(config: SuperAgentConfig, preset: SuperAgentPreset, connection: LlmConnectionWithStatus, text: SuperAgentText): SuperAgentConfig {
  const executionConfig = withExecuteMode(config)
  if (preset === 'custom') return executionConfig
  const models = nodeModels(connection)
  if (!connection.isAuthenticated || !models.length) return executionConfig
  const choices = presetModels(models, connection.defaultModel)
  const recipe = PRESET_RECIPES[preset]
  const existing = [config.nodes.find(node => node.role === 'coordinator'), ...config.nodes.filter(node => node.role === 'worker')]
  const nodes = recipe.nodes.map((item, index) => {
    const old = existing[index]
    return {
      ...createNode(index === 0 ? 'coordinator' : 'worker', [connection], text, connection.slug),
      ...(old ? { id: old.id, sourceSlugs: [...old.sourceSlugs], abilityProfileIds: [...old.abilityProfileIds] } : {}),
      name: text(`${item.profile}Name`), description: text(`${item.profile}Description`), workPreferences: text(`${item.profile}Preferences`),
      model: choices[item.model], thinkingLevel: /luna/i.test(choices[item.model]) ? 'max' : item.thinking,
      maxCallsPerMinute: item.rate, intelligenceRating: item.rating,
    }
  })
  // Keep extra resource-bound nodes so choosing a smaller team never orphans scripts or bindings.
  nodes.push(...config.nodes.filter(node => !nodes.some(item => item.id === node.id)
    && (node.sourceSlugs.length || node.abilityProfileIds.length || config.scripts.some(script => script.nodeId === node.id))))
  return { ...executionConfig, nodes, continuousWork: recipe.continuousWork, idleInspectionMinutes: recipe.idleInspectionMinutes }
}

export function configError(config: SuperAgentConfig, connections: LlmConnectionWithStatus[], text: SuperAgentText): string | null {
  if (!config.name.trim()) return text('nameRequired')
  if (config.nodes.filter(node => node.role === 'coordinator').length !== 1 || !config.nodes.some(node => node.role === 'worker')) return text('nodesRequired')
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
