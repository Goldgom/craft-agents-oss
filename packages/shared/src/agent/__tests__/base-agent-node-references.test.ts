import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authorizeSessionPolicyTool, checkSessionExecutionPolicy, clearSessionExecutionPolicy, setSessionExecutionPolicy, setSessionPolicyPermissionHandler } from '../core/session-execution-policy.ts';
import { setBundledAssetsRoot } from '../../utils/paths.ts';
import { createMockBackendConfig, createMockSession, createMockSource, TestAgent } from './test-utils.ts';

const sessionId = 'node-builtin-references-test';
let temp: string;
let environment: string;
let skillFile: string;
let docFile: string;
let assignedGuide: string;
let unassignedGuide: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'node-builtin-references-'));
  environment = join(temp, 'environment');
  const skillsRoot = join(temp, 'resources', 'skills');
  const docsRoot = join(temp, 'resources', 'docs');
  mkdirSync(environment);
  mkdirSync(join(skillsRoot, 'browser-automation'), { recursive: true });
  mkdirSync(docsRoot, { recursive: true });
  mkdirSync(join(temp, 'assigned-source'));
  mkdirSync(join(temp, 'unassigned-source'));
  skillFile = join(skillsRoot, 'browser-automation', 'SKILL.md');
  docFile = join(docsRoot, 'browser-tools.md');
  assignedGuide = join(temp, 'assigned-source', 'guide.md');
  unassignedGuide = join(temp, 'unassigned-source', 'guide.md');
  writeFileSync(skillFile, '# Real bundled skill');
  writeFileSync(docFile, '# Real bundled browser documentation');
  writeFileSync(join(skillsRoot, 'browser-automation', 'private.txt'), 'Not a capability reference');
  writeFileSync(assignedGuide, '# Assigned source instructions');
  writeFileSync(unassignedGuide, '# Unassigned source instructions');
  setBundledAssetsRoot(temp);
  setSessionExecutionPolicy(sessionId, {
    nodeId: 'worker', role: 'worker', rootPath: environment, readFiles: false,
    writeFiles: false, runPrograms: false, browser: false, allowSources: ['assigned'], allowSubagents: false,
  });
});

afterEach(() => {
  clearSessionExecutionPolicy(sessionId);
  setBundledAssetsRoot(resolve(import.meta.dir, '../../../../..'));
  rmSync(temp, { recursive: true, force: true });
});

describe('node builtin instructions', () => {
  test('automatically reads exact shipped skills and documentation with no approvals and preserves them on source refresh', async () => {
    let requests = 0;
    setSessionPolicyPermissionHandler(sessionId, async () => { requests++; return false; });
    const agent = new TestAgent(createMockBackendConfig({ session: createMockSession({ id: sessionId }),
      workspace: { id: 'workspace', name: 'Workspace', slug: 'workspace', rootPath: environment, createdAt: 1 } }));
    for (const path of [skillFile, docFile]) {
      expect((await authorizeSessionPolicyTool(sessionId, 'Read', { file_path: path }, environment)).allowed).toBe(true);
    }
    const assigned = createMockSource({ slug: 'assigned' });
    assigned.folderPath = join(temp, 'assigned-source');
    const unassigned = createMockSource({ slug: 'unassigned' });
    unassigned.folderPath = join(temp, 'unassigned-source');
    agent.setAllSources([assigned, unassigned]);
    for (const path of [skillFile, docFile, assignedGuide]) {
      expect((await authorizeSessionPolicyTool(sessionId, 'Read', { file_path: path }, environment)).allowed).toBe(true);
    }
    expect(requests).toBe(0);
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: unassignedGuide }, environment).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(temp, 'resources', 'skills', 'browser-automation', 'private.txt') }, environment).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Write', { file_path: skillFile, content: 'changed' }, environment).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Glob', { path: join(temp, 'resources', 'docs'), pattern: '*' }, environment).allowed).toBe(false);
    agent.dispose();
  });

  test('does not register substituted symlinked skills or docs', () => {
    const escapedSkill = join(temp, 'escaped-skill');
    mkdirSync(escapedSkill);
    writeFileSync(join(escapedSkill, 'SKILL.md'), '# Substituted instructions');
    const linkedSkill = join(temp, 'resources', 'skills', 'substituted');
    symlinkSync(escapedSkill, linkedSkill, process.platform === 'win32' ? 'junction' : 'dir');
    const agent = new TestAgent(createMockBackendConfig({ session: createMockSession({ id: sessionId }),
      workspace: { id: 'workspace', name: 'Workspace', slug: 'workspace', rootPath: environment, createdAt: 1 } }));
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(linkedSkill, 'SKILL.md') }, environment).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(escapedSkill, 'SKILL.md') }, environment).allowed).toBe(false);
    agent.dispose();
  });
});
