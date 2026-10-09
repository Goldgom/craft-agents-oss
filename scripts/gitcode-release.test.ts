import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { prepareArtifacts, publishRelease, validateVersion, type Artifact } from './gitcode-release'

const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
const version = '26.10.9'
const commit = 'a'.repeat(40)

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tokenbird-release-'))
  temporary.push(directory)
  const input = join(directory, 'input'), output = join(directory, 'output')
  for (const [target, names, manifestName] of [
    ['win-x64', ['TokenBird-x64.exe', 'TokenBird-x64.exe.blockmap'], 'latest.yml'],
    ['linux-x64', ['TokenBird-x64.AppImage'], 'latest-linux.yml'],
    ['mac-x64', ['TokenBird-x64.zip', 'TokenBird-x64.dmg'], 'latest-mac.yml'],
    ['mac-arm64', ['TokenBird-arm64.zip', 'TokenBird-arm64.dmg'], 'latest-mac.yml'],
  ] as const) {
    const folder = join(input, target)
    mkdirSync(folder, { recursive: true })
    const files = names.filter(name => !name.endsWith('blockmap')).map(name => {
      const bytes = Buffer.from(`${target}:${name}`)
      writeFileSync(join(folder, name), bytes)
      return { url: name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }
    })
    if (target === 'win-x64') writeFileSync(join(folder, 'TokenBird-x64.exe.blockmap'), 'blockmap')
    writeFileSync(join(folder, manifestName), dump({ version, files, path: files[0]!.url, sha512: files[0]!.sha512 }))
    writeFileSync(join(folder, 'builder-debug.yml'), 'should not be uploaded')
    writeFileSync(join(folder, 'cloud.env'), 'should not be uploaded')
  }
  return { input, output }
}

function mockApi(artifacts: Artifact[], configuration: {
  existing?: boolean; stable?: boolean; badTag?: boolean; corrupt?: boolean; failUpload?: boolean; newer?: boolean
} = {}) {
  const mutations: string[] = []
  const release = { tag_name: version, target_commitish: commit, name: 'Release', body: 'Notes',
    prerelease: !configuration.stable, release_status: configuration.stable ? 'latest' : 'pre',
    assets: [] as Array<{ name: string; type: string; browser_download_url: string }> }
  let exists = !!configuration.existing
  const attach = (name: string) => release.assets.push({ name, type: 'attach',
    browser_download_url: `https://gitcode.com/Goldgom/token-bird/releases/download/${version}/${name}` })
  if (configuration.existing) artifacts.forEach(artifact => attach(artifact.name))
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method || 'GET'
    if (method !== 'GET') mutations.push(`${method} ${url.pathname}`)
    if (url.hostname === 'uploads.example.com') {
      if (configuration.failUpload) return new Response('failed', { status: 500 })
      attach(url.pathname.slice(1)); return new Response('OK')
    }
    if (url.hostname === 'gitcode.com') {
      const artifact = artifacts.find(value => url.pathname.endsWith('/' + value.name))!
      return new Response(configuration.corrupt ? Buffer.from('bad') : readFileSync(artifact.path))
    }
    expect(url.searchParams.get('access_token')).toBe('test-token')
    if (url.pathname.endsWith('/tags')) return Response.json([{ name: version, commit: { sha: configuration.badTag ? 'b'.repeat(40) : commit } }])
    if (url.pathname.endsWith('/releases/latest')) {
      return configuration.newer ? Response.json({ tag_name: '26.10.10' }) : new Response('', { status: 404 })
    }
    if (url.pathname.endsWith('/upload_url')) return Response.json({
      url: `https://uploads.example.com/${url.searchParams.get('file_name')}`, headers: { 'x-obs-callback': 'callback' },
    })
    if (method === 'POST') {
      expect(JSON.parse(String(init!.body)).release_status).toBe('pre')
      exists = true; return Response.json(release)
    }
    if (method === 'PATCH') {
      release.prerelease = false; release.release_status = 'latest'; return Response.json(release)
    }
    return exists ? Response.json(release) : new Response('', { status: 404 })
  }) as typeof fetch
  return { request, mutations }
}

