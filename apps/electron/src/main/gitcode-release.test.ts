import { describe, expect, test } from 'bun:test'
import { getGitCodeUpdateFeed } from './gitcode-release'

const repository = 'Goldgom/token-bird'
const assetUrl = (name: string) =>
  `https://gitcode.com/${repository}/releases/download/26.10.11/${name}`
const assets = [
  { name: 'latest.yml', browser_download_url: assetUrl('latest.yml') },
  { name: 'TokenBird-x64.exe', browser_download_url: assetUrl('TokenBird-x64.exe') },
]
const release = (tag_name: string, extra = {}) => ({ tag_name, assets: [], ...extra })
const mockReleases = (...releases: unknown[]) => async () => Response.json(releases)

describe('GitCode update feed', () => {
  test('does not downgrade or require update files for an older or equal release', async () => {
    for (const version of ['26.9.20', 'v26.10.3']) {
      const feed = await getGitCodeUpdateFeed('26.10.3', repository, mockReleases(release(version)))
      expect(feed.available).toBe(false)
      expect(feed.feedUrl).toBeNull()
    }
  })

  test('uses only a complete release from the configured repository', async () => {
    const feed = await getGitCodeUpdateFeed('26.10.3', repository, mockReleases(release('26.10.11', { assets })))
    expect(feed.feedUrl).toBe(assetUrl(''))
    expect(feed.available).toBe(true)
  })

  test('selects the highest semantic tag regardless of order or latest designation', async () => {
    const feed = await getGitCodeUpdateFeed('26.9.20', repository, mockReleases(
      release('26.9.20', { release_status: 'latest' }), release('v26.10.11'), release('26.10.9'),
    ))
    expect(feed.version).toBe('26.10.11')
    expect(feed.releaseUrl).toBe(`https://gitcode.com/${repository}/releases/tag/v26.10.11`)
  })

  test('ignores prereleases, drafts, unfinished releases and invalid tags', async () => {
    const feed = await getGitCodeUpdateFeed('26.10.3', repository, mockReleases(
      release('26.10.11'), release('26.10.12-beta.1'), release('26.10.13', { prerelease: true }),
      release('26.10.14', { release_status: 'pre' }), release('26.10.15', { draft: true }),
      release('nightly'), null,
    ))
    expect(feed.version).toBe('26.10.11')
  })

  test('finds newer tags on later pages', async () => {
    const urls: string[] = []
    const feed = await getGitCodeUpdateFeed('26.10.3', repository, async url => {
      urls.push(url)
      return Response.json(urls.length === 1
        ? Array.from({ length: 100 }, () => release('26.10.9')) : [release('26.10.11')])
    })
    expect(feed.version).toBe('26.10.11')
    expect(urls[1]).toEndWith('?page=2&per_page=100')
  })

  test('announces updates without requiring a manifest or installer', async () => {
    for (const files of [[], assets.slice(0, 1), assets.slice(1)]) {
      const feed = await getGitCodeUpdateFeed('26.10.3', repository, mockReleases(release('26.10.11', { assets: files })))
      expect(feed.available).toBe(true)
      expect(feed.feedUrl).toBeNull()
      expect(feed.releaseUrl).toEndWith('/releases/tag/26.10.11')
    }
  })

  test('rejects foreign download URLs when using automatic updates', async () => {
    await expect(getGitCodeUpdateFeed('26.10.3', repository, mockReleases(release('26.10.11', { assets: [
      assets[0], { name: 'TokenBird-x64.exe', browser_download_url: 'https://example.com/TokenBird-x64.exe' },
    ] })))).rejects.toThrow('Unexpected GitCode release asset URL')
  })

  test('reports API errors and invalid responses instead of claiming up to date', async () => {
    await expect(getGitCodeUpdateFeed('26.10.3', repository, async () => new Response('', { status: 503 })))
      .rejects.toThrow('HTTP 503')
    await expect(getGitCodeUpdateFeed('26.10.3', repository, async () => Response.json({})))
      .rejects.toThrow('Invalid GitCode releases response')
    await expect(getGitCodeUpdateFeed('26.10.3', repository, mockReleases(release('nightly'))))
      .rejects.toThrow('No stable GitCode release')
  })

  test('rejects invalid local versions and repository paths before requesting', async () => {
    const request = async () => { throw new Error('Unexpected request') }
    await expect(getGitCodeUpdateFeed('unknown', repository, request)).rejects.toThrow('Invalid current version')
    await expect(getGitCodeUpdateFeed('26.10.3', '../other/repo', request)).rejects.toThrow('Invalid GitCode repository')
  })
})
