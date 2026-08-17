import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { posix } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { RemoteServerProfile, RemoteServerSftpConfig } from '@craft-agent/shared/config/remote-servers'

export interface SftpTransferRequest {
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
}

export interface SftpTransferResult {
  success: true
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  bytes: number
}

function callSftp<T>(fn: (callback: (error: Error | null | undefined, result?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn((error, result) => {
      if (error) reject(error)
      else resolve(result as T)
    })
  })
}

async function connectSftp(config: RemoteServerSftpConfig): Promise<{ client: Client; sftp: SFTPWrapper }> {
  if (!config.enabled) throw new Error('SFTP is not enabled for this server')

  const options: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: 15_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
  }

  if (config.authMethod === 'password') {
    if (!config.password) throw new Error('SFTP password is not configured')
    options.password = config.password
  } else {
    if (!config.privateKeyPath) throw new Error('SFTP private key path is not configured')
    const privateKeyPath = config.privateKeyPath === '~'
      ? homedir()
      : /^[~][\\/]/.test(config.privateKeyPath)
        ? join(homedir(), config.privateKeyPath.slice(2))
        : config.privateKeyPath
    if (!existsSync(privateKeyPath)) {
      throw new Error(`SFTP private key not found: ${config.privateKeyPath}`)
    }
    options.privateKey = readFileSync(privateKeyPath)
    if (config.passphrase) options.passphrase = config.passphrase
  }

  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    client.once('ready', () => {
      client.off('error', onError)
      resolve()
    })
    client.once('error', onError)
    client.connect(options)
  })

  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, wrapper) => error ? reject(error) : resolve(wrapper))
    })
    return { client, sftp }
  } catch (error) {
    client.end()
    throw error
  }
}

function realpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return callSftp<string>((callback) => sftp.realpath(path, callback))
}

function stat(sftp: SFTPWrapper, path: string): Promise<unknown> {
  return callSftp((callback) => sftp.stat(path, callback))
}

function mkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return callSftp<void>((callback) => sftp.mkdir(path, callback))
}

function unlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return callSftp<void>((callback) => sftp.unlink(path, callback))
}

function rename(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<void> {
  return callSftp<void>((callback) => sftp.rename(oldPath, newPath, callback))
}

function fastPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return callSftp<void>((callback) => sftp.fastPut(localPath, remotePath, callback))
}

