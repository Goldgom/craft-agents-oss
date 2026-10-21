import type { SuperAgentModelEntry } from '@tokenbird/shared/super-agent'
import { THINKING_LEVEL_IDS } from '@tokenbird/shared/agent/thinking-levels'
import { getModelById, isAdaptiveThinkingAlwaysOnModel } from '@tokenbird/shared/config/models'
import { isImageGenerationModelId } from '@tokenbird/shared/config/llm-connections'

type Recommendation = { match: RegExp; score: number; zh: string; en: string }
// Scheduling preferences for this product, not measured or provider-published scores.
const recommendations: Recommendation[] = [
  { match: /astra|fable|mythos/i, score: 96, zh: '复杂推理、多步骤分析、困难问题复核。建议用于高难度任务，常规整理可交给轻量模型；关键结论需要验证。', en: 'Suggested for difficult reasoning, multi-step analysis and review. Use lighter models for routine work; verify key conclusions.' },
  { match: /opus/i, score: 94, zh: '复杂代码、长文分析、方案设计与结果复核。建议优先用于复杂任务；简单提取和整理可选择轻量模型。', en: 'Suggested for complex code, long-document analysis, design and review. Prefer lighter models for simple extraction.' },
  { match: /gpt-6(?:\.1)?-sol/i, score: 92, zh: '通用任务、代码实现、工具使用与多步骤分析。适合作为常用执行模型；重要修改应测试与复核。', en: 'Suggested for general work, coding, tool use and multi-step analysis. Test and review important changes.' },
  { match: /luna|nano|haiku|flash-lite/i, score: 65, zh: '信息提取、分类、摘要、格式转换与简单代码修改。建议优先处理明确且可验证的轻量任务，复杂结论交给较高分模型复核。', en: 'Suggested for extraction, classification, summaries, formatting and simple edits. Escalate complex conclusions for review.' },
  { match: /sonnet|codex|gpt-5\.6-sol/i, score: 88, zh: '代码实现、问题排查、文档分析与常规推理。建议用于边界明确的执行任务；跨模块改动和关键结果需要验证。', en: 'Suggested for coding, debugging, document analysis and routine reasoning. Verify cross-module changes and key results.' },
  { match: /terra|gpt-5|gpt-6/i, score: 84, zh: '通用问答、代码与文档处理、结构化分析。可用于日常执行，按任务难度调整思考强度并检查结果。', en: 'Suggested for general work, coding, documents and structured analysis. Choose effort per task and check results.' },
  { match: /flash|mini/i, score: 70, zh: '日常问答、摘要、提取、批量整理和轻量分析。建议用于目标明确的常规工作；高风险或复杂问题需额外复核。', en: 'Suggested for everyday work, summaries, extraction and light analysis. Review complex or high-stakes results.' },
  { match: /gemini.*pro/i, score: 86, zh: '长文分析、资料综合与多步骤研究。建议用于材料较多的分析任务；多模态输入是否可用以连接能力为准。', en: 'Suggested for long-document analysis, synthesis and research. Multimodal input depends on the connection capabilities.' },
  { match: /deepseek.*(?:pro|reasoner)|qwen.*(?:max|coder)|kimi|glm/i, score: 82, zh: '中文资料分析、代码与推理任务。建议提供明确输入、约束和验收条件；工具和多模态能力以当前连接为准。', en: 'Suggested for Chinese-language analysis, coding and reasoning. Provide clear inputs and acceptance criteria; tools and modalities depend on the connection.' },
  { match: /deepseek|qwen|minimax|gemini/i, score: 78, zh: '通用文本、信息整理、代码辅助与常规分析。建议先用于可验证的任务，再根据实际效果调整分数。', en: 'Suggested for general text, organization, coding assistance and routine analysis. Start with verifiable tasks and adjust the score based on results.' },
]

export function createSubagentModelPreset(llmConnection: string, model: string, chinese: boolean): SuperAgentModelEntry {
  const recommendation = recommendations.find(item => item.match.test(model))
  const definition = getModelById(model)
  const levels = definition?.supportsThinking === false ? ['off'] as const : THINKING_LEVEL_IDS
  return { id: `model-${crypto.randomUUID().slice(0, 8)}`, name: model || (chinese ? '新模型' : 'New model'), llmConnection, model,
    capabilityNotes: recommendation ? recommendation[chinese ? 'zh' : 'en'] : chinese
      ? '通用文本任务；尚未针对本地任务验证。请根据实际效果补充擅长领域、局限和选型建议。'
      : 'General text tasks; not validated on local workloads. Add strengths, limitations and selection advice based on actual results.',
    intelligenceScore: recommendation?.score ?? 60, enabled: true,
    supportedThinkingLevels: levels.filter(level => level !== 'off' || !isAdaptiveThinkingAlwaysOnModel(model)),
    maxCallsPerMinute: 6, capabilities: [], sourceSlugs: [], skillSlugs: [] }
}

export function tokenNestModelPresets(connection: { slug: string; isAuthenticated: boolean; oauthProvider?: string }, allowedModels: string[], chinese: boolean): SuperAgentModelEntry[] {
  if (!connection.isAuthenticated || connection.oauthProvider !== 'tokennest') return []
  return [...new Set(allowedModels)].filter(model => !isImageGenerationModelId(model)
    && !/(?:embedding|rerank|whisper|(?:^|[-/])tts(?:$|[-/])|sora|veo)/i.test(model))
    .map(model => createSubagentModelPreset(connection.slug, model, chinese))
    .sort((a, b) => b.intelligenceScore - a.intelligenceScore)
}

export function mergeSubagentModelPresets(existing: SuperAgentModelEntry[], presets: SuperAgentModelEntry[]) {
  const keys = new Set(existing.map(entry => JSON.stringify([entry.llmConnection, entry.model])))
  const entries = [...existing]
  let added = 0, skipped = 0
  for (const preset of presets) {
    const key = JSON.stringify([preset.llmConnection, preset.model])
    if (keys.has(key)) continue
    keys.add(key)
    if (entries.length >= 100) { skipped++; continue }
    entries.push(preset); added++
  }
  return { entries, added, skipped }
}
