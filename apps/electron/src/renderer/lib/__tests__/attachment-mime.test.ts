import { describe, expect, test } from 'bun:test'
import { attachmentMimeType } from '../attachment-mime'

describe('mobile attachment MIME fallback', () => {
  test('recognizes photos with missing or generic provider MIME', () => {
    expect(attachmentMimeType({ name: 'IMG_001.JPG', type: '' })).toBe('image/jpeg')
    expect(attachmentMimeType({ name: 'photo.png', type: 'application/octet-stream' })).toBe('image/png')
    expect(attachmentMimeType({ name: 'photo.heic', type: '' })).toBe('image/heic')
  })
  test('preserves explicit provider MIME', () => {
    expect(attachmentMimeType({ name: 'photo.png', type: 'image/jpeg' })).toBe('image/jpeg')
    expect(attachmentMimeType({ name: 'photo.png', type: 'application/pdf' })).toBe('application/pdf')
  })
  test('keeps unknown files as binary', () => {
    expect(attachmentMimeType({ name: 'data.bin', type: '' })).toBe('application/octet-stream')
    expect(attachmentMimeType({ name: 'data.constructor', type: '' })).toBe('application/octet-stream')
  })
})
