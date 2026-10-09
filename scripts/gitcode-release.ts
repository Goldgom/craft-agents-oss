#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { dump, load } from 'js-yaml'
import semver from 'semver'

const root = resolve(import.meta.dir, '..')
export const DEFAULT_REPOSITORY = 'Goldgom/token-bird'
const targets = ['win-x64', 'mac-x64', 'mac-arm64', 'linux-x64']
const required = ['TokenBird-x64.exe', 'TokenBird-x64.exe.blockmap', 'TokenBird-x64.AppImage',
  'TokenBird-x64.dmg', 'TokenBird-arm64.dmg', 'TokenBird-x64.zip', 'TokenBird-arm64.zip',
  'latest.yml', 'latest-mac.yml', 'latest-linux.yml']
const allowed = /^(?:TokenBird-(?:x64|arm64)\.(?:exe|msi|dmg|zip|AppImage)(?:\.blockmap)?|latest(?:-mac|-linux)?\.yml)$/

interface UpdateManifest {
  version: string
  files: Array<{ url: string; sha512: string; size: number }>
  path?: string
  sha512?: string
  releaseDate?: string
}
export interface Artifact { name: string; path: string; sha256: string; sha512: string; size: number }
interface Release {
  tag_name: string
  target_commitish: string
  name: string
  body: string
  prerelease: boolean
  release_status?: string
  assets: Array<{ name: string; type?: string; browser_download_url: string }>
}
type Request = typeof fetch

export function validateVersion(tag: string, versions: string[]): string {
  const version = tag.replace(/^v/, '')
  if (!semver.valid(version) || semver.prerelease(version) || versions.some(value => value !== version)) {
    throw new Error(`Tag ${tag} must match all package versions (${versions.join(', ')})`)
  }
  return version
}

async function hashFile(path: string): Promise<Omit<Artifact, 'name' | 'path'>> {
  const sha256 = createHash('sha256'), sha512 = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk); sha512.update(chunk); size += chunk.length
  }
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64'), size }
}

/** Merge the two macOS update manifests without losing either architecture. */
export async function prepareArtifacts(input: string, output: string, version: string): Promise<Artifact[]> {
  mkdirSync(output, { recursive: true })
  const artifacts = new Map<string, Artifact>()
  const manifests = new Map<string, UpdateManifest>()
  for (const target of targets) {
    const directory = join(input, target)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !allowed.test(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.name.startsWith('latest')) {
        const manifest = load(readFileSync(path, 'utf8')) as UpdateManifest
        if (manifest.version !== version || !Array.isArray(manifest.files) || !manifest.files.length) {
          throw new Error(`Invalid update manifest: ${target}/${entry.name}`)
        }
        const expected = target.startsWith('mac-') ? 'latest-mac.yml' : target.startsWith('win-') ? 'latest.yml' : 'latest-linux.yml'
        if (entry.name !== expected) throw new Error(`Unexpected update manifest: ${target}/${entry.name}`)
        manifests.set(target, manifest)
        continue
      }
      if (artifacts.has(entry.name)) throw new Error(`Duplicate release asset: ${entry.name}`)
      const destination = join(output, entry.name)
      cpSync(path, destination)
      artifacts.set(entry.name, { name: entry.name, path: destination, ...await hashFile(destination) })
    }
  }
  for (const target of targets) {
    const manifest = manifests.get(target)
    if (!manifest) throw new Error(`Missing update manifest: ${target}`)
    const expectedPackage = target === 'win-x64' ? 'TokenBird-x64.exe' : target === 'linux-x64'
      ? 'TokenBird-x64.AppImage' : `TokenBird-${target.slice(4)}.zip`
    if (!manifest.files.some(file => file.url === expectedPackage)) {
      throw new Error(`Update manifest is missing its platform package: ${target}/${expectedPackage}`)
    }
    for (const file of manifest.files) {
      const artifact = artifacts.get(file.url)
      if (!artifact || artifact.sha512 !== file.sha512 || artifact.size !== file.size) {
        throw new Error(`Update manifest does not match asset: ${target}/${file.url}`)
      }
    }
    const legacy = artifacts.get(manifest.path || '')
    if (manifest.path && (!legacy || legacy.sha512 !== manifest.sha512)) {
      throw new Error(`Invalid legacy update manifest path/hash: ${target}`)
    }
  }
  const mac = manifests.get('mac-x64')!
  const merged = { ...mac, files: [...mac.files, ...manifests.get('mac-arm64')!.files] }
  for (const [name, manifest] of [
    ['latest.yml', manifests.get('win-x64')!], ['latest-linux.yml', manifests.get('linux-x64')!],
    ['latest-mac.yml', merged],
  ] as const) {
    const path = join(output, name)
    writeFileSync(path, dump(manifest, { lineWidth: -1 }))
    artifacts.set(name, { name, path, ...await hashFile(path) })
  }
  for (const name of required) if (!artifacts.has(name)) throw new Error(`Missing release asset: ${name}`)
  const sorted = [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name))
  const path = join(output, 'SHA256SUMS.txt')
  writeFileSync(path, sorted.map(file => `${file.sha256}  ${file.name}\n`).join(''))
  return [...sorted, { name: 'SHA256SUMS.txt', path, ...await hashFile(path) }]
}

