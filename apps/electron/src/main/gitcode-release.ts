import semver from 'semver'

const DEFAULT_REPOSITORY = 'Goldgom/token-bird'

interface GitCodeAsset {
  name: string
  browser_download_url: string
  type?: string
}

interface GitCodeRelease {
  tag_name: string
  prerelease?: boolean
  draft?: boolean
  release_status?: string
  assets: GitCodeAsset[]
}

export interface GitCodeUpdateFeed {
  version: string
  feedUrl: string | null
  available: boolean
  releaseUrl: string
}

type ReleaseRequest = (url: string, init?: RequestInit) => Promise<Response>

/** Resolve the latest Windows release into an electron-updater generic feed. */
export async function getGitCodeUpdateFeed(
  currentVersion: string,
  repository = process.env.TOKENBIRD_GITCODE_REPO || DEFAULT_REPOSITORY,
  request: ReleaseRequest = fetch,
): Promise<GitCodeUpdateFeed> {
  const parts = repository.split('/')
  if (parts.length !== 2 || parts.some(part => !/^[\w.-]+$/.test(part))) {
    throw new Error(`Invalid GitCode repository: ${repository}`)
  }

  if (!semver.valid(currentVersion)) {
    throw new Error(`Invalid current version: ${currentVersion}`)
  }
  // GitCode's "latest" designation can be reassigned to an older release.
  // Compare stable release tags, independently of publication order or assets.
  const apiUrl = `https://api.gitcode.com/api/v5/repos/${parts.map(encodeURIComponent).join('/')}/releases`
  let release: GitCodeRelease | undefined
  let version = ''
  const signal = AbortSignal.timeout(15000)
  for (let page = 1; ; page++) {
    const response = await request(`${apiUrl}?page=${page}&per_page=100`, {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      signal,
    })
    if (!response.ok) throw new Error(`GitCode release check failed (HTTP ${response.status})`)
    const releases: unknown = await response.json()
    if (!Array.isArray(releases)) throw new Error('Invalid GitCode releases response')
    for (const candidate of releases as GitCodeRelease[]) {
      const candidateVersion = typeof candidate?.tag_name === 'string'
        ? semver.valid(candidate.tag_name.replace(/^v/, '')) : null
      if (!candidateVersion || semver.prerelease(candidateVersion) || candidate.prerelease
        || candidate.draft || candidate.release_status === 'pre') continue
      if (!release || semver.gt(candidateVersion, version)) {
        release = candidate
        version = candidateVersion
      }
    }
    if (releases.length < 100) break
    if (page >= 20) throw new Error('GitCode release list exceeds pagination limit')
  }
  if (!release) throw new Error('No stable GitCode release found')

  const available = semver.gt(version, currentVersion)
  const releaseUrl = `https://gitcode.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}`
  const result = { version, available, releaseUrl, feedUrl: null }
  if (!available) return result

  const assets = Array.isArray(release.assets) ? release.assets : []
  const manifest = assets.find(asset => asset.name === 'latest.yml' && asset.type !== 'source')
  const installer = assets.find(asset => asset.name === 'TokenBird-x64.exe' && asset.type !== 'source')
  if (!manifest || !installer) {
    return result
  }

  const expectedPrefix = `https://gitcode.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/`
  for (const asset of [manifest, installer]) {
    if (!asset.browser_download_url.startsWith(expectedPrefix)) {
      throw new Error(`Unexpected GitCode release asset URL: ${asset.name}`)
    }
  }

  return { ...result, feedUrl: expectedPrefix }
}
