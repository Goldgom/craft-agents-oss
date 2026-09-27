import semver from 'semver'

const DEFAULT_REPOSITORY = 'Goldgom/craft-agents-oss'

interface GitCodeAsset {
  name: string
  browser_download_url: string
  type?: string
}

interface GitCodeRelease {
  tag_name: string
  prerelease?: boolean
  assets: GitCodeAsset[]
}

export interface GitCodeUpdateFeed {
  version: string
  feedUrl: string | null
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

  const apiUrl = `https://api.gitcode.com/api/v5/repos/${parts.map(encodeURIComponent).join('/')}/releases/latest`
  const response = await request(apiUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`GitCode release check failed (HTTP ${response.status})`)

  const release = await response.json() as GitCodeRelease
  const version = release.tag_name?.replace(/^v/, '')
  if (!semver.valid(version) || !semver.valid(currentVersion)) {
    throw new Error(`Invalid GitCode release version: ${release.tag_name}`)
  }
  if (release.prerelease || !semver.gt(version, currentVersion)) {
    return { version, feedUrl: null }
  }

  const assets = Array.isArray(release.assets) ? release.assets : []
  const manifest = assets.find(asset => asset.name === 'latest.yml' && asset.type !== 'source')
  const installer = assets.find(asset => asset.name === 'TokenBird-x64.exe' && asset.type !== 'source')
  if (!manifest || !installer) {
    throw new Error(`GitCode release ${release.tag_name} must contain latest.yml and TokenBird-x64.exe`)
  }

  const expectedPrefix = `https://gitcode.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/`
  for (const asset of [manifest, installer]) {
    if (!asset.browser_download_url.startsWith(expectedPrefix)) {
      throw new Error(`Unexpected GitCode release asset URL: ${asset.name}`)
    }
  }

  return { version, feedUrl: expectedPrefix }
}
