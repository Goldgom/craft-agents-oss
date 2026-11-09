import React from 'react'
import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { superAgentSelectOptions } from './SuperAgentSelect'

test('themed select preserves empty values, mapped options, fragments and disabled placeholders', () => {
  const options = superAgentSelectOptions(<>
    <option value="" disabled>Choose connection</option>
    {false}
    {['first', 'second'].map(value => <option key={value} value={value}>{value}</option>)}
    <><option value="legacy">Legacy model</option></>
  </>)
  expect(options).toEqual([
    { value: '', label: 'Choose connection', disabled: true },
    { value: 'first', label: 'first', disabled: undefined },
    { value: 'second', label: 'second', disabled: undefined },
    { value: 'legacy', label: 'Legacy model', disabled: undefined },
  ])
})

test('all Super Agent forms use theme-aware dropdowns rather than native selects', () => {
  for (const file of readdirSync(import.meta.dir).filter(name => name.startsWith('SuperAgent') && name.endsWith('.tsx'))) {
    expect(readFileSync(`${import.meta.dir}/${file}`, 'utf8')).not.toMatch(/<select\b/)
  }
})
