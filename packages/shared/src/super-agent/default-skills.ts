import { SUPER_AGENT_COLLABORATION_SKILL } from '@tokenbird/session-tools-core/super-agent-tools'
import type { SuperAgentNode } from './types'

// Supporting roles cover cross-scenario workflows. The coding preset uses
// codeAssistant/checkRunner for this pair; specialists remain preferred owners.
const organizationSkills = [
  'knowledge-organization', 'document-workflows', 'structured-data', 'previews-and-diagrams',
  'web-research', 'browser-automation', 'research-methods', 'evidence-review',
  'pages-authoring', 'canvas-editing', 'theme-package-design',
] as const
const assistanceSkills = [
  'everyday-assistance', 'software-development', 'software-verification', 'incident-response',
  'remote-operations', 'windows-desktop-control', 'messaging-and-collaboration', 'session-workflows',
  'skill-authoring', 'source-authoring', 'automation-authoring', 'workspace-configuration',
  'resource-transfer', 'agent-authoring',
] as const

/** Real bundled skill slugs, shared by setup, preset replacement and discovery. */
export const DEFAULT_SUPER_AGENT_SKILLS = {
  intentLead: ['intent-clarification'],
  dailyLead: ['task-orchestration'],
  codeLead: ['task-orchestration'],
  researchLead: ['task-orchestration'],
  workLead: ['task-orchestration'],
  operationsLead: ['task-orchestration'],
  dailyWorker: ['everyday-assistance', 'browser-automation', 'web-research', 'document-workflows', 'structured-data'],
  computerUse: ['windows-desktop-control', 'browser-automation', 'software-verification', 'evidence-review'],
  organizer: organizationSkills,
  collaborationAssistant: assistanceSkills,
  developer: ['software-development', 'browser-automation', 'web-research', 'source-authoring', 'pages-authoring', 'research-methods', 'incident-response'],
  tester: ['software-verification', 'evidence-review', 'browser-automation'],
  codeReviewer: ['software-verification', 'evidence-review', 'software-development'],
  codeAssistant: assistanceSkills,
  checkRunner: ['software-verification', 'remote-operations', ...organizationSkills],
  literature: ['web-research', 'browser-automation', 'document-workflows', 'evidence-review'],
  experiment: ['research-methods', 'software-development', 'structured-data', 'previews-and-diagrams'],
  researchReviewer: ['research-methods', 'evidence-review', 'software-verification'],
  analyst: ['research-methods', 'structured-data', 'web-research', 'browser-automation', 'evidence-review'],
  producer: ['document-workflows', 'structured-data', 'previews-and-diagrams', 'pages-authoring', 'canvas-editing', 'windows-desktop-control'],
  workReviewer: ['evidence-review', 'document-workflows', 'structured-data'],
  diagnostician: ['incident-response', 'remote-operations', 'software-verification', 'evidence-review'],
  operator: ['incident-response', 'remote-operations', 'software-development', 'source-authoring'],
  operationsReviewer: ['incident-response', 'software-verification', 'evidence-review', 'remote-operations'],
} as const satisfies Record<string, readonly string[]>

export type SuperAgentPresetProfile = keyof typeof DEFAULT_SUPER_AGENT_SKILLS

export function defaultNodeSkills(profile: string | undefined, role: SuperAgentNode['role']): string[] {
  const key = profile && Object.hasOwn(DEFAULT_SUPER_AGENT_SKILLS, profile) ? profile as SuperAgentPresetProfile
    : role === 'coordinator' ? 'intentLead' : role === 'planner' ? 'dailyLead' : role === 'orchestrator' ? 'dailyLead' : 'dailyWorker'
  return [SUPER_AGENT_COLLABORATION_SKILL, ...DEFAULT_SUPER_AGENT_SKILLS[key]]
}

/** Keep user additions and explicit removals while replacing managed defaults. */
export function presetSkillBinding(profile: string | undefined, role: SuperAgentNode['role'], previous?: SuperAgentNode) {
  const defaults = defaultNodeSkills(profile, role)
  const selected = previous?.skillSlugs ?? []
  const baseline = previous?.defaultSkillSlugs ?? []
  const removed = baseline.filter(slug => !selected.includes(slug))
  return {
    skillSlugs: [...new Set([...defaults.filter(slug => !removed.includes(slug)), ...selected.filter(slug => !baseline.includes(slug))])],
    defaultSkillSlugs: defaults,
  }
}

/** Default skills alone do not turn a retired preset worker into a custom node. */
export function hasCustomNodeSkills(node: SuperAgentNode): boolean {
  return !!node.skillSlugs?.some(slug => !node.defaultSkillSlugs?.includes(slug))
}
