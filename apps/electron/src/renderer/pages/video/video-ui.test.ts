import { describe, expect, it } from 'bun:test'
import type { VideoShot } from '@tokenbird/shared/video'
import { fetchVideoAssetBlob, isActiveVideoJob, moveVideoShot, videoFileMime, videoText } from './video-ui'

describe('video storyboard editing', () => {
  const shots = ['a', 'b', 'c'].map(id => ({ id, title: id, prompt: '', durationSeconds: 5, memoryIds: [] } satisfies VideoShot))
  it('reorders complete shots without losing asset or memory bindings', () => {
    const bound = shots.map(shot => ({ ...shot, assetId: `${shot.id}.mp4`, memoryIds: ['person-1'] }))
    const result = moveVideoShot(bound, 'b', -1)
    expect(result.map(shot => shot.id)).toEqual(['b', 'a', 'c'])
    expect(result[0]).toEqual(bound[1])
    expect(bound.map(shot => shot.id)).toEqual(['a', 'b', 'c'])
  })
  it('keeps boundaries and missing identities stable', () => {
    expect(moveVideoShot(shots, 'a', -1)).toBe(shots)
    expect(moveVideoShot(shots, 'c', 1)).toBe(shots)
    expect(moveVideoShot(shots, 'missing', 1)).toBe(shots)
  })
  it('distinguishes active work from terminal failure and interruption', () => {
    for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const) {
      expect(isActiveVideoJob({ status } as Parameters<typeof isActiveVideoJob>[0])).toBe(['queued', 'running'].includes(status))
    }
  })
  it('uses the current language for new controls', () => {
    expect(videoText('zh-Hans')('title')).toBe('视频制作')
    expect(videoText('en')('title')).toBe('Video Studio')
  })
  it('imports subtitle and MKV files when browsers omit their MIME type', () => {
    expect(videoFileMime('对白.SRT', '')).toBe('application/x-subrip')
    expect(videoFileMime('scene.mkv', '')).toBe('video/x-matroska')
    expect(videoFileMime('track.m4a', '')).toBe('audio/mp4')
  })
  it('downloads sequential bounded chunks and preserves complete movie bytes', async () => {
    const offsets: number[] = []
    const result = await fetchVideoAssetBlob('movie', async ({ offset, length }) => {
      expect(length).toBe(4 * 1024 * 1024)
      offsets.push(offset)
      return { name: 'movie.mp4', mimeType: 'video/mp4', offset, totalBytes: 5, bytesBase64: btoa(offset === 0 ? 'abc' : 'de'), eof: offset > 0 }
    })
    expect(offsets).toEqual([0, 3])
    expect(await result.blob.text()).toBe('abcde')
  })
  it('rejects truncated or reordered downloads instead of exporting corrupt video', async () => {
    await expect(fetchVideoAssetBlob('movie', async () => ({ name: 'movie.mp4', mimeType: 'video/mp4', offset: 0, totalBytes: 5, bytesBase64: btoa('abc'), eof: true }))).rejects.toThrow('Incomplete')
    await expect(fetchVideoAssetBlob('movie', async () => ({ name: 'movie.mp4', mimeType: 'video/mp4', offset: 1, totalBytes: 3, bytesBase64: btoa('abc'), eof: true }))).rejects.toThrow('Invalid')
  })
})
