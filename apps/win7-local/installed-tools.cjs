'use strict'
const fs = require('node:fs')
const path = require('node:path')

function readInstalledTools(filename) {
  const result = Object.create(null)
  let text
  try {
    const bytes = fs.readFileSync(filename)
    text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString('utf16le') : bytes.toString('utf8')
  } catch { return result }
  let section
  for (const line of text.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const match = line.match(/^\[(git|python|java|node|mingw)\]$/)
    if (match) { section = match[1]; result[section] = Object.create(null) }
    else if (/^\[/.test(line)) section = undefined
    else if (section) {
      const field = line.match(/^(root|executable|path)=(.*)$/)
      if (field && path.isAbsolute(field[2]) && !/^[\\/]{2}/.test(field[2]) && !/[\0;\r\n]/.test(field[2])) result[section][field[1]] = field[2]
    }
  }
  for (const [id, tool] of Object.entries(result)) {
    if (!tool.executable || !tool.root || !tool.path || !fs.existsSync(tool.executable)) { delete result[id]; continue }
    const relative = path.relative(tool.root, tool.executable)
    const relativePath = path.relative(tool.root, tool.path)
    if (relative.startsWith('..') || path.isAbsolute(relative) || relativePath.startsWith('..') || path.isAbsolute(relativePath)) delete result[id]
  }
  return result
}

// App-only PATH works even when user opted out of global/user PATH edits.
function applyInstalledToolEnvironment(tools, env = process.env) {
  const entries = Object.values(tools).map(tool => tool.path)
  if (tools.python) entries.push(path.join(tools.python.root, 'Scripts'))
  const prior = (env.PATH || '').split(path.delimiter)
  const seen = new Set()
  env.PATH = [...entries, ...prior].filter(entry => {
    if (!entry || seen.has(entry.toLowerCase())) return false
    seen.add(entry.toLowerCase()); return true
  }).join(path.delimiter)
  if (tools.git && !env.CLAUDE_CODE_GIT_BASH_PATH) env.CLAUDE_CODE_GIT_BASH_PATH = tools.git.executable
}
module.exports = { readInstalledTools, applyInstalledToolEnvironment }
