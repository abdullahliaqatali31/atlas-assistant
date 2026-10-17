import { describe, expect, test } from 'claude-code/testing'

import { bar, currentPhase, findSecret, newlyDone, parseRoadmap, statusLine } from './roadmap.ts'

const SAMPLE = JSON.stringify({
  phases: [
    { id: '0', name: 'Validation', items: [{ title: 'Voice bake-off', status: 'done' }] },
    {
      id: '1',
      name: 'Foundation',
      items: [
        { title: 'Policy gate', status: 'done' },
        { title: 'Electron shell', status: 'todo' },
      ],
    },
  ],
})

describe('roadmap', () => {
  test('parses and finds the current phase', async () => {
    const r = parseRoadmap(SAMPLE)
    expect(currentPhase(r)?.name).toBe('Foundation')
    expect(statusLine(r)).toBe('Phase 1 · Foundation 1/2 · overall 67%')
  })

  test('rejects a bad status', async () => {
    expect(() => parseRoadmap('{"phases":[{"name":"x","items":[{"title":"y","status":"maybe"}]}]}')).toThrow()
  })

  test('reports newly finished items', async () => {
    const before = parseRoadmap(SAMPLE)
    const after = parseRoadmap(SAMPLE.replace('"todo"', '"done"'))
    expect(newlyDone(before, after)).toEqual(['Electron shell'])
  })

  test('draws a proportional bar', async () => {
    expect(bar(1, 2, 4)).toBe('██░░')
    expect(bar(0, 0, 3)).toBe('░░░')
  })
})

describe('key guard', () => {
  const key = `sk-ant-api03-${'a'.repeat(40)}`

  test('blocks keys in tracked files, including .env.example', async () => {
    expect(findSecret('C:/p/src/config.ts', `const k = "${key}"`)).toBe('Anthropic API key')
    expect(findSecret('C:/p/.env.example', `ANTHROPIC_API_KEY=${key}`)).toBe('Anthropic API key')
  })

  test('allows the local .env and placeholder text', async () => {
    expect(findSecret('C:/p/.env', `ANTHROPIC_API_KEY=${key}`)).toBeUndefined()
    expect(findSecret('C:/p/README.md', 'set ANTHROPIC_API_KEY=sk-ant-...')).toBeUndefined()
  })
})