function fastGet(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<void> {
  return callSftp<void>((callback) => sftp.fastGet(remotePath, localPath, callback))
}

async function resolveRoot(sftp: SFTPWrapper, configuredRoot?: string): Promise<string> {
  const home = posix.normalize(await realpath(sftp, '.'))
  const raw = configuredRoot?.trim()
  if (!raw || raw === '~') return home
  const candidate = raw.startsWith('~/')
    ? posix.resolve(home, raw.slice(2))
    : raw.startsWith('/')
      ? posix.normalize(raw)
      : posix.resolve(home, raw)
  return posix.normalize(await realpath(sftp, candidate))
}

async function resolveRemotePath(
  sftp: SFTPWrapper,
  configuredRoot: string | undefined,
  requestedPath: string,
): Promise<{ root: string; path: string }> {
  const root = await resolveRoot(sftp, configuredRoot)
  const requested = requestedPath.trim()
  if (!requested) throw new Error('Remote path is required')

  const path = requested.startsWith('/')
    ? posix.normalize(requested)
    : posix.resolve(root, requested.replace(/^~\/?/, ''))
  if (!isRemotePathWithinRoot(path, root)) {
    throw new Error(`Remote path must stay inside the configured SFTP root: ${root}`)
  }
  return { root, path }
}

export function isRemotePathWithinRoot(path: string, root: string): boolean {
  const normalizedPath = posix.normalize(path)
  const normalizedRoot = posix.normalize(root)
  if (normalizedRoot === '/') return normalizedPath.startsWith('/')
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

async function ensureRemoteDirectory(sftp: SFTPWrapper, root: string, targetDir: string): Promise<void> {
  if (targetDir === root) return
  const relative = posix.relative(root, targetDir)
  let current = root
  for (const segment of relative.split('/').filter(Boolean)) {
    const candidate = posix.join(current, segment)
    try {
      await stat(sftp, candidate)
    } catch {
      await mkdir(sftp, candidate)
    }
    current = posix.normalize(await realpath(sftp, candidate))
    if (!isRemotePathWithinRoot(current, root)) {
      throw new Error(`Remote upload path resolves outside the configured SFTP root: ${root}`)
    }
  }
}

async function replaceRemoteFile(sftp: SFTPWrapper, tempPath: string, targetPath: string): Promise<void> {
  try {
    await unlink(sftp, targetPath)
  } catch {
    // Target does not exist.
  }
  await rename(sftp, tempPath, targetPath)
}

function requireSftp(profile: RemoteServerProfile): RemoteServerSftpConfig {
  if (!profile.sftp?.enabled) throw new Error('SFTP is not configured for this remote server')
  return profile.sftp
}

export async function testSftpConnection(profile: RemoteServerProfile): Promise<{ ok: true; root: string }> {
  const config = requireSftp(profile)
  const { client, sftp } = await connectSftp(config)
  try {
    return { ok: true, root: await resolveRoot(sftp, config.remoteRoot) }
  } finally {
    sftp.end()
    client.end()
  }
}

export async function transferSftpFile(
  profile: RemoteServerProfile,
  request: SftpTransferRequest,
): Promise<SftpTransferResult> {
  const config = requireSftp(profile)
  if (!request.localPath || !isAbsolute(request.localPath)) {
    throw new Error('Local path must be absolute')
  }

  const { client, sftp } = await connectSftp(config)
  try {
    const resolved = await resolveRemotePath(sftp, config.remoteRoot, request.remotePath)

    if (request.direction === 'upload') {
      const localStat = statSync(request.localPath)
      if (!localStat.isFile()) throw new Error('Local upload path must be a file')

      await ensureRemoteDirectory(sftp, resolved.root, posix.dirname(resolved.path))
      const realParent = posix.normalize(await realpath(sftp, posix.dirname(resolved.path)))
      if (!isRemotePathWithinRoot(realParent, resolved.root)) {
        throw new Error(`Remote upload path resolves outside the configured SFTP root: ${resolved.root}`)
      }
      const targetPath = posix.join(realParent, posix.basename(resolved.path))
      const tempPath = `${targetPath}.craft-upload-${randomUUID()}.tmp`
      try {
        await fastPut(sftp, request.localPath, tempPath)
        await replaceRemoteFile(sftp, tempPath, targetPath)
      } catch (error) {
        try { await unlink(sftp, tempPath) } catch { /* best effort */ }
        throw error
      }
      return {
        success: true,
        direction: request.direction,
        localPath: request.localPath,
        remotePath: targetPath,
        bytes: localStat.size,
      }
    }

    const realRemotePath = posix.normalize(await realpath(sftp, resolved.path))
    if (!isRemotePathWithinRoot(realRemotePath, resolved.root)) {
      throw new Error(`Remote download path resolves outside the configured SFTP root: ${resolved.root}`)
    }

    mkdirSync(dirname(request.localPath), { recursive: true })
    const tempPath = `${request.localPath}.craft-download-${randomUUID()}.tmp`
    try {
      await fastGet(sftp, realRemotePath, tempPath)
      const downloaded = statSync(tempPath)
      rmSync(request.localPath, { force: true })
      renameSync(tempPath, request.localPath)
      return {
        success: true,
        direction: request.direction,
        localPath: request.localPath,
        remotePath: realRemotePath,
        bytes: downloaded.size,
      }
    } finally {
      rmSync(tempPath, { force: true })
    }
  } finally {
    sftp.end()
    client.end()
  }
}
