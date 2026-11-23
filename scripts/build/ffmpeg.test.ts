import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG_ASSETS, FFMPEG_RELEASE_TAG, ffmpegBundleIsValid, sha256 } from './ffmpeg'

describe('FFmpeg build artifact validation', () => {
  it('pins platform downloads to immutable release archives with SHA256', () => {
    expect(FFMPEG_RELEASE_TAG).toMatch(/^autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/)
    for (const asset of Object.values(FFMPEG_ASSETS)) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(asset.name).not.toContain('latest')
      expect(asset.name).toContain('lgpl')
    }
  })
  it('rejects cache corruption and missing license notices', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tokenbird-ffmpeg-build-'))
    try {
      writeFileSync(join(directory, 'ffmpeg'), 'ffmpeg binary fixture')
      writeFileSync(join(directory, 'ffprobe'), 'ffprobe binary fixture')
      mkdirSync(join(directory, 'ffmpeg-licenses'))
      writeFileSync(join(directory, 'ffmpeg-licenses', 'TOKENBIRD-NOTICE.txt'), 'LGPL')
      const archiveHash = 'a'.repeat(64)
      writeFileSync(join(directory, '.ffmpeg-build.json'), JSON.stringify({ release: FFMPEG_RELEASE_TAG, archiveSha256: archiveHash, ffmpegSha256: sha256(join(directory, 'ffmpeg')), ffprobeSha256: sha256(join(directory, 'ffprobe')) }))
      expect(ffmpegBundleIsValid(directory, archiveHash)).toBe(true)
      expect(ffmpegBundleIsValid(directory, 'b'.repeat(64))).toBe(false)
      writeFileSync(join(directory, 'ffprobe'), 'tampered')
      expect(ffmpegBundleIsValid(directory, archiveHash)).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
