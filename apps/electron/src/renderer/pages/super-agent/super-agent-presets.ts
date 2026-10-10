import type { SuperAgentConfig, SuperAgentNode } from '@craft-agent/shared/super-agent'

export const SUPER_AGENT_PRESETS = ['daily', 'coding', 'research', 'work', 'operations'] as const
export type SuperAgentPreset = 'custom' | typeof SUPER_AGENT_PRESETS[number]
type Profile = 'intentLead' | 'operationsLead' | 'diagnostician' | 'operator' | 'operationsReviewer' | 'dailyLead' | 'dailyWorker' | 'organizer' | 'collaborationAssistant' | 'codeLead' | 'developer' | 'tester' | 'codeReviewer' | 'codeAssistant' | 'checkRunner' | 'researchLead' | 'literature' | 'experiment' | 'researchReviewer' | 'workLead' | 'analyst' | 'producer' | 'workReviewer'
type NodeRecipe = { role: SuperAgentNode['role']; profile: Profile; model: 'standard' | 'fast' | 'deep'; thinking: SuperAgentNode['thinkingLevel']; rate: number; rating: number }

/** Scenario and role defaults live together; the runtime protocol remains on the server. */
export const PRESET_RECIPES: Record<Exclude<SuperAgentPreset, 'custom'>, { workflow: NonNullable<SuperAgentConfig['workflow']>; continuousWork: boolean; idleInspectionMinutes: number; nodes: NodeRecipe[] }> = {
  daily: { workflow: { pattern: 'lightweight', maxParallelTasks: 2, independentReview: false }, continuousWork: true, idleInspectionMinutes: 60, nodes: [
    { role: 'coordinator', profile: 'intentLead', model: 'standard', thinking: 'medium', rate: 8, rating: 3 },
    { role: 'orchestrator', profile: 'dailyLead', model: 'standard', thinking: 'medium', rate: 6, rating: 4 },
    { role: 'worker', profile: 'dailyWorker', model: 'fast', thinking: 'medium', rate: 8, rating: 3 },
    { role: 'worker', profile: 'organizer', model: 'fast', thinking: 'max', rate: 8, rating: 2 },
    { role: 'worker', profile: 'collaborationAssistant', model: 'fast', thinking: 'max', rate: 8, rating: 2 },
  ] },
  coding: { workflow: { pattern: 'development', maxParallelTasks: 3, independentReview: true }, continuousWork: true, idleInspectionMinutes: 10, nodes: [
    { role: 'coordinator', profile: 'intentLead', model: 'standard', thinking: 'medium', rate: 8, rating: 3 },
    { role: 'orchestrator', profile: 'codeLead', model: 'standard', thinking: 'high', rate: 6, rating: 4 },
    { role: 'worker', profile: 'developer', model: 'standard', thinking: 'high', rate: 6, rating: 4 },
    { role: 'worker', profile: 'tester', model: 'standard', thinking: 'medium', rate: 6, rating: 4 },
    { role: 'worker', profile: 'codeReviewer', model: 'deep', thinking: 'high', rate: 4, rating: 5 },
    { role: 'worker', profile: 'codeAssistant', model: 'fast', thinking: 'max', rate: 8, rating: 2 },
    { role: 'worker', profile: 'checkRunner', model: 'fast', thinking: 'max', rate: 6, rating: 2 },
  ] },
  research: { workflow: { pattern: 'research', maxParallelTasks: 4, independentReview: true }, continuousWork: true, idleInspectionMinutes: 30, nodes: [
    { role: 'coordinator', profile: 'intentLead', model: 'standard', thinking: 'medium', rate: 8, rating: 3 },
    { role: 'orchestrator', profile: 'researchLead', model: 'deep', thinking: 'high', rate: 4, rating: 5 },
    { role: 'worker', profile: 'literature', model: 'standard', thinking: 'high', rate: 6, rating: 4 },
    { role: 'worker', profile: 'experiment', model: 'standard', thinking: 'high', rate: 6, rating: 4 },
    { role: 'worker', profile: 'researchReviewer', model: 'deep', thinking: 'high', rate: 4, rating: 5 },
    { role: 'worker', profile: 'organizer', model: 'fast', thinking: 'max', rate: 8, rating: 2 },
    { role: 'worker', profile: 'collaborationAssistant', model: 'fast', thinking: 'max', rate: 8, rating: 2 },
  ] },
  work: { workflow: { pattern: 'deliverables', maxParallelTasks: 3, independentReview: false }, continuousWork: true, idleInspectionMinutes: 15, nodes: [
    { role: 'coordinator', profile: 'intentLead', model: 'standard', thinking: 'medium', rate: 8, rating: 3 },
    { role: 'orchestrator', profile: 'workLead', model: 'standard', thinking: 'medium', rate: 8, rating: 4 },
    { role: 'worker', profile: 'analyst', model: 'standard', thinking: 'medium', rate: 8, rating: 4 },
    { role: 'worker', profile: 'producer', model: 'fast', thinking: 'medium', rate: 10, rating: 3 },
    { role: 'worker', profile: 'workReviewer', model: 'standard', thinking: 'medium', rate: 6, rating: 4 },
    { role: 'worker', profile: 'organizer', model: 'fast', thinking: 'max', rate: 8, rating: 2 },
    { role: 'worker', profile: 'collaborationAssistant', model: 'fast', thinking: 'max', rate: 8, rating: 2 },
  ] },
  operations: { workflow: { pattern: 'incident', maxParallelTasks: 2, independentReview: true }, continuousWork: false, idleInspectionMinutes: 10, nodes: [
    { role: 'coordinator', profile: 'intentLead', model: 'standard', thinking: 'medium', rate: 8, rating: 3 },
    { role: 'orchestrator', profile: 'operationsLead', model: 'deep', thinking: 'high', rate: 6, rating: 5 },
    { role: 'worker', profile: 'diagnostician', model: 'standard', thinking: 'high', rate: 6, rating: 4 },
    { role: 'worker', profile: 'operator', model: 'standard', thinking: 'high', rate: 6, rating: 4 },
    { role: 'worker', profile: 'operationsReviewer', model: 'deep', thinking: 'high', rate: 4, rating: 5 },
    { role: 'worker', profile: 'organizer', model: 'fast', thinking: 'max', rate: 8, rating: 2 },
    { role: 'worker', profile: 'collaborationAssistant', model: 'fast', thinking: 'max', rate: 8, rating: 2 },
  ] },
}

