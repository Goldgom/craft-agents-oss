const { existsSync, readdirSync, realpathSync, rmSync, statSync } = require('node:fs')
const { join, sep } = require('node:path')

module.exports = async function pruneWindowsResources(context) {
  if (context.electronPlatformName !== 'win32') return

  const appRoot = realpathSync(context.appOutDir)
  const resourcesRoot = join(appRoot, 'resources')
  const contentRoot = join(resourcesRoot, 'app')

  // Fail before pruning if the canonical runtimes or subprocess entries are
  // missing. Keep complete JDK/Python/Node/Git distributions, including npm/pip.
  const requiredFiles = [
    join(resourcesRoot, 'vendor', 'bun', 'bun.exe'),
    join(contentRoot, 'resources', 'bin', 'win32-x64', 'uv.exe'),
    join(contentRoot, 'resources', 'bridge-mcp-server', 'index.js'),
    join(contentRoot, 'resources', 'session-mcp-server', 'index.js'),
    join(contentRoot, 'resources', 'pi-agent-server', 'index.js'),
    join(contentRoot, 'vendor', 'git-bash', 'bin', 'bash.exe'),
    join(contentRoot, 'vendor', 'git-bash', 'cmd', 'git.exe'),
    join(contentRoot, 'vendor', 'toolchains', 'jdk', 'bin', 'java.exe'),
    join(contentRoot, 'vendor', 'toolchains', 'jdk', 'bin', 'javac.exe'),
    join(contentRoot, 'vendor', 'toolchains', 'python', 'python.exe'),
    join(contentRoot, 'vendor', 'toolchains', 'python', 'Scripts', 'pip.cmd'),
    join(contentRoot, 'vendor', 'toolchains', 'node', 'node.exe'),
    join(contentRoot, 'vendor', 'toolchains', 'node', 'npm.cmd'),
  ]
  for (const file of requiredFiles) {
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new Error(`Required Windows runtime missing: ${file}`)
    }
  }

  const duplicateDirectories = [
    join(contentRoot, 'vendor', 'bun'),
    join(contentRoot, 'dist', 'resources', 'bin'),
    ...['bridge-mcp-server', 'session-mcp-server', 'pi-agent-server']
      .map(name => join(contentRoot, 'dist', 'resources', name)),
  ]
  const binRoot = join(contentRoot, 'resources', 'bin')
  for (const entry of readdirSync(binRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && /^(darwin|linux|win32)-/.test(entry.name) && entry.name !== 'win32-x64') {
      duplicateDirectories.push(join(binRoot, entry.name))
    }
  }

  // Validate every target first. A redirected directory must never cause us
  // to delete a retained runtime or a path outside this packaging output.
  const directoriesToRemove = duplicateDirectories.filter(existsSync)
  for (const directory of directoriesToRemove) {
    const resolvedDirectory = realpathSync(directory)
    if (!resolvedDirectory.toLowerCase().startsWith((appRoot + sep).toLowerCase())
      || resolvedDirectory.toLowerCase() !== directory.toLowerCase()) {
      throw new Error(`Refusing to prune redirected Windows resource: ${directory}`)
    }
  }
  for (const directory of directoriesToRemove) {
    rmSync(directory, { recursive: true, force: true })
    console.log(`Removed redundant Windows resource: ${directory}`)
  }
}
