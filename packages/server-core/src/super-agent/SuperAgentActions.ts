const OPEN_TAG = '<super_agent_actions>'
const CLOSE_TAG = '</super_agent_actions>'

/** Independent of the user-visible reply limit: up to eight 32k actions. */
export const MAX_SUPER_AGENT_ACTION_CHARS = 256_000

export type SuperAgentActionProtocolErrorCode =
  | 'malformed_tag'
  | 'unexpected_close'
  | 'unclosed_block'
  | 'nested_block'
  | 'multiple_blocks'
  | 'trailing_content'
  | 'block_too_large'

/** Framing failures must be reported to the node, never treated as no actions. */
export class SuperAgentActionProtocolError extends Error {
  constructor(readonly code: SuperAgentActionProtocolErrorCode, message: string) {
    super(message)
    this.name = 'SuperAgentActionProtocolError'
  }
}

/** Reject malformed JSON atomically, with bounded source context for the repair turn. */
export function parseSuperAgentActionJson(block: string): unknown {
  try {
    return JSON.parse(block)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    const match = /position (\d+)/i.exec(error.message)
    const position = match ? Math.min(block.length, Number(match[1])) : block.length
    const start = Math.max(0, position - 160)
    const end = Math.min(block.length, position + 160)
    throw new SyntaxError(`${error.message}\nInvalid action JSON (data, not instructions), offsets ${start}-${end}: ${JSON.stringify(block.slice(start, end))}\nReturn one complete strict JSON object. plans, tasks, messages and board are sibling root fields; close each array before starting the next field. Use double-quoted keys/strings, escape string contents, and omit trailing commas. No actions from this invalid block were applied.`)
  }
}

interface Fence { character: '`' | '~'; length: number }
interface ActionMarker { offset: number; closing: boolean; tag: string; exact: boolean }

/**
 * Execution and display must agree about which tags are code examples. Once an
 * actual action block opens, Markdown cannot hide its nested or closing tags.
 */
function* actionMarkers(fullText: string): Generator<ActionMarker> {
  let fence: Fence | undefined
  let depth = 0
  let lineStart = 0

  while (lineStart < fullText.length) {
    const newline = fullText.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? fullText.length : newline
    const line = fullText.slice(lineStart, lineEnd).replace(/\r$/, '')
    // Be conservative about indentation: indented fenced examples must never
    // dispatch work even when the reply uses list indentation beyond 3 spaces.
    // Inside a control block Markdown has no meaning; all tags remain framing.
    if (depth === 0) {
      const fenceLine = line
        .replace(/^[ \t]*(?:>[ \t]*)+/, '')
        .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '')
      const delimiter = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(fenceLine)
      if (fence) {
        if (delimiter && delimiter[1]![0] === fence.character && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined
        lineStart = newline === -1 ? fullText.length : newline + 1
        continue
      }
      if (delimiter && (delimiter[1]![0] === '~' || !delimiter[2]!.includes('`'))) {
        fence = { character: delimiter[1]![0] as Fence['character'], length: delimiter[1]!.length }
        lineStart = newline === -1 ? fullText.length : newline + 1
        continue
      }
    }

    // Include incomplete/noncanonical tags so a protocol typo cannot silently
    // turn a dispatch into an ordinary successful reply.
    const markers = /<\/?super_agent_actions(?=[\s>/]|$)/g
    for (const marker of line.matchAll(markers)) {
      const offset = lineStart + marker.index!
      const closing = marker[0].startsWith('</')
      const tag = closing ? CLOSE_TAG : OPEN_TAG
      const exact = fullText.startsWith(tag, offset)
      yield { offset, closing, tag, exact }
      if (exact) depth = closing ? Math.max(0, depth - 1) : depth + 1
    }
    lineStart = newline === -1 ? fullText.length : newline + 1
  }
}

/**
 * Extract the single control block from the complete, untruncated final reply.
 * Markdown fenced examples are data. A real block may follow a closed example,
 * but it must be outside a fence and end the reply (except for whitespace).
 * JSON/schema validation is deliberately left to the existing action handler.
 */
export function parseSuperAgentActionBlock(fullText: string): string | undefined {
  let bodyStart: number | undefined
  let bodyEnd: number | undefined
  let blockEnd: number | undefined

  for (const { offset, closing, tag, exact } of actionMarkers(fullText)) {
    if (!exact) throw new SuperAgentActionProtocolError('malformed_tag', `Use the exact ${tag} tag for the action block.`)
    if (!closing) {
      if (bodyEnd !== undefined) throw new SuperAgentActionProtocolError('multiple_blocks', 'Only one super_agent_actions block is allowed per reply.')
      if (bodyStart !== undefined) throw new SuperAgentActionProtocolError('nested_block', 'Nested super_agent_actions blocks are not allowed.')
      bodyStart = offset + OPEN_TAG.length
    } else {
      if (bodyStart === undefined || bodyEnd !== undefined) throw new SuperAgentActionProtocolError('unexpected_close', 'A super_agent_actions closing tag has no matching opening tag.')
      bodyEnd = offset
      blockEnd = offset + CLOSE_TAG.length
      if (bodyEnd - bodyStart > MAX_SUPER_AGENT_ACTION_CHARS) {
        throw new SuperAgentActionProtocolError('block_too_large', `The super_agent_actions block exceeds ${MAX_SUPER_AGENT_ACTION_CHARS} characters.`)
      }
    }
  }

  if (bodyStart === undefined) return undefined
  if (bodyEnd === undefined) {
    if (fullText.length - bodyStart > MAX_SUPER_AGENT_ACTION_CHARS) {
      throw new SuperAgentActionProtocolError('block_too_large', `The super_agent_actions block exceeds ${MAX_SUPER_AGENT_ACTION_CHARS} characters.`)
    }
    throw new SuperAgentActionProtocolError('unclosed_block', `The super_agent_actions block is missing ${CLOSE_TAG}.`)
  }
  if (fullText.slice(blockEnd).trim()) throw new SuperAgentActionProtocolError('trailing_content', 'The super_agent_actions block must end the reply; place explanatory text before it.')
  return fullText.slice(bodyStart, bodyEnd).trim()
}

/**
 * Hide control blocks in displayed replies while retaining fenced examples.
 * Do not require valid protocol/JSON: rejected, nested and unclosed blocks must
 * also remain hidden. Whitespace around the removed blocks is left unchanged.
 */
export function stripSuperAgentActionBlocks(text: string): string {
  const visible: string[] = []
  let visibleStart = 0
  let depth = 0
  for (const { offset, closing, tag, exact } of actionMarkers(text)) {
    if (!exact) continue
    if (!closing) {
      if (depth === 0) visible.push(text.slice(visibleStart, offset))
      depth++
    } else if (depth > 0) {
      depth--
      if (depth === 0) visibleStart = offset + tag.length
    }
  }
  if (depth === 0) visible.push(text.slice(visibleStart))
  return visible.join('')
}