/** Only select from the caller's authorized text models; one model is a valid fallback. */
export function presetModels(models: string[], defaultModel?: string): Record<NodeRecipe['model'], string> {
  const preferred = defaultModel && models.includes(defaultModel) ? defaultModel : models[0] ?? ''
  const find = (patterns: RegExp[], fallback: string) => patterns.map(pattern => models.find(id => pattern.test(id))).find(Boolean) ?? fallback
  const standard = find([/gpt-6\.1-sol/i, /gpt-6-sol/i, /sonnet/i, /gpt-5\.6-sol/i, /^(?!.*(?:mini|nano)).*codex/i], preferred)
  return {
    standard,
    fast: find([/gpt-6-luna/i, /gpt-5\.6-luna/i, /haiku|flash|mini|nano|luna/i], standard),
    deep: find([/astra/i, /opus/i, /reasoner/i, /(?:^|[-/])pro(?:$|[-/])/i], standard),
  }
}

export function nodePresetProfile(node: SuperAgentNode, text: (key: keyof typeof presetStrings) => string): string | undefined {
  if (node.presetProfile) return node.presetProfile
  const profiles = [...new Set(Object.values(PRESET_RECIPES).flatMap(recipe => recipe.nodes.map(item => item.profile)))]
  return profiles.find(profile => node.name === text(`${profile}Name`)
    || (presetStrings[`${profile}Name`] as readonly string[]).includes(node.name))
}

