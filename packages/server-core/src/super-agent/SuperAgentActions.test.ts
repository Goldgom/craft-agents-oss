import { describe, expect, test } from 'bun:test'
import { MAX_SUPER_AGENT_ACTION_CHARS, parseSuperAgentActionBlock, stripSuperAgentActionBlocks, SuperAgentActionProtocolError, type SuperAgentActionProtocolErrorCode } from './SuperAgentActions'

const block = (json = '{"tasks":[]}') => `<super_agent_actions>${json}</super_agent_actions>`

function expectProtocolError(text: string, code: SuperAgentActionProtocolErrorCode): void {
  let error: unknown
  try { parseSuperAgentActionBlock(text) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(SuperAgentActionProtocolError)
  expect((error as SuperAgentActionProtocolError).code).toBe(code)
}

describe('Super Agent action block framing', () => {
  test('allows empty and ordinary replies without a control block', () => {
    expect(parseSuperAgentActionBlock('')).toBeUndefined()
    expect(parseSuperAgentActionBlock('验证已经完成。')).toBeUndefined()
    expect(parseSuperAgentActionBlock('x'.repeat(100_000))).toBeUndefined()
  })

  test('extracts the final block and preserves JSON data for schema validation', () => {
    const json = '{\n  "board": [{"id":"result","content":"报告 ✅"}]\n}'
    expect(parseSuperAgentActionBlock(`完成验证。\r\n${block(`\r\n ${json}\r\n`)} \t\r\n`)).toBe(json)
    expect(parseSuperAgentActionBlock(block('not JSON'))).toBe('not JSON')
    expect(parseSuperAgentActionBlock(block(''))).toBe('')
  })

  test('extracts actions after prose that exceeds the display truncation limit', () => {
    const json = JSON.stringify({ tasks: [{ title: '下一步', instructions: '验证输出' }] })
    expect(parseSuperAgentActionBlock(`${'正文\n'.repeat(40_000)}${block(json)}`)).toBe(json)
  })

  test('uses a separate 256k limit for control data, counting surrounding whitespace', () => {
    const json = JSON.stringify({ instructions: 'x'.repeat(MAX_SUPER_AGENT_ACTION_CHARS - 19) })
    expect(json.length).toBe(MAX_SUPER_AGENT_ACTION_CHARS)
    expect(parseSuperAgentActionBlock(block(json))).toBe(json)
    expectProtocolError(block(`${json} `), 'block_too_large')
    expectProtocolError(`<super_agent_actions>${' '.repeat(MAX_SUPER_AGENT_ACTION_CHARS + 1)}`, 'block_too_large')
  })

  test('accepts small actions after a very large fenced example', () => {
    const example = block('x'.repeat(MAX_SUPER_AGENT_ACTION_CHARS + 1))
    expect(parseSuperAgentActionBlock(`\`\`\`text\n${example}\n\`\`\`\n${block('{}')}`)).toBe('{}')
  })

  test('reports an opening block with no closing tag', () => {
    expectProtocolError('<super_agent_actions>{"tasks":[]}', 'unclosed_block')
    expectProtocolError('说明\n<super_agent_actions>\n{}\n', 'unclosed_block')
  })

  test('rejects unmatched and repeated closing tags', () => {
    expectProtocolError('</super_agent_actions>', 'unexpected_close')
    expectProtocolError(`${block()}\n</super_agent_actions>`, 'unexpected_close')
  })

  test('rejects nested blocks before executing any action', () => {
    expectProtocolError(`<super_agent_actions>{}${block()}</super_agent_actions>`, 'nested_block')
    expectProtocolError(`<super_agent_actions>{"content":"<super_agent_actions>"}</super_agent_actions>`, 'nested_block')
  })

  test('rejects two blocks instead of executing only the first', () => {
    expectProtocolError(`${block()}\n${block()}`, 'multiple_blocks')
    expectProtocolError(`${block()}${block()}`, 'multiple_blocks')
  })

  test('rejects any non-whitespace text after the action block', () => {
    expectProtocolError(`${block()}\n已安排。`, 'trailing_content')
    expectProtocolError(`${block()}\n\`\`\`json\n${block()}\n\`\`\``, 'trailing_content')
    expectProtocolError(`${block()}\n<!-- note -->`, 'trailing_content')
  })

  test('reports malformed and incomplete tags instead of ignoring them', () => {
    for (const text of ['<super_agent_actions', '<super_agent_actions >{}', '<super_agent_actions mode="run">{}']) expectProtocolError(text, 'malformed_tag')
    for (const text of ['</super_agent_actions', `${block()}\n</super_agent_actions >`]) expectProtocolError(text, 'malformed_tag')
  })

  test('does not interpret unrelated tag names as the action protocol', () => {
    expect(parseSuperAgentActionBlock('<super_agent_actions_example>sample</super_agent_actions_example>')).toBeUndefined()
  })
})

describe('Markdown control block examples', () => {
  test('never executes complete, incomplete, or nested markers inside fenced code', () => {
    for (const sample of [block(), '<super_agent_actions>{}', `${block()}\n${block()}`, '<super_agent_actions', '</super_agent_actions>']) {
      expect(parseSuperAgentActionBlock(`Example:\n\`\`\`json\n${sample}\n\`\`\``)).toBeUndefined()
    }
  })

  test('supports backtick and tilde fences, CRLF, and indented list examples', () => {
    expect(parseSuperAgentActionBlock(`~~~json\r\n${block()}\r\n~~~`)).toBeUndefined()
    expect(parseSuperAgentActionBlock(`    \`\`\`json\n    ${block()}\n    \`\`\``)).toBeUndefined()
    expect(parseSuperAgentActionBlock(`\t~~~json\n${block()}\n\t~~~`)).toBeUndefined()
  })

  test('ignores fenced examples inside Markdown quotes and lists, including unclosed examples', () => {
    expect(parseSuperAgentActionBlock(`> \`\`\`json\n> ${block()}\n> \`\`\``)).toBeUndefined()
    expect(parseSuperAgentActionBlock(`> \`\`\`json\n> ${block()}`)).toBeUndefined()
    expect(parseSuperAgentActionBlock(`- \`\`\`json\n  ${block()}`)).toBeUndefined()
    expect(parseSuperAgentActionBlock(`1. ~~~json\n   ${block()}\n   ~~~\n${block('{}')}`)).toBe('{}')
    expect(parseSuperAgentActionBlock(`> - [ ] \`\`\`json\n>   ${block()}`)).toBeUndefined()
  })

  test('requires a closing fence of the same character and sufficient length', () => {
    expect(parseSuperAgentActionBlock(`\`\`\`\`json\n\`\`\`\n${block()}\n~~~\n${block()}\n\`\`\`\``)).toBeUndefined()
    expect(parseSuperAgentActionBlock(`~~~json\n~~~still an example\n${block()}\n~~~~`)).toBeUndefined()
  })

  test('ignores an unclosed fenced example through the end of the reply', () => {
    expect(parseSuperAgentActionBlock(`\`\`\`json\n${block()}`)).toBeUndefined()
  })

  test('extracts a real block after a closed example without replaying the example', () => {
    const example = '{"tasks":[{"title":"不要执行示例"}]}'
    const real = '{"board":[{"id":"verified","content":"正确产物"}]}'
    expect(parseSuperAgentActionBlock(`格式示例：\n\`\`\`json\n${block(example)}\n\`\`\`\n验证完成。\n${block(real)}`)).toBe(real)
  })

  test('ignores protocol markers in a fence info string', () => {
    expect(parseSuperAgentActionBlock(`~~~ ${block()}\nexample\n~~~`)).toBeUndefined()
  })

  test('does not let Markdown hide a nested tag within an actual control block', () => {
    expectProtocolError(`<super_agent_actions>\n\`\`\`\n${block()}\n\`\`\`\n</super_agent_actions>`, 'nested_block')
  })
})

describe('Super Agent action block display', () => {
  test('preserves ordinary text and surrounding whitespace without trimming it', () => {
    expect(stripSuperAgentActionBlocks('')).toBe('')
    expect(stripSuperAgentActionBlocks('  验证完成。\r\n')).toBe('  验证完成。\r\n')
    expect(stripSuperAgentActionBlocks(`  验证完成。\r\n${block()} \t\r\n`)).toBe('  验证完成。\r\n \t\r\n')
  })

  test('preserves fenced examples exactly, including malformed and unclosed samples', () => {
    for (const sample of [block(), '<super_agent_actions>{}', '<super_agent_actions', `${block()}\n${block()}`]) {
      const example = `格式示例：\r\n\`\`\`json\r\n${sample}\r\n\`\`\``
      expect(stripSuperAgentActionBlocks(example)).toBe(example)
    }
    const unfinished = `\`\`\`json\n${block()}`
    expect(stripSuperAgentActionBlocks(unfinished)).toBe(unfinished)
  })

  test('retains examples inside quotes, lists, and different fence styles', () => {
    for (const example of [
      `> \`\`\`json\n> ${block()}\n> \`\`\``,
      `- \`\`\`json\n  ${block()}`,
      `1. ~~~json\n   ${block()}\n   ~~~`,
      `    \`\`\`\`json\n    \`\`\`\n    ${block()}\n    \`\`\`\``,
      `~~~ ${block()}\nexample\n~~~`,
    ]) expect(stripSuperAgentActionBlocks(example)).toBe(example)
  })

  test('preserves a fenced example while hiding the real block after it', () => {
    const prefix = `格式示例：\n\`\`\`json\n${block('{"example":true}')}\n\`\`\`\n实际验证完成。\n`
    const reply = `${prefix}${block('{"board":[]}')}\n`
    expect(parseSuperAgentActionBlock(reply)).toBe('{"board":[]}')
    expect(stripSuperAgentActionBlocks(reply)).toBe(`${prefix}\n`)
  })

  test('hides incomplete real blocks through the end of the reply', () => {
    expect(stripSuperAgentActionBlocks('结果\n<super_agent_actions>{"board":[')).toBe('结果\n')
    expect(stripSuperAgentActionBlocks('结果\n<super_agent_actions>\n```json\nsecret\n```')).toBe('结果\n')
  })

  test('hides all real blocks even when protocol validation rejects multiple blocks', () => {
    expect(stripSuperAgentActionBlocks(`前文${block()}\n正文${block()}\n后文`)).toBe('前文\n正文\n后文')
  })

  test('hides nested and unfinished outer blocks without leaking their remainder', () => {
    expect(stripSuperAgentActionBlocks(`前文<super_agent_actions>outer${block()}tail</super_agent_actions>后文`)).toBe('前文后文')
    expect(stripSuperAgentActionBlocks(`前文<super_agent_actions>outer${block()}tail`)).toBe('前文')
  })

  test('does not let code fences inside a real block expose its control data', () => {
    expect(stripSuperAgentActionBlocks(`结果\n<super_agent_actions>\n\`\`\`\n${block()}\n\`\`\`\n</super_agent_actions>\n`)).toBe('结果\n\n')
  })

  test('retains a fenced example appearing after a rejected real block', () => {
    const example = `\`\`\`json\n${block()}\n\`\`\``
    expect(stripSuperAgentActionBlocks(`${block()}\n${example}`)).toBe(`\n${example}`)
  })
})
