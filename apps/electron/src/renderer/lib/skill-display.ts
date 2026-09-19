import type { LoadedSkill, SkillMetadata } from '../../shared/types'

type LocalizedSkillMetadata = Pick<SkillMetadata, 'name' | 'description'>

const ZH_HANS_BUILTIN_SKILLS: Record<string, LocalizedSkillMetadata> = {
  'agent-authoring': {
    name: '智能体编写',
    description: '设计用途明确、指令独立并遵循最小权限原则的可复用隔离子智能体。',
  },
  'automation-authoring': {
    name: '自动化编写',
    description: '创建或更新事件驱动的自动化、定时任务和后台脚本监控。',
  },
  'browser-automation': {
    name: '浏览器自动化',
    description: '操作词元鸟内置浏览器，完成界面操作、表单填写、下载、检查及 API 不适用时的访问任务。',
  },
  'document-workflows': {
    name: '文档工作流',
    description: '使用内置命令行工具读取、创建、转换、检查、比较和编辑 PDF、Office、图片、日历等文档。',
  },
  'llm-delegation': {
    name: '大模型委派',
    description: '使用 call_llm 并行处理相互独立且无需工具的模型任务、结构化提取和批量工作。',
  },
  'messaging-and-collaboration': {
    name: '消息与协作',
    description: '检查消息渠道绑定、发送支持的媒体或卡片，并通过词元鸟协作看板和文件开展协作。',
  },
  'pages-authoring': {
    name: '页面编写',
    description: '创建和维护持久化的词元鸟页面、实时数据存储、刷新任务和安全的数据源操作授权。',
  },
  'previews-and-diagrams': {
    name: '预览与图表',
    description: '将 Mermaid 图表及本地 HTML、PDF、图片或 Markdown 文件呈现为原生预览，并支持多项目标签页。',
  },
  'remote-operations': {
    name: '远程操作',
    description: '在已配置相应会话工具时，执行范围明确的本地或远程命令，并通过 SFTP 传输文件。',
  },
  'resource-transfer': {
    name: '资源迁移',
    description: '导出和导入可移植的词元鸟数据源及集成资源包，同时保护凭据并验证操作范围。',
  },
  'session-workflows': {
    name: '会话工作流',
    description: '管理词元鸟会话元数据、任务看板条目、后台工作、跨会话通信和自动化交接。',
  },
  'skill-authoring': {
    name: '技能编写',
    description: '创建适用于一类明确任务、可复用的 SKILL.md 指令集。',
  },
  'source-authoring': {
    name: '数据源编写',
    description: '以最小访问权限和实用的智能体指南使用、创建、认证并验证 API、MCP 和本地文件夹数据源。',
  },
  'structured-data': {
    name: '结构化数据',
    description: '以交互式数据表或电子表格展示结构化结果，并在不过度占用对话上下文的情况下处理大型数据集。',
  },
  'subagent-collaboration': {
    name: '子智能体协作',
    description: '当当前运行时提供 Agent 或 Task 工具时，将边界清晰的实质性工作委派给子智能体。',
  },
  'theme-package-design': {
    name: '主题包设计',
    description: '创建完整、可移植的词元鸟主题包或兼容 Harness 的皮肤，包含离线资源及清晰易读的明暗样式。',
  },
  'web-research': {
    name: '网络研究',
    description: '使用可用的网络工具研究最新或不确定的信息，核实论断并区分来源事实与模型记忆。',
  },
  'workspace-configuration': {
    name: '工作区配置',
    description: '生成或编辑工作区标签、状态、视图、权限和工具元数据，同时不影响无关配置。',
  },
}