describe('GitCode binary publication', () => {
  test('checks tag versions across packages', () => {
    expect(validateVersion('v26.10.9', [version, version])).toBe(version)
    expect(() => validateVersion(version, [version, '26.10.7'])).toThrow('must match')
    expect(() => validateVersion('main', [version])).toThrow('must match')
    expect(() => validateVersion('26.10.9-beta.1', ['26.10.9-beta.1'])).toThrow('must match')
  })

  test('merges macOS architectures, validates hashes and excludes deployment/build files', async () => {
    const { input, output } = fixture()
    const artifacts = await prepareArtifacts(input, output, version)
    expect(artifacts.map(value => value.name)).not.toContain('cloud.env')
    expect(artifacts.map(value => value.name)).not.toContain('builder-debug.yml')
    const manifest = load(readFileSync(join(output, 'latest-mac.yml'), 'utf8')) as { files: Array<{ url: string }> }
    expect(manifest.files.map(value => value.url)).toEqual([
      'TokenBird-x64.zip', 'TokenBird-x64.dmg', 'TokenBird-arm64.zip', 'TokenBird-arm64.dmg',
    ])
    expect(readFileSync(join(output, 'SHA256SUMS.txt'), 'utf8')).toContain('  latest-mac.yml\n')
  })

  test('rejects missing architectures and a stale installer manifest before publishing', async () => {
    const { input, output } = fixture()
    writeFileSync(join(input, 'win-x64', 'TokenBird-x64.exe'), 'changed binary')
    await expect(prepareArtifacts(input, output, version)).rejects.toThrow('does not match')
    rmSync(join(input, 'mac-arm64'), { recursive: true })
    await expect(prepareArtifacts(input, output, version)).rejects.toThrow()
  })

  test('uploads to OBS, verifies downloads and promotes only after all attachments exist', async () => {
    const { input, output } = fixture()
    const artifacts = await prepareArtifacts(input, output, version)
    const { request, mutations } = mockApi(artifacts)
    await publishRelease({ repository: 'Goldgom/token-bird', token: 'test-token', tag: version, commit, body: 'Notes', artifacts }, request)
    expect(mutations[0]).toBe('POST /api/v5/repos/Goldgom/token-bird/releases')
    expect(mutations.filter(value => value.startsWith('PUT'))).toHaveLength(artifacts.length)
    expect(mutations.at(-1)).toBe(`PATCH /api/v5/repos/Goldgom/token-bird/releases/${version}`)
  })

  for (const [name, configuration, expected] of [
    ['wrong source tag', { badTag: true }, 'different commit'],
    ['upload failure', { failUpload: true }, 'upload failed'],
    ['corrupt existing attachment', { existing: true, corrupt: true }, 'checksum mismatch'],
    ['newer release', { newer: true }, 'refusing to downgrade'],
  ] as const) {
    test(`does not promote after ${name}`, async () => {
      const { input, output } = fixture()
      const artifacts = await prepareArtifacts(input, output, version)
      const { request, mutations } = mockApi(artifacts, configuration)
      await expect(publishRelease({ repository: 'Goldgom/token-bird', token: 'test-token', tag: version, commit, body: 'Notes', artifacts }, request)).rejects.toThrow(expected)
      expect(mutations.some(value => value.startsWith('PATCH'))).toBe(false)
    })
  }

  test('retries a complete published release without modifying it', async () => {
    const { input, output } = fixture()
    const artifacts = await prepareArtifacts(input, output, version)
    const { request, mutations } = mockApi(artifacts, { existing: true, stable: true })
    await publishRelease({ repository: 'Goldgom/token-bird', token: 'test-token', tag: version, commit, body: 'Notes', artifacts }, request)
    expect(mutations).toEqual([])
  })
})
