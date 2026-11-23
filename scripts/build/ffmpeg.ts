/** Reproducible FFmpeg runtimes, distributed by the FFmpeg download page's BtbN build project. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, readdirSync, chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { BuildConfig } from './common'

export const FFMPEG_RELEASE_TAG = 'autobuild-2026-11-09-12-42'
export const FFMPEG_VERSION = 'n8.1.3-34-ga35157abb9'
const base = `https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE_TAG}`
export const FFMPEG_ASSETS = {
  'win32-x64': { name: `ffmpeg-${FFMPEG_VERSION}-win64-lgpl-8.1.zip`, sha256: '7bdec3860d33145a7cd68146eb8e1414e8881cac76205401211fbdad38ef0ed3' },
  'win32-arm64': { name: `ffmpeg-${FFMPEG_VERSION}-winarm64-lgpl-8.1.zip`, sha256: 'b5bc20dedb22fa6166083351d10262c330ba675c316de5ff0a468e3e350bdea1' },
  'linux-x64': { name: `ffmpeg-${FFMPEG_VERSION}-linux64-lgpl-8.1.tar.xz`, sha256: '70c3029eaa46cb83746ed5a218bbffbdc4fc3719e4080010af3a9690ff4e65f6' },
  'linux-arm64': { name: `ffmpeg-${FFMPEG_VERSION}-linuxarm64-lgpl-8.1.tar.xz`, sha256: 'a05bc184dbcacb3ee400ead7a6f04c774bd5be9573fbdc16da73aeaeef9e57c4' },
} as const

export function sha256(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }
type RuntimeStamp = { release: string; archiveSha256: string; ffmpegSha256: string; ffprobeSha256: string }
export function ffmpegBundleIsValid(target: string, expectedArchiveHash: string): boolean {
  try {
    const stamp = JSON.parse(readFileSync(join(target, '.ffmpeg-build.json'), 'utf8')) as RuntimeStamp
    const suffix = existsSync(join(target, 'ffmpeg.exe')) ? '.exe' : ''
    return stamp.release === FFMPEG_RELEASE_TAG && stamp.archiveSha256 === expectedArchiveHash
      && sha256(join(target, `ffmpeg${suffix}`)) === stamp.ffmpegSha256
      && sha256(join(target, `ffprobe${suffix}`)) === stamp.ffprobeSha256
      && existsSync(join(target, 'ffmpeg-licenses', 'TOKENBIRD-NOTICE.txt'))
  } catch { return false }
}

function findBinary(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === name) return join(root, entry.name)
    if (entry.isDirectory()) { const found = findBinary(join(root, entry.name), name); if (found) return found }
  }
}
function command(program: string, args: string[]): void {
  const result = spawnSync(program, args, { stdio: 'inherit', windowsHide: true, shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${program} failed (${result.status})`)
}
function githubDownload(url: string): string {
  const mirror = process.env.TOKENBIRD_GITHUB_MIRROR
  return mirror ? `${mirror.replace(/\/$/, '')}/${url}` : url
}

export async function downloadFfmpeg(config: BuildConfig): Promise<void> {
  const key = `${config.platform}-${config.arch}`
  const asset = FFMPEG_ASSETS[key as keyof typeof FFMPEG_ASSETS]
  const target = join(config.electronDir, 'resources', 'bin', key)
  // macOS releases must supply an audited runtime until an immutable upstream
  // macOS archive with a publisher checksum is available. Never ship a PATH-only app.
  if (!asset) {
    const supplied = process.env.TOKENBIRD_FFMPEG_BUNDLE_DIR
    if (!supplied) throw new Error(`No pinned FFmpeg bundle for ${key}; set TOKENBIRD_FFMPEG_BUNDLE_DIR to an audited runtime with ffmpeg, ffprobe, licenses/ and manifest.json checksums`)
    const manifest = JSON.parse(readFileSync(join(supplied, 'manifest.json'), 'utf8')) as { ffmpegSha256: string; ffprobeSha256: string }
    if (!/^[a-f0-9]{64}$/i.test(manifest.ffmpegSha256) || !/^[a-f0-9]{64}$/i.test(manifest.ffprobeSha256)
      || sha256(join(supplied, 'ffmpeg')) !== manifest.ffmpegSha256 || sha256(join(supplied, 'ffprobe')) !== manifest.ffprobeSha256
      || !existsSync(join(supplied, 'licenses'))) throw new Error('Supplied FFmpeg runtime checksum/license validation failed')
    mkdirSync(target, { recursive: true })
    for (const binary of ['ffmpeg', 'ffprobe']) { copyFileSync(join(supplied, binary), join(target, binary)); chmodSync(join(target, binary), 0o755) }
    cpSync(join(supplied, 'licenses'), join(target, 'ffmpeg-licenses'), { recursive: true })
    return
  }
  if (!config.forceDownload && ffmpegBundleIsValid(target, asset.sha256)) {
    console.log(`FFmpeg ${FFMPEG_VERSION} already verified at ${target}`)
    return
  }
  mkdirSync(target, { recursive: true })
  const tempParent = join(config.electronDir, '.tmp')
  mkdirSync(tempParent, { recursive: true })
  const temporary = mkdtempSync(join(tempParent, 'ffmpeg-'))
  try {
    const archive = join(temporary, asset.name)
    const url = `${base}/${asset.name}`
    console.log(`Downloading pinned FFmpeg ${FFMPEG_VERSION} for ${key}`)
    const response = await fetch(githubDownload(url), { signal: AbortSignal.timeout(10 * 60_000) })
    if (!response.ok) throw new Error(`FFmpeg download failed: HTTP ${response.status}`)
    await Bun.write(archive, response)
    if (sha256(archive) !== asset.sha256) throw new Error('FFmpeg archive SHA256 verification failed')
    const extract = join(temporary, 'extract')
    mkdirSync(extract)
    command('tar', ['-xf', archive, '-C', extract])
    const suffix = config.platform === 'win32' ? '.exe' : ''
    const ffmpeg = findBinary(extract, `ffmpeg${suffix}`)
    const ffprobe = findBinary(extract, `ffprobe${suffix}`)
    if (!ffmpeg || !ffprobe) throw new Error('FFmpeg archive is missing ffmpeg or ffprobe')
    for (const [binary, source] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]] as const) {
      copyFileSync(source, join(target, `${binary}${suffix}`))
      if (config.platform !== 'win32') chmodSync(join(target, binary), 0o755)
    }
    const licenseDir = join(target, 'ffmpeg-licenses')
    mkdirSync(licenseDir, { recursive: true })
    // Preserve the distributor's complete documentation/license payload.
    const top = readdirSync(extract, { withFileTypes: true }).find(entry => entry.isDirectory())
    if (!top) throw new Error('Invalid FFmpeg archive layout')
    const payload = join(extract, top.name)
    for (const entry of readdirSync(payload, { withFileTypes: true })) {
      if (entry.name === 'bin') continue
      cpSync(join(payload, entry.name), join(licenseDir, entry.name), { recursive: true })
    }
    writeFileSync(join(licenseDir, 'TOKENBIRD-NOTICE.txt'), [
      `FFmpeg ${FFMPEG_VERSION}, LGPL distribution, independent command-line programs.`,
      'TokenBird invokes these programs as subprocesses and does not link FFmpeg into TokenBird.',
      'FFmpeg project and licenses: https://ffmpeg.org/legal.html',
      `Binary distributor archive: ${url}`,
      `Archive SHA256: ${asset.sha256}`,
      'Corresponding FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/a35157abb9',
      `Build scripts, dependency recipes and source retrieval: https://github.com/FFmpeg-Builds/FFmpeg-Builds/tree/${FFMPEG_RELEASE_TAG}`,
      'The full distributor documentation and license files accompany this notice.',
      'Executables can be independently replaced with TOKENBIRD_FFMPEG_PATH and TOKENBIRD_FFPROBE_PATH.',
    ].join('\n'))
    const stamp: RuntimeStamp = { release: FFMPEG_RELEASE_TAG, archiveSha256: asset.sha256, ffmpegSha256: sha256(join(target, `ffmpeg${suffix}`)), ffprobeSha256: sha256(join(target, `ffprobe${suffix}`)) }
    writeFileSync(join(target, '.ffmpeg-build.json'), JSON.stringify(stamp, null, 2))
    if (config.platform === process.platform && config.arch === process.arch) {
      for (const binary of ['ffmpeg', 'ffprobe']) {
        const result = spawnSync(join(target, `${binary}${suffix}`), ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
        if (result.status !== 0 || !result.stdout.includes('a35157abb9')) throw new Error(`Bundled ${binary} failed version verification`)
      }
    }
    if (!ffmpegBundleIsValid(target, asset.sha256)) throw new Error('Installed FFmpeg verification failed')
    console.log(`FFmpeg and FFprobe installed and verified: ${target}`)
  } finally {
    const within = relative(resolve(tempParent), resolve(temporary))
    if (within && !within.startsWith('..') && !isAbsolute(within)) rmSync(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..', '..')
  await downloadFfmpeg({ rootDir: root, electronDir: join(root, 'apps', 'electron'), platform: process.platform as BuildConfig['platform'], arch: process.arch as BuildConfig['arch'], upload: false, uploadLatest: false, uploadScript: false, forceDownload: process.argv.includes('--force') })
}
