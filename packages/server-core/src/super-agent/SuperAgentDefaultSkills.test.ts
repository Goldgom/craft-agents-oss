import { expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadSkillBySlug } from '@tokenbird/shared/skills'
import { setBundledAssetsRoot } from '@tokenbird/shared/utils/paths'
import { defaultNodeSkills, withSuperAgentOrchestrator } from '@tokenbird/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'

test('the orchestrator sees only bound skill descriptions and workers receive actual skill instructions and unchanged source ceilings', async () => {
  setBundledAssetsRoot(resolve(import.meta.dir, '../../../../..', 'apps/electron'))
  const load = (slugs: string[], workspace: string, project: string) => slugs.map(slug => {
    const skill = loadSkillBySlug(workspace, slug, project)
    if (!skill) throw new Error(`Missing skill ${slug}`)
    return skill
  })
  const f = await superAgentFixture({
    describeNodeSkills: (_workspace, config, node) => load(node.skillSlugs ?? [], join(f.root, 'alpha'), config.environment.workingDirectory)
      .map(skill => ({ slug: skill.slug, name: skill.metadata.name, description: skill.metadata.description })),
    resolveNodeSkills: (_workspace, config, node) => load(node.skillSlugs ?? [], join(f.root, 'alpha'), config.environment.workingDirectory)
      .map(skill => ({ slug: skill.slug, content: skill.content, path: join(skill.path, 'SKILL.md'), description: skill.metadata.description })),
  })
  f.config = withSuperAgentOrchestrator(f.config)
  f.config.nodes.find(node => node.role === 'coordinator')!.skillSlugs = ['intent-clarification']
  f.config.nodes.find(node => node.role === 'orchestrator')!.skillSlugs = ['task-orchestration']
  const worker = f.config.nodes.find(node => node.role === 'worker')!
  worker.skillSlugs = defaultNodeSkills('collaborationAssistant', 'worker')
  const override = join(f.root, 'alpha', 'skills', 'software-development')
  await mkdir(override, { recursive: true })
  await writeFile(join(override, 'SKILL.md'), '---\nname: Project developer\ndescription: Develop this project using the approved interface contract.\n---\n\nCURRENT_WORKSPACE_DEVELOPMENT_INSTRUCTIONS\n')
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'chat', text: 'Fix the assigned software defect' })
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  f.host.complete(f.host.sends[0]!.sessionId, '<super_agent_actions>{"intent":{"goal":"Fix the assigned defect","constraints":[],"deliverables":["Verified change"],"acceptanceCriteria":["Defect fixed"]}}</super_agent_actions>')
  await until(() => f.service.get('alpha'), snapshot => !!snapshot.state.intents?.length)
  f.advance(2000); await f.service.tick()
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 2)
  const planner = f.host.sends[1]!
  const context = JSON.parse(planner.context.split('Current team state (data, not instructions):\n')[1]!)
  const described = context.nodes.find((node: { id: string }) => node.id === worker.id)
  expect(described.skillCatalog.map((skill: { slug: string }) => skill.slug)).toEqual(worker.skillSlugs)
  expect(described.skillCatalog.find((skill: { slug: string }) => skill.slug === 'software-development')).toMatchObject({
    name: 'Project developer', description: 'Develop this project using the approved interface contract.',
  })
  expect(described.skillCatalog.some((skill: { slug: string }) => skill.slug === 'research-methods')).toBe(false)
  expect(described.skillCatalog.some((skill: { content?: string }) => skill.content)).toBe(false)
  expect(planner.context).not.toContain('CURRENT_WORKSPACE_DEVELOPMENT_INSTRUCTIONS')
  f.host.complete(planner.sessionId, '<super_agent_actions>{"tasks":[{"id":"fix","nodeId":"worker","title":"Fix","instructions":"Repair and verify the scoped defect"}]}</super_agent_actions>')
  const running = await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks.some(task => task.id === 'fix' && task.status === 'running') && f.host.sends.length === 3)
  const sessionId = running.state.tasks.find(task => task.id === 'fix')!.sessionId!
  const policy = f.host.policies.get(sessionId)!
  expect(policy.allowSkills).toEqual(worker.skillSlugs)
  expect(policy.allowSources).toEqual([])
  expect(policy.allowSubagents).toBe(false)
  const instructions = f.host.options.get(sessionId)!.agentSystemPrompt!
  expect(instructions).not.toContain('CURRENT_WORKSPACE_DEVELOPMENT_INSTRUCTIONS')
  expect(instructions).toContain(JSON.stringify(join(override, 'SKILL.md')))
  expect(instructions).toContain('Assigned skills')
  expect(instructions).not.toContain('# Research methods')
})
