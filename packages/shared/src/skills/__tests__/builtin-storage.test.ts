import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getBuiltinSkillsDir,
  invalidateSkillsCache,
  loadAllSkills,
  loadSkillBySlug,
} from '../storage.ts'
import { setBundledAssetsRoot } from '../../utils/paths.ts'

const bundledAssetsRoot = join(process.cwd(), '..', '..', 'apps', 'electron')

describe('bundled skills', () => {
  it('loads bundled skills and lets a workspace definition override one', () => {
    setBundledAssetsRoot(bundledAssetsRoot)
    expect(getBuiltinSkillsDir()).toBe(join(bundledAssetsRoot, 'resources', 'skills'))

    const workspaceRoot = mkdtempSync(join(tmpdir(), 'builtin-skills-'))
    try {
      invalidateSkillsCache()
      const builtin = loadAllSkills(workspaceRoot).find(skill => skill.source === 'builtin')
      expect(builtin).toBeDefined()
      expect(loadSkillBySlug(workspaceRoot, builtin!.slug)?.source).toBe('builtin')

      const overrideDir = join(workspaceRoot, 'skills', builtin!.slug)
      mkdirSync(overrideDir, { recursive: true })
      writeFileSync(join(overrideDir, 'SKILL.md'), `---
name: Workspace Override
description: Overrides the bundled skill
---

Use workspace-specific instructions.
`)

      invalidateSkillsCache()
      const resolved = loadSkillBySlug(workspaceRoot, builtin!.slug)
      expect(resolved?.source).toBe('workspace')
      expect(resolved?.metadata.name).toBe('Workspace Override')
    } finally {
      invalidateSkillsCache()
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })
})