export function recommendedThinking(node: SuperAgentNode): SuperAgentNode['thinkingLevel'] {
  if (['organizer', 'collaborationAssistant', 'codeAssistant', 'checkRunner'].includes(node.presetProfile ?? '')) return 'low'
  if (node.role === 'coordinator' || ['dailyLead', 'dailyWorker', 'workLead', 'analyst', 'producer'].includes(node.presetProfile ?? '')) return 'medium'
  return 'high'
}

export function presetRequirements(preset: SuperAgentPreset): NonNullable<SuperAgentConfig['requirements']> {
  return { programs: preset === 'coding' ? ['git'] : preset === 'research' ? ['python3'] : preset === 'operations' ? ['sh'] : [], browser: preset === 'research' }
}

export const presetStrings = {
  intentLeadName: ['意图理解与用户交互', 'Intent and user interaction'],
  intentLeadDescription: ['理解目标、约束与验收条件，交给编排节点；转交结果和必要澄清。', 'Understand goals, constraints and acceptance; hand off to the orchestrator and relay results or clarifications.'],
  intentLeadPreferences: ['只处理用户意图和交互；通过 intent 交接，不拆任务、不执行工具。状态询问复用已有报告，不重新下达原目标。', 'Handle intent and interaction only. Hand off with intent; reuse existing reports for status requests.'],
  operations: ['故障诊断与运维', 'Incident response and operations'],
  operationsDescription: ['证据诊断 → 授权修复 → 独立验证；同一服务修改互斥，保留恢复检查点。', 'Evidence-based diagnosis, authorized remediation and independent verification, with exclusive service ownership and recovery checkpoints.'],
  operationsLeadName: ['故障流程编排', 'Incident orchestrator'],
  operationsLeadDescription: ['组织诊断、修复和验证，协调服务资源与恢复条件。', 'Coordinate diagnosis, remediation, service ownership and recovery conditions.'],
  operationsLeadPreferences: ['先派诊断收集具体请求、节点与时间窗口的证据。修复依赖诊断，只在用户已授权范围派发；同一服务使用独占 resources。复核任务用 reviewOf，恢复指标达标后依据证据验收；缺少关键授权或输入交意图主节点。', 'Gather request, node and time-window evidence before remediation. Use dependencies and exclusive service resources. Verify with reviewOf and accept using recovery evidence; route missing decisions to the intent node.'],
  diagnosticianName: ['故障诊断', 'Diagnostician'],
  diagnosticianDescription: ['读取实际日志、请求路径与运行状态，定位原因和影响范围。', 'Inspect logs, request paths and runtime state to locate causes and impact.'],
  diagnosticianPreferences: ['诊断阶段不改线上状态；保留时间、请求 ID、节点和原始错误，区分症状与原因，提供最小修复建议及验证指标。', 'Preserve timestamps, request IDs, nodes and errors. Separate symptoms and causes; propose minimal remediation and recovery checks.'],
  operatorName: ['修复执行', 'Remediation worker'],
  operatorDescription: ['执行已授权修复，记录变更与恢复检查点。', 'Perform authorized remediation and record changes and recovery checkpoints.'],
  operatorPreferences: ['只修改分配的服务与配置，执行前确认现状及恢复方法。记录实际操作、退出状态与结果；结果未知先检查，禁止盲目重试外部副作用。', 'Change assigned services and configuration only. Confirm current state and recovery steps; record operations and results. Inspect uncertain outcomes before retrying.'],
  operationsReviewerName: ['服务恢复验证', 'Recovery verifier'],
  operationsReviewerDescription: ['独立验证原故障路径、恢复指标与变更影响。', 'Independently verify the failing route, recovery metrics and change impact.'],
  operationsReviewerPreferences: ['等待修复产物，按同一版本验证具体请求路径、服务节点及时间窗口；健康检查不能单独证明原问题已解决。记录工具结果和未验证项，不自行修复。', 'Verify the actual failing route, node and time window on the remediated revision. Record results and gaps; health checks alone do not prove resolution.'],

  daily: ['日常助手', 'Daily assistant'],
  dailyDescription: ["意图主节点与轻量编排分离；日常执行、资料整理与辅助核对按需启用。", "Separate intent and lightweight planning; use daily execution, organization and artifact checks as needed."],
  coding: ['自主代码智能体', 'Autonomous coding agent'],
  codingDescription: ["依赖驱动工程流水线：开发 → 独立测试/审查 → 验收；文件修改归单一负责人。", "Dependency-driven engineering: development, independent testing and review, then acceptance with exclusive file ownership."],
  research: ['自主科研智能体', 'Autonomous research agent'],
  researchDescription: ["文献与数据准备并行，实验依赖已核实输入，独立复核方法与结论。", "Parallel literature and data preparation, experiments on verified inputs and independent review of methods and claims."],
  work: ['高效工作智能体', 'Efficient work agent'],
  workDescription: ["按交付物组织任务依赖图：输入整理 → 并行分析/制作 → 质检汇总。", "Organize a deliverable DAG: input preparation, parallel analysis and production, then quality review."],
  presetUnavailable: ['连接可用的文本模型后即可使用推荐方案。', 'Connect an available text model to use a recommended setup.'],
  presetReplaceHint: ['应用方案会更新节点分工、模型和持续工作设置；保留环境权限及已有资源绑定。保存后生效。', 'Applying a setup updates roles, models and continuous work. Environment permissions and existing resource bindings are retained. Save to apply.'],
  dailyLeadName: ["日常任务编排", "daily orchestrator"],
  dailyLeadDescription: ["拆解该场景意图，编排依赖、资源和证据验收。", "Plan scenario tasks, dependencies, resources and evidence-based acceptance."],
  dailyLeadPreferences: ["把用户意图交日常执行；简单任务执行者自检，资料提取与辅助核对按需启用。必要时创建 dependencies 和 acceptanceCriteria，保持短流程与低通信量。", "Use short flows with worker self-checks for simple tasks. Assign organization and artifact checks only when needed; declare dependencies and acceptance criteria."],
  dailyWorkerName: ['日常执行助手', 'Daily worker'],
  dailyWorkerDescription: ['完成检索、文件整理、日常文稿和已授权的生活事务。', 'Handle searches, file organization, everyday writing and authorized errands.'],
  dailyWorkerPreferences: ['先查看现有资料，使用最少必要工具完成任务。交付简洁结果、相关来源或文件路径及实际操作状态；日程、价格和时效信息以最新来源为准。对外发送、付款或预约遵循用户已给出的授权范围。', 'Inspect existing material and use only necessary tools. Return concise results, sources or file paths and actual status. Verify current schedules and prices. Follow the user’s authorization for sending, payment and booking.'],
  organizerName: ['资料提取与整理', 'Material extraction and organization'],
  organizerDescription: ['从指定材料提取字段、分类去重、整理索引与格式，不独立作复杂分析。', 'Extract fields, classify, deduplicate, index and format supplied material; leave complex analysis to specialists.'],
  organizerPreferences: ['只处理主节点指定的文件、来源和字段，按给定模板提取与整理，保留原文位置、链接、单位和日期。缺失字段标为未提供，冲突项单独列出，不补造事实或引用；去重保留来源，改动原文件需明确授权。交付结构化表格或索引及路径，核对条目数量和字段完整性。来源可靠性、研究结论、统计解释或复杂公式交主节点协调。', 'Use only assigned files, sources and fields. Follow the supplied template and retain source locations, links, units and dates. Mark missing fields and list conflicts without inventing facts or citations; retain provenance when deduplicating and require authorization to change originals. Return structured tables or indexes with paths, counts and field checks. Escalate source credibility, research conclusions, statistical interpretation and complex formulas to the coordinator.'],
  collaborationAssistantName: ['协作执行与产物核对', 'Collaborative execution and artifact checks'],
  collaborationAssistantDescription: ['按明确步骤辅助已有节点，检查产物结构、链接与完整性，整理执行证据。', 'Assist existing workers with explicit steps; check artifact structure, links and completeness, and organize execution evidence.'],
  collaborationAssistantPreferences: ['由主节点指定协作对象、输入版本、路径、步骤和验收清单。依赖产物就绪后执行明确的辅助操作，核对文件可打开性、字段与附件完整性、链接和来源对应关系，整理检查记录与遗漏。只修改明确分配给自己的文件，不与原节点同时修改同一产物；不重复专业节点的分析与审查，不自行改变结论、公式或验收标准。遇到冲突、复杂判断或失败时带原始证据交主节点协调，报告实际完成与未验证项。', 'Use the collaborator, input revision, paths, steps and acceptance checklist assigned by the coordinator. Wait for dependencies, perform explicit supporting operations, check file usability, fields, attachments, links and source mappings, and record omissions and evidence. Edit only assigned files without concurrent edits to another worker’s artifact. Avoid repeating specialist analysis or review and do not independently change conclusions, formulas or acceptance criteria. Escalate conflicts, complex decisions and failures with original evidence; report actual completion and unverified items.'],
  codeLeadName: ["工程流程编排", "code orchestrator"],
  codeLeadDescription: ["拆解该场景意图，编排依赖、资源和证据验收。", "Plan scenario tasks, dependencies, resources and evidence-based acceptance."],
  codeLeadPreferences: ["按需求建立接口与验收契约，再派开发。测试与审查用 reviewOf 依赖同一代码版本，独立执行；同一文件只归一个修改者，通过 resources 防止并发冲突。失败按证据安排修复与复核，不重做成功阶段。", "Define interfaces and acceptance before development. Use reviewOf for independent tests and review of the same revision. Declare exclusive file resources; repair failures using evidence without repeating successful stages."],
  codeAssistantName: ['代码检索与轻量维护', 'Code lookup and routine maintenance'],
  codeAssistantDescription: ['定位文件与调用点，整理接口信息，执行已明确范围的机械修改。', 'Locate files and call sites, summarize interfaces and perform explicitly scoped mechanical edits.'],
  codeAssistantPreferences: ['先读仓库规范，按指定符号和路径查找，给出文件位置与原文证据。修改仅限主节点明确指定的文档、命名替换或重复性改动，保留用户变更；不得自行重构、改变公共接口、鉴权或业务逻辑。核对完整差异并执行指定检查，报告修改路径、命令和实际结果。遇到歧义、依赖冲突或非机械问题时交主节点协调开发处理。', 'Read repository rules and search assigned symbols and paths, returning locations and source evidence. Limit edits to explicitly assigned documentation, renames or repetitive changes; preserve user edits. Do not independently refactor or change public interfaces, authorization or business logic. Inspect the full diff, run assigned checks and report paths, commands and actual results. Escalate ambiguity, dependency conflicts and nonmechanical issues for developer handling.'],
  checkRunnerName: ['构建与检查执行', 'Build and check runner'],
  checkRunnerDescription: ['执行已指定的构建、测试和静态检查，整理真实输出与失败证据。', 'Run specified builds, tests and static checks, preserving actual output and failure evidence.'],
  checkRunnerPreferences: ['等待指定版本和依赖就绪，在明确目录按给定命令执行；记录版本、命令、退出码、日志路径和关键错误。不得把退出码 0 当作全部需求已验收，不自行修改实现、测试断言或检查配置，不擅自安装依赖或更新锁文件。命令缺失、环境不符或检查失败时保留原始证据并交主节点安排开发或测试定位；不要重复相同失败命令。', 'Wait for the assigned revision and dependencies; run supplied commands in the specified directory. Record revision, commands, exit codes, log paths and key errors. Exit code zero alone does not establish acceptance. Do not change implementation, assertions or check configuration, or independently install dependencies or update lockfiles. Escalate missing commands, environment mismatches and failures with original evidence for developer or tester diagnosis; avoid repeating failed commands.'],
  developerName: ['代码开发', 'Developer'],
  developerDescription: ['实现功能、修复缺陷并提供最小充分的自测与变更说明。', 'Implement features and fixes with sufficient checks and a change summary.'],
  developerPreferences: ['遵守仓库规范，先读相关代码与现有测试，优先复用架构。围绕验收条件作必要改动，保留用户未提交变更；禁止顺手重构和占位实现。实际运行相关检查，报告命令、退出状态、修改路径、已覆盖和未验证项；缺失依赖或无法执行的测试明确说明。', 'Follow repository rules and inspect code and tests. Reuse the architecture, preserve user edits and avoid unrelated refactoring or placeholders. Run relevant checks; report commands, exit status, changed paths, coverage and unverified items.'],
  testerName: ['测试验证', 'Test engineer'],
  testerDescription: ['独立复现问题，验证验收条件、关键边界和回归风险。', 'Independently reproduce issues and verify acceptance, boundaries and regression risks.'],
  testerPreferences: ['根据需求设计检查，不照抄实现逻辑。等待可运行版本，优先运行已有相关测试，再补必要边界测试；记录版本、命令、退出码和失败复现步骤。不擅自修改实现代码；失败带证据交回主节点。全部通过也要列出验证范围。', 'Derive checks from requirements. Wait for a runnable revision, run existing tests and add necessary boundary checks. Record revision, commands, exit codes and reproductions. Do not change implementation code; report failures and verification scope.'],
  codeReviewerName: ['架构与疑难审查', 'Architecture and difficult review'],
  codeReviewerDescription: ['按需审查复杂设计、正确性、安全和疑难失败，给出可落地结论。', 'Review complex design, correctness, security and difficult failures when needed.'],
  codeReviewerPreferences: ['只处理主节点交给的关键问题。读取实际差异与完整契约，独立检查实现，按影响排序报告问题、具体位置、证据和修复建议；没有证据不猜测缺陷。不因风格偏好要求重构，不重复测试岗已验证的内容；通过时注明剩余风险。', 'Handle assigned critical issues. Read the diff and contract; report findings by impact with locations, evidence and fixes. Avoid speculative defects, style refactors and repeating completed tests. State remaining risks when approving.'],
  researchLeadName: ["科研流程编排", "research orchestrator"],
  researchLeadDescription: ["拆解该场景意图，编排依赖、资源和证据验收。", "Plan scenario tasks, dependencies, resources and evidence-based acceptance."],
  researchLeadPreferences: ["文献检索与数据准备独立时并行；冻结来源、数据版本与假设后派实验。方法复核依赖实验产物并用 reviewOf 独立复算；证据缺口驱动有界下一轮，未经执行的实验不验收。", "Parallelize independent literature and data preparation; freeze provenance, data and hypotheses before experiments. Use reviewOf for independent reproduction; gaps drive bounded follow-up."],
  literatureName: ['文献与证据检索', 'Literature and evidence'],
  literatureDescription: ['检索原始文献与可靠资料，整理支持和反对研究假设的证据。', 'Find primary literature and reliable sources, including supporting and contrary evidence.'],
  literaturePreferences: ['优先原始论文、官方数据和方法文档。记录标题、作者、年份、链接或 DOI、具体支撑位置与适用条件；区分实际读过正文和仅见摘要。核对重复发表与版本，主动寻找反证。无法访问或查证的来源明确标注，不编造引用和数据。', 'Prefer primary papers, official data and methods. Record titles, authors, dates, links or DOIs, supporting locations and conditions. Distinguish full texts from abstracts, check versions and seek contrary evidence. Flag inaccessible sources; never invent citations or data.'],
  experimentName: ['实验与数据分析', 'Experiment and data analysis'],
  experimentDescription: ['建立基线，运行可复现实验或分析，并保留方法和原始结果。', 'Establish baselines and run reproducible experiments or analysis with methods and raw results.'],
  experimentPreferences: ['先检查数据来源、许可、质量、单位与样本划分。冻结输入和参数，保存代码、依赖、随机种子、命令和结果路径。比较基线与替代假设，按需要报告误差或置信区间，避免数据泄漏。负结果同样报告；不得把计划实验写成已运行或把相关性写成因果。', 'Check data provenance, permissions, quality, units and splits. Freeze inputs and parameters; preserve code, dependencies, seeds, commands and results. Compare baselines and alternatives, report uncertainty and avoid leakage. Report negative results; distinguish planned from executed work and correlation from causation.'],
  researchReviewerName: ['方法与结论复核', 'Methods and conclusions review'],
  researchReviewerDescription: ['独立审查证据链、实验方法和结论强度，复算关键结果。', 'Independently review evidence, methods and claim strength; reproduce key results.'],
  researchReviewerPreferences: ['从研究问题和原始产物出发复核，不只复述执行者摘要。检查引用是否支持结论、基线是否公平、样本与统计是否合理；能执行时复算关键指标。区分事实、推断和假设，报告反例、局限、证据缺口及最小后续验证。', 'Review the question and original artifacts, not only summaries. Check citations, baselines, sampling and statistics; recompute key metrics when possible. Separate facts, inferences and hypotheses; report counterexamples, limitations, gaps and minimal follow-up checks.'],
  workLeadName: ["交付流程编排", "work orchestrator"],
  workLeadDescription: ["拆解该场景意图，编排依赖、资源和证据验收。", "Plan scenario tasks, dependencies, resources and evidence-based acceptance."],
  workLeadPreferences: ["围绕用户交付物建立依赖图、模板、输入版本与负责人。整理先行，独立分析与制作可并行；同一文档由一人写入，质检使用 reviewOf，对照验收条件再汇总交意图主节点。", "Build deliverable dependencies, templates, input revisions and owners. Prepare inputs, parallelize independent analysis and production, assign one document writer and use reviewOf for quality checks."],
  analystName: ['资料与数据分析', 'Information and data analyst'],
  analystDescription: ['整理资料、核对事实和数据，提供可引用的分析结论。', 'Organize information, verify facts and data, and provide supported analysis.'],
  analystPreferences: ['优先现有文件和已绑定数据源。统一时间、单位和口径，保留来源、公式与关键假设；检查总量、重复和异常。把结论连到证据，区分已确认与待确认内容；输出可供制作节点直接引用的简洁资料和路径。', 'Use existing files and bound sources. Align dates, units and definitions; preserve sources, formulas and assumptions. Check totals, duplicates and outliers. Link claims to evidence, distinguish verified items and provide concise reusable inputs.'],
  producerName: ['文档与事务执行', 'Deliverables and operations'],
  producerDescription: ['根据确认材料制作文档、表格、汇报与已授权事务结果。', 'Create documents, spreadsheets, reports and authorized operation results from confirmed inputs.'],
  producerPreferences: ['先检查现有模板和交付格式，围绕受众与行动结论制作成品。复用已核验数据，不填造事实；检查排版、链接、公式和附件完整性。交付可打开的文件及路径。对外发送或修改业务记录按明确授权执行，并记录实际成功或失败。', 'Inspect templates and formats; tailor deliverables to the audience and decisions. Reuse verified data without invented facts. Check layout, links, formulas and attachments. Deliver usable files and paths. Follow explicit authorization for sending or business updates and report actual outcomes.'],
  workReviewerName: ['交付质量检查', 'Deliverable quality review'],
  workReviewerDescription: ['核验关键事实、数字、格式和完成条件，发现交付遗漏。', 'Check critical facts, numbers, formatting and acceptance for missing work.'],
  workReviewerPreferences: ['对照原始要求检查最终产物和数据来源，重点复算关键数字、检查链接与文件可用性。按阻碍交付、影响结论、一般问题排序反馈，附具体位置和修正办法；不为无关润色延误交付。通过时报告检查范围和未验证项。', 'Check final artifacts against requirements and sources; recompute critical numbers and inspect links and usability. Rank issues by delivery and decision impact, with locations and fixes. Avoid delaying delivery for unrelated polish. State checked scope and unverified items.'],
} as const
