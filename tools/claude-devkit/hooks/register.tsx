import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Roadmap } from '../types'
import { bar, countDone, currentPhase, findSecret, newlyDone, parseRoadmap, ROADMAP_PATH, statusLine } from './roadmap.ts'

const PANE = 'assistant-roadmap'
const roadmap = atom({ plugin: 'assistant-devkit', key: 'roadmap' } as const, null)
const error = atom({ plugin: 'assistant-devkit', key: 'error' } as const, null)
const isCompact = atom({ plugin: 'assistant-devkit', key: 'isCompact' } as const, false)

const MARK = { done: '✓', doing: '▸', todo: '·' } as const

/** Re-reads docs/roadmap.json; a missing file just means this is not the project. */
const refresh = async ($: EngineInterface, { celebrate = false } = {}) => {
  let text: string
  try {
    text = await $.fs.read(ROADMAP_PATH)
  } catch {
    await update($, roadmap, () => null)
    $.ui.status(undefined)
    return
  }
  try {
    const next: Roadmap = parseRoadmap(text)
    const before = await read($, roadmap)
    await update($, roadmap, () => next)
    await update($, error, () => null)
    $.ui.status(statusLine(next))
    if (celebrate) {
      const done = newlyDone(before, next)
      if (done.length > 0) $.ui.toast(`Roadmap: done ${done.join(', ')}`)
    }
  } catch (e) {
    await update($, error, () => (e instanceof Error ? e.message : String(e)))
  }
}

const touchesRoadmap = (path: string) => path.replaceAll('\\', '/').endsWith(ROADMAP_PATH)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'roadmap', description: 'Show the Personal Assistant roadmap pane' })
    await refresh($)
    if (await read($, roadmap)) void $.ui.open({ id: PANE, title: 'Roadmap' })
    return started
  })

  on('command.run', { command: 'roadmap' }, async $ => {
    await refresh($)
    const current = await read($, roadmap)
    if (!current) return { text: `No ${ROADMAP_PATH} in this folder.` }
    await $.ui.open({ id: PANE, title: 'Roadmap' })
    return { text: statusLine(current) ?? 'Roadmap opened.' }
  })

  // Never write a provider API key into a tracked file; keep the pane live when the roadmap changes.
  const denyKey = (plugin: string, hit: string, path: string) => ({
    deny: `${plugin}: that looks like a real ${hit}. Keys belong in .env (gitignored), never in ${path}.`,
  })
  const guardFailed = (plugin: string) => ({ deny: `${plugin}: its key guard failed.` })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const hit = findSecret(e.file_path, e.content)
    if (hit) return denyKey($.plugin.name, hit, e.file_path)
    const ran = await next(e)
    if (touchesRoadmap(e.file_path)) await refresh($, { celebrate: true })
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : guardFailed($.plugin.name)))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const hit = findSecret(e.file_path, e.new_string)
    if (hit) return denyKey($.plugin.name, hit, e.file_path)
    const ran = await next(e)
    if (touchesRoadmap(e.file_path)) await refresh($, { celebrate: true })
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : guardFailed($.plugin.name)))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, roadmap)
    const problem = await read($, error)
    const compact = await read($, isCompact)

    if (!current) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No {ROADMAP_PATH} in this folder.</Text>
        </Box>
      )
    }

    const active = currentPhase(current)

    return (
      <Box flexDirection="column">
        <Box>
          <Text weight="bold">Personal Assistant roadmap </Text>
          <Button key="toggle" label={compact ? 'Show items' : 'Phases only'} onPress={() => update($, isCompact, v => !v)} />
          <Text> </Text>
          <Button key="reload" label="Reload" onPress={() => refresh($)} />
        </Box>
        {problem && <Text color="error">roadmap.json: {problem}</Text>}
        {current.phases.map(phase => {
          const done = countDone(phase)
          const isActive = phase === active
          const showItems = !compact || isActive
          return (
            <Box key={`phase-${phase.id}`} flexDirection="column" marginTop={1}>
              <Text color={done === phase.items.length ? 'success' : isActive ? 'claude' : 'subtle'} weight={isActive ? 'bold' : 'regular'}>
                {isActive ? '▶ ' : '  '}Phase {phase.id} · {phase.name}  {bar(done, phase.items.length)} {done}/{phase.items.length}
              </Text>
              {showItems &&
                phase.items.map((item, i) => (
                  <Text
                    key={`item-${phase.id}-${i}`}
                    color={item.status === 'done' ? 'success' : item.status === 'doing' ? 'warning' : undefined}
                    dimColor={item.status === 'todo'}
                  >
                    {'    '}
                    {MARK[item.status]} {item.title}
                  </Text>
                ))}
            </Box>
          )
        })}
        <Box marginTop={1}>
          <Text dimColor>✓ done  ▸ doing  · todo — edit {ROADMAP_PATH} to update</Text>
        </Box>
      </Box>
    )
  })
}
