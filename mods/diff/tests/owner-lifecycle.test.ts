import type { On, SessionMessage } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import Limits from '../hooks/limits'
import Fixtures from './fixtures'

tier('builtin')

const MOVED = {
  'HEAD --shortstat': ' 1 file changed, 1 insertion(+)',
  'HEAD --numstat': '1\t0\tother.ts\0',
  'ls-files': '',
  '-- other.ts': '@@ -1 +1 @@\n-const b = 1\n+const b = 2\n',
}

function lifecycleWorld(on: On) {
  const script: Record<string, string> = { ...Fixtures.REPOSITORY }
  const state = {
    delayRead: 0,
    delayMessages: 0,
    transcript: [] as readonly SessionMessage[],
  }
  const clock = Fixtures.startsSession(on)
  const opened: { id: string }[] = []
  const closed: { id: string }[] = []
  const reads: string[] = []

  on('process.run', async (_engine, e) => {
    const value = Fixtures.gitIn(e.argv, script)
    if (e.argv.includes('--numstat')) {
      reads.push(value.stdout)
      if (state.delayRead > 0) await clock.sleep(state.delayRead)
    }
    return { value }
  })
  on('session.messages', async () => {
    const value = [...state.transcript]
    const delay = state.delayMessages
    state.delayMessages = 0
    if (delay > 0) await clock.sleep(delay)
    return { value }
  })
  on('session.usage', () => ({ value: Fixtures.usageAt(0) }))
  on('command.run', { command: ['clear', 'resume'] }, () => ({}))
  on('tool.call', (_$, e) =>
    e.tool === 'Bash' && e.command === 'ls'
      ? Fixtures.READ_ONLY_ANSWER
      : { result: 'done' },
  )
  on('ui.open', (_engine, e) => { opened.push({ id: e.id }); return { value: undefined } })
  on('ui.close', (_engine, e) => { closed.push({ id: e.id }); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', { component: 'PromptHint' }, () => Fixtures.HINT_DRAWN)
  on('settings.read', () => ({ value: {} }))
  mock.store(on, {})
  mock.env(on, {})

  return { clock, opened, closed, script, state, reads }
}

describe('owner-lifecycle', () => {
  for (const command of ['ls', 'make']) {
    test(`${command} during the initial fetch preserves the needed catch-up behavior`, async ($, on) => {
      const world = lifecycleWorld(on)
      world.state.delayRead = 1000
      await $.session.start(Fixtures.SESSION)
      const opening = $.command.run(Fixtures.DIFF)
      await world.clock.settle()
      expect(world.reads).toHaveLength(1)
      if (command === 'make') Object.assign(world.script, MOVED)
      await $.tool.call({ tool: 'Bash', command })
      world.state.delayRead = 0
      await world.clock.advance(1000)
      await opening
      await world.clock.advance(Fixtures.SETTLE_MS)
      expect(world.reads).toHaveLength(command === 'ls' ? 1 : 2)
      expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain(
        command === 'ls' ? 'app.ts' : 'other.ts',
      )
    })
  }

  test('quiet /clear keeps the pane open and fetches fresh data once', async ($, on) => {
    const world = lifecycleWorld(on)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const before = world.reads.length
    Object.assign(world.script, MOVED)
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.closed).toEqual([])
    expect(world.reads.slice(before)).toEqual([MOVED['HEAD --numstat']])
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  test('/clear consumes a pending refresh instead of leaving a duplicate read', async ($, on) => {
    const world = lifecycleWorld(on)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const before = world.reads.length
    await $.tool.call({ tool: 'Bash', command: 'make' })
    Object.assign(world.script, MOVED)
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.closed).toEqual([])
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
    expect(world.reads.slice(before), 'one fresh read for /clear').toEqual([
      MOVED['HEAD --numstat'],
    ])
  })

  test('a read started before /clear cannot publish an obsolete snapshot', async ($, on) => {
    const world = lifecycleWorld(on)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    Object.assign(world.script, {
      'HEAD --numstat': '1\t0\tobsolete.ts\0',
      '-- obsolete.ts': '@@ -1 +1 @@\n-old\n+obsolete\n',
    })
    world.state.delayRead = 1000
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
    Object.assign(world.script, MOVED)
    world.state.delayRead = 2000
    await $.command.run(Fixtures.CLEAR)
    const reset = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    await world.clock.advance(1000)
    const afterOldRead = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    await world.clock.advance(4000)
    const settled = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    expect(settled, 'the fresh request eventually wins').toContain('other.ts')
    expect(reset, 'the last displayed fetch is retained while waiting').toContain('app.ts')
    expect(afterOldRead, 'the previous session cannot publish its snapshot').not.toContain('obsolete.ts')
  })

  test('delayed restored history cannot reopen the pane after /clear', async ($, on) => {
    const world = lifecycleWorld(on)
    world.state.transcript = Fixtures.EDITED_TRANSCRIPT
    world.state.delayMessages = 1000
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    await world.clock.settle()
    expect(world.opened, 'restore read is still pending').toEqual([])
    world.state.transcript = []
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(3000)
    expect(world.opened, 'old history belongs to the cleared session').toEqual([])
  })

  test('delayed restored history opens normally without /clear', async ($, on) => {
    const world = lifecycleWorld(on)
    world.state.transcript = Fixtures.EDITED_TRANSCRIPT
    world.state.delayMessages = 1000
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    await world.clock.advance(3000)
    expect(world.opened.map(pane => pane.id)).toEqual(['diff'])
  })

  test('/resume consumes a pending refresh when restored history has no edits', async ($, on) => {
    const world = lifecycleWorld(on)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const before = world.reads.length
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await $.command.run(Fixtures.RESUME)
    await world.clock.advance(3000)
    expect(world.closed.map(pane => pane.id)).toEqual(['diff'])
    expect(world.opened.map(pane => pane.id)).toEqual(['diff'])
    expect(world.reads.slice(before), 'the closed pane has no old refresh left').toEqual([])
  })

  test('/resume discards a restored-history read from the previous session', async ($, on) => {
    const world = lifecycleWorld(on)
    world.state.transcript = Fixtures.EDITED_TRANSCRIPT
    world.state.delayMessages = 1000
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    await world.clock.settle()
    expect(world.opened, 'the previous restore is still pending').toEqual([])
    world.state.transcript = []
    await $.command.run(Fixtures.RESUME)
    await world.clock.advance(3000)
    expect(world.opened, 'the resumed session has no edits to open for').toEqual([])
  })
})