const ZH_HANT_BUILTIN_SKILLS: Record<string, LocalizedSkillMetadata> = {
  'agent-authoring': {
    name: '智慧體編寫',
    description: '設計用途明確、指令獨立並遵循最小權限原則的可重複使用隔離子智慧體。',
  },
  'automation-authoring': {
    name: '自動化編寫',
    description: '建立或更新事件驅動的自動化、排程工作和背景指令碼監控。',
  },
  'browser-automation': {
    name: '瀏覽器自動化',
    description: '操作詞元鳥內建瀏覽器，完成介面操作、表單填寫、下載、檢查及 API 不適用時的存取工作。',
  },
  'document-workflows': {
    name: '文件工作流程',
    description: '使用內建命令列工具讀取、建立、轉換、檢查、比較和編輯 PDF、Office、圖片、行事曆等文件。',
  },
  'llm-delegation': {
    name: '大型模型委派',
    description: '使用 call_llm 平行處理彼此獨立且無需工具的模型工作、結構化擷取和批次工作。',
  },
  'messaging-and-collaboration': {
    name: '訊息與協作',
    description: '檢查訊息管道綁定、傳送支援的媒體或卡片，並透過詞元鳥協作看板和檔案進行協作。',
  },
  'pages-authoring': {
    name: '頁面編寫',
    description: '建立和維護持久化的詞元鳥頁面、即時資料儲存、重新整理工作和安全的資料來源操作授權。',
  },
  'previews-and-diagrams': {
    name: '預覽與圖表',
    description: '將 Mermaid 圖表及本機 HTML、PDF、圖片或 Markdown 檔案呈現為原生預覽，並支援多項目分頁。',
  },
  'remote-operations': {
    name: '遠端操作',
    description: '在已設定相應工作階段工具時，執行範圍明確的本機或遠端命令，並透過 SFTP 傳輸檔案。',
  },
  'resource-transfer': {
    name: '資源移轉',
    description: '匯出和匯入可攜式的詞元鳥資料來源及整合資源包，同時保護認證資訊並驗證操作範圍。',
  },
  'session-workflows': {
    name: '工作階段工作流程',
    description: '管理詞元鳥工作階段中繼資料、工作看板項目、背景工作、跨工作階段通訊和自動化交接。',
  },
  'skill-authoring': {
    name: '技能編寫',
    description: '建立適用於一類明確工作、可重複使用的 SKILL.md 指令集。',
  },
  'source-authoring': {
    name: '資料來源編寫',
    description: '以最小存取權限和實用的智慧體指南使用、建立、驗證並檢查 API、MCP 和本機資料夾資料來源。',
  },
  'structured-data': {
    name: '結構化資料',
    description: '以互動式資料表或試算表呈現結構化結果，並在不過度占用對話內容的情況下處理大型資料集。',
  },
  'subagent-collaboration': {
    name: '子智慧體協作',
    description: '當目前執行階段提供 Agent 或 Task 工具時，將邊界清楚的實質工作委派給子智慧體。',
  },
  'theme-package-design': {
    name: '主題包設計',
    description: '建立完整、可攜式的詞元鳥主題包或相容 Harness 的外觀，包含離線資源及清晰易讀的明暗樣式。',
  },
  'web-research': {
    name: '網路研究',
    description: '使用可用的網路工具研究最新或不確定的資訊，核實論述並區分有來源的事實與模型記憶。',
  },
  'workspace-configuration': {
    name: '工作區設定',
    description: '產生或編輯工作區標籤、狀態、檢視、權限和工具中繼資料，同時不影響無關設定。',
  },
}

function getBuiltinSkillTranslations(language?: string): Record<string, LocalizedSkillMetadata> | undefined {
  const normalized = language?.toLowerCase()
  if (normalized?.startsWith('zh-hant') || normalized?.startsWith('zh-tw') || normalized?.startsWith('zh-hk')) {
    return ZH_HANT_BUILTIN_SKILLS
  }
  if (normalized?.startsWith('zh')) return ZH_HANS_BUILTIN_SKILLS
  return undefined
}

/** Localize app-shipped skill metadata without changing its stable slug or model instructions. */
export function localizeBuiltinSkill(skill: LoadedSkill, language?: string): LoadedSkill {
  if (skill.source !== 'builtin') return skill

  const localized = getBuiltinSkillTranslations(language)?.[skill.slug]
  if (!localized) return skill

  return {
    ...skill,
    metadata: {
      ...skill.metadata,
      ...localized,
    },
  }
}

export function localizeBuiltinSkills(skills: LoadedSkill[], language?: string): LoadedSkill[] {
  const translations = getBuiltinSkillTranslations(language)
  if (!translations) return skills
  return skills.map(skill => localizeBuiltinSkill(skill, language))
}