export async function publishRelease(options: {
  repository: string; token: string; tag: string; commit: string; body: string; artifacts: Artifact[]
}, request: Request = fetch): Promise<void> {
  const { repository, token, tag, commit, artifacts } = options
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitCode repository')
  if (!token) throw new Error('GITCODE_TOKEN is required')
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('A full commit SHA is required')
  const base = `https://api.gitcode.com/api/v5/repos/${repository}`
  const releasePath = `/releases/${encodeURIComponent(tag)}`
  async function api(path: string, method = 'GET', body?: unknown): Promise<Response> {
    const url = new URL(base + path)
    url.searchParams.set('access_token', token)
    const response = await request(url, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
    if (!response.ok && !(method === 'GET' && response.status === 404)) {
      // Do not log request URLs or response bodies: they may contain credentials.
      throw new Error(`GitCode ${method} ${path.split('?')[0]} failed (HTTP ${response.status})`)
    }
    return response
  }
  // Require the exact source tag on GitCode before creating any Release.
  let found = false
  for (let page = 1; page <= 100; page++) {
    const tags = await (await api(`/tags?per_page=100&page=${page}`)).json() as Array<{ name: string; commit: { sha: string } }>
    const match = tags.find(value => value.name === tag)
    if (match) {
      if (match.commit.sha !== commit) throw new Error('GitCode tag points to a different commit')
      found = true; break
    }
    if (tags.length < 100) break
  }
  if (!found) throw new Error(`Push tag ${tag} to GitCode before publishing`)
  const latestResponse = await api('/releases/latest')
  if (latestResponse.ok) {
    const latest = await latestResponse.json() as Release
    const latestVersion = semver.valid(latest.tag_name.replace(/^v/, ''))
    if (latestVersion && semver.gt(latestVersion, tag.replace(/^v/, ''))) {
      throw new Error('A newer GitCode Release already exists; refusing to downgrade latest')
    }
  }
  const existing = await api(releasePath)
  let release: Release
  if (existing.ok) {
    release = await existing.json() as Release
    if (release.target_commitish !== commit) throw new Error('Existing Release points to a different commit')
  } else {
    release = await (await api('/releases', 'POST', { tag_name: tag, target_commitish: commit,
      name: `TokenBird ${tag}`, body: options.body, release_status: 'pre' })).json() as Release
  }
  if (release.tag_name !== tag || release.target_commitish !== commit) {
    throw new Error('Release source tag/commit was not confirmed')
  }
  const stable = !release.prerelease && release.release_status !== 'pre'
  const downloadPrefix = `https://gitcode.com/${repository}/releases/download/${encodeURIComponent(tag)}/`
  async function verify(asset: Release['assets'][number], artifact: Artifact): Promise<void> {
    if (asset.browser_download_url !== downloadPrefix + artifact.name) throw new Error(`Unexpected asset URL: ${artifact.name}`)
    const response = await request(asset.browser_download_url, { signal: AbortSignal.timeout(30 * 60 * 1000) })
    if (!response.ok || !response.body) throw new Error(`Cannot download published asset: ${artifact.name}`)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of response.body) { hash.update(chunk); size += chunk.length }
    if (hash.digest('hex') !== artifact.sha256 || size !== artifact.size) {
      throw new Error(`Published asset checksum mismatch: ${artifact.name}`)
    }
    console.log(`Verified ${artifact.name}`)
  }
  for (const artifact of artifacts) {
    const asset = release.assets.find(value => value.name === artifact.name && value.type !== 'source')
    if (asset) { await verify(asset, artifact); continue }
    if (stable) throw new Error(`Published Releases are immutable; missing ${artifact.name}`)
    const upload = await (await api(`${releasePath}/upload_url?file_name=${encodeURIComponent(artifact.name)}`)).json() as {
      url: string; headers: Record<string, string>
    }
    if (new URL(upload.url).protocol !== 'https:') throw new Error('Upload URL must use HTTPS')
    console.log(`Uploading ${artifact.name} (${artifact.size} bytes)`)
    const response = await request(upload.url, { method: 'PUT', headers: upload.headers,
      body: Bun.file(artifact.path), signal: AbortSignal.timeout(30 * 60 * 1000) })
    if (!response.ok) throw new Error(`Asset upload failed: ${artifact.name} (HTTP ${response.status})`)
    // OBS callback adds the attachment; tolerate a short metadata propagation delay.
    let attached: Release['assets'][number] | undefined
    for (let attempt = 0; attempt < 6; attempt++) {
      release = await (await api(releasePath)).json() as Release
      attached = release.assets.find(value => value.name === artifact.name && value.type !== 'source')
      if (attached) break
      await Bun.sleep(2000)
    }
    if (!attached) throw new Error(`Uploaded attachment not listed: ${artifact.name}`)
    await verify(attached, artifact)
  }
  if (!stable) {
    await api(releasePath, 'PATCH', { name: release.name, body: release.body, release_status: 'latest' })
    const published = await (await api(releasePath)).json() as Release
    if (published.prerelease || published.release_status !== 'latest') throw new Error('Release promotion was not confirmed')
  }
  console.log(`Published https://gitcode.com/${repository}/releases/tag/${encodeURIComponent(tag)}`)
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: {
      tag: { type: 'string' }, input: { type: 'string' }, output: { type: 'string', default: 'dist/gitcode-release' },
      repository: { type: 'string', default: process.env.GITCODE_REPOSITORY || DEFAULT_REPOSITORY },
      notes: { type: 'string' }, 'check-version': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    } })
    const tag = values.tag || process.env.GITHUB_REF_NAME || ''
    const versions = ['package.json', 'apps/electron/package.json'].map(path => JSON.parse(readFileSync(join(root, path), 'utf8')).version)
    const version = validateVersion(tag, versions)
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    console.log(`TokenBird ${version}, commit ${commit}`)
    if (!values['check-version']) {
      if (!values.input) throw new Error('--input must contain win-x64, mac-x64, mac-arm64 and linux-x64 directories')
      const artifacts = await prepareArtifacts(resolve(values.input), resolve(values.output), version)
      if (values['dry-run']) console.log(`Dry run: ${artifacts.map(file => file.name).join(', ')}`)
      else await publishRelease({ repository: values.repository, token: process.env.GITCODE_TOKEN || '', tag, commit,
        body: values.notes ? readFileSync(values.notes, 'utf8') : `Windows x64、macOS x64/arm64、Linux x64。\n\n源码提交：${commit}\n\n文件校验值见 SHA256SUMS.txt。`, artifacts })
    }
  } catch (error) {
    // Fetch failures can include signed URLs; only report our controlled errors.
    const message = error instanceof Error ? error.message : 'Unknown failure'
    console.error(message.includes('://') || message.includes('access_token') ? 'Release failed during a network request' : message)
    process.exitCode = 1
  }
}
