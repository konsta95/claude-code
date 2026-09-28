import type { On, SessionMessage } from 'claude-code'
import type { Plugin } from 'claude-code/testing'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import Limits from '../hooks/limits'
import Names from '../hooks/names'
import Fixtures from './fixtures'

tier('builtin')

const MOVED = {
  'HEAD --shortstat': ' 1 file changed, 1 insertion(+)',
  'HEAD --numstat': '1\t0\tother.ts\0',
  'ls-files': '',
  '-- other.ts': '@@ -1 +1 @@\n-const b = 1\n+const b = 2\n',
}

const RECORDING: Plugin = {
  name: 'recording',
  tier: 'builtin',
  register(on) {
    on('telemetry.mark', async ($, e) => {
      await $.ui.log(`mark ${JSON.stringify(e)}`)
      return { value: undefined }
    })
    on('telemetry.log', () => ({ value: undefined }))
    on('engine.create', async ($, e, next) => {
      const beneath = await next(e)
      const added = {
        telemetry: { log: async () => undefined, mark: async () => undefined },
      }
      return { ...added, ...beneath }
    })
  },
}

function lifecycleWorld(on: On, stored: Record<string, unknown> = {}) {
  const script: Record<string, string> = { ...Fixtures.REPOSITORY }
  const state = {
    delayRead: 0,
    delayMessages: 0,
    delayPreference: 0,
    delaySettings: 0,
    delayBody: 0,
    delayOpen: 0,
    delayClose: 0,
    delaySessionId: 0,
    delayUsage: 0,
    startedAt: 0,
    failRead: false,
    failBody: false,
    failOpen: false,
    denyClose: false,
    transcript: [] as readonly SessionMessage[],
  }
  const clock = Fixtures.startsSession(on)
  const opened: { id: string }[] = []
  const closed: { id: string }[] = []
  const pane = { visible: false }
  const reads: string[] = []
  const counts = { messages: 0, preferences: 0, settings: 0, bodies: 0 }
  const marks: string[] = []
  const logs: string[] = []
  const preferences: unknown[] = []

  on('process.run', async (_engine, e) => {
    const line = e.argv.join(' ')
    if (line.includes('HEAD --numstat') && state.failRead) {
      if (state.delayRead > 0) await clock.sleep(state.delayRead)
      return {
        value: {
          exitCode: 128, stdout: '', stderr: 'fatal: test read',
          isStdoutTruncated: false, isStderrTruncated: false,
        },
      }
    }
    if (e.argv.includes('--') && !line.includes('ls-files')) {
      counts.bodies += 1
      const fails = state.failBody
      if (state.delayBody > 0) await clock.sleep(state.delayBody)
      if (fails) {
        return {
          value: {
            exitCode: 128, stdout: '', stderr: 'fatal: test body',
            isStdoutTruncated: false, isStderrTruncated: false,
          },
        }
      }
    }
    const value = Fixtures.gitIn(e.argv, script)
    if (e.argv.includes('--numstat')) {
      reads.push(value.stdout)
      if (state.delayRead > 0) await clock.sleep(state.delayRead)
    }
    return { value }
  })
  on('session.messages', async () => {
    counts.messages += 1
    const value = [...state.transcript]
    const delay = state.delayMessages
    state.delayMessages = 0
    if (delay > 0) await clock.sleep(delay)
    return { value }
  })
  on('session.usage', async () => {
    const startedAt = state.startedAt
    if (state.delayUsage > 0) await clock.sleep(state.delayUsage)
    return { value: Fixtures.usageAt(startedAt) }
  })
  on('session.id', async () => {
    if (state.delaySessionId > 0) await clock.sleep(state.delaySessionId)
    return { value: 'test-session' }
  })
  on('command.run', { command: ['clear', 'resume'] }, () => ({}))
  on('tool.call', (_$, e) =>
    e.tool === 'Bash' && e.command === 'ls'
      ? Fixtures.READ_ONLY_ANSWER
      : { result: 'done' },
  )
  on('ui.open', async (_engine, e) => {
    opened.push({ id: e.id })
    const fails = state.failOpen
    if (state.delayOpen > 0) await clock.sleep(state.delayOpen)
    if (fails) throw new Error('test placement failed')
    pane.visible = true
    return { value: undefined }
  })
  on('ui.close', async (_engine, e) => {
    closed.push({ id: e.id })
    const denied = state.denyClose
    state.denyClose = false
    if (state.delayClose > 0) await clock.sleep(state.delayClose)
    if (denied) return { deny: 'test close denied' }
    pane.visible = false
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', { component: 'PromptHint' }, () => Fixtures.HINT_DRAWN)
  on('settings.read', async () => {
    counts.settings += 1
    if (state.delaySettings > 0) await clock.sleep(state.delaySettings)
    return { value: {} }
  })
  on('store.*', async ($, e, next) => {
    const result = await next(e)
    if (next.is('store.set', e) && e.key === Names.STORE_OPEN_KEY) {
      preferences.push(e.value)
    }
    if (next.is('store.get', e) && e.key === Names.STORE_OPEN_KEY) {
      counts.preferences += 1
      if (state.delayPreference > 0) await clock.sleep(state.delayPreference)
    }
    return result
  })
  on('ui.log', ($, e) => {
    if (!e.text.startsWith('mark ')) logs.push(e.text)
    if (e.text.startsWith('mark ')) {
      const mark = JSON.parse(e.text.slice(5))
      if (mark.feature === 'repl_diff_read') {
        marks.push(mark.kind === 'ok' ? 'ok' : `${mark.kind}:${mark.reason}`)
      }
    }
    return { value: undefined }
  })
  mock.store(on, stored)
  mock.env(on, {})

  return { clock, opened, closed, pane, script, state, reads, counts, marks, logs, preferences }
}

function filesWrittenAt(on: On, mtimeMs: number) {
  on('fs.list', () => ({
    value: [
      { name: 'app.ts', kind: 'file', size: 2, isLink: false },
      { name: 'other.ts', kind: 'file', size: 2, isLink: false },
    ],
  }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 2, mtimeMs, isLink: false } }))
}

describe('owner-lifecycle', () => {
  for (const command of ['clear', 'resume'] as const) {
    for (const path of ['manual', 'auto'] as const) {
      test(`denied ${path} cleanup waits for /${command} session timing before dating files`, async ($, on) => {
        const world = lifecycleWorld(on)
        filesWrittenAt(on, 2000)
        world.state.startedAt = 100
        await $.session.start(Fixtures.SESSION)
        await $.ui.render(Fixtures.HINT)
        await world.clock.advance(5000)
        world.state.delayOpen = 1000
        const opening = path === 'manual'
          ? $.command.run(Fixtures.DIFF)
          : $.tool.call({
              tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
            })
        await world.clock.settle()
        expect(world.opened).toHaveLength(1)

        Object.assign(world.script, MOVED)
        world.state.startedAt = 5000
        world.state.delayUsage = 3000
        world.state.denyClose = true
        const changing = $.command.run(command === 'clear' ? Fixtures.CLEAR : Fixtures.RESUME)
        await world.clock.advance(1500)
        world.state.delayUsage = 0
        await world.clock.advance(3000)
        await changing
        await opening
        await world.clock.advance(Fixtures.SETTLE_MS)

        expect(world.logs.join('\n')).toContain('test close denied')
        expect(world.pane.visible).toBe(true)
        const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
        expect(text).toContain('No changes this session')
        expect(text).toContain('1 file edited before this session')
      })
    }
  }

  test('a kept-open pane waits for clear session timing before dating files', async ($, on) => {
    const world = lifecycleWorld(on)
    filesWrittenAt(on, 2000)
    world.state.startedAt = 100
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(5000)
    Object.assign(world.script, MOVED)
    world.state.startedAt = 5000
    world.state.delayUsage = 3000
    const clearing = $.command.run(Fixtures.CLEAR)
    await world.clock.advance(4000)
    await clearing
    await world.clock.advance(Fixtures.SETTLE_MS)

    expect(world.pane.visible).toBe(true)
    const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    expect(text).toContain('No changes this session')
    expect(text).toContain('1 file edited before this session')
  })

  test('an older clear cannot overwrite a newer session start', async ($, on) => {
    const world = lifecycleWorld(on)
    filesWrittenAt(on, 6000)
    world.state.startedAt = 100
    await $.session.start(Fixtures.SESSION)
    await world.clock.advance(5000)
    world.state.startedAt = 5000
    world.state.delayUsage = 3000
    const older = $.command.run(Fixtures.CLEAR)
    await world.clock.advance(2000)
    world.state.startedAt = 7000
    world.state.delayUsage = 0
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(2000)
    await older
    Object.assign(world.script, MOVED)
    expect(await $.command.run(Fixtures.DIFF)).toEqual({ text: Names.PANEL_SHOWN_TEXT })
    await world.clock.advance(Fixtures.SETTLE_MS)

    const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    expect(text).toContain('No changes this session')
    expect(text).toContain('1 file edited before this session')
  })

  test('clear during a manual open preserves the shown reply and open preference', async ($, on) => {
    const world = lifecycleWorld(on, { [Names.STORE_OPEN_KEY]: false })
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    await world.clock.settle()
    world.state.delaySessionId = 1000
    const opening = $.command.run(Fixtures.DIFF)
    await world.clock.settle()
    expect(world.pane.visible).toBe(true)
    await $.command.run(Fixtures.CLEAR)
    world.state.delaySessionId = 0
    await world.clock.advance(3000)

    expect(await opening).toEqual({ text: Names.PANEL_SHOWN_TEXT })
    expect(world.preferences).toEqual([true])
    expect(world.pane.visible).toBe(true)
    expect(await $.command.run(Fixtures.DIFF)).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
    expect(world.pane.visible).toBe(false)
  })

  for (const path of ['manual', 'auto'] as const) {
    test(`a denied stale ${path} cleanup reports the failure and refreshes the retained pane`, async ($, on) => {
      const world = lifecycleWorld(on)
      await $.session.start(Fixtures.SESSION)
      await $.ui.render(Fixtures.HINT)
      await world.clock.settle()
      world.state.delayOpen = 1000
      const opening = (path === 'manual'
        ? $.command.run(Fixtures.DIFF)
        : $.tool.call({
            tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
          })).then(
            reply => ({ reply }),
            (error: unknown) => ({ error: String(error) }),
          )
      await world.clock.settle()
      expect(world.opened).toHaveLength(1)
      await $.command.run(Fixtures.CLEAR)
      Object.assign(world.script, MOVED)
      world.state.delayOpen = 0
      world.state.denyClose = true
      await world.clock.advance(3000)
      const outcome = await opening

      expect(outcome).toHaveProperty('reply')
      if (path === 'manual') {
        expect(outcome).toEqual({ reply: { text: Names.PANEL_SHOWN_TEXT } })
      }
      expect(world.logs.join('\n')).toContain('test close denied')
      expect(world.pane.visible).toBe(true)
      const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
      expect(text).toContain('other.ts')
      expect(text).not.toContain('app.ts')
      expect(await $.command.run(Fixtures.DIFF)).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
      expect(world.pane.visible).toBe(false)
    })
  }

  test('a rejected old placement does not prevent the new session from opening', async ($, on) => {
    const world = lifecycleWorld(on)
    await $.session.start(Fixtures.SESSION)
    world.state.delayOpen = 1000
    world.state.failOpen = true
    const old = $.command.run(Fixtures.DIFF).then(() => 'resolved', () => 'rejected')
    await world.clock.settle()
    expect(world.opened).toHaveLength(1)
    await $.command.run(Fixtures.CLEAR)
    Object.assign(world.script, MOVED)
    world.state.delayOpen = 0
    world.state.failOpen = false
    const current = $.command.run(Fixtures.DIFF)
    await world.clock.advance(3000)

    expect(await old, 'the original caller still sees its failure').toBe('rejected')
    expect(await current).toEqual({ text: Names.PANEL_SHOWN_TEXT })
    expect(world.pane.visible).toBe(true)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  test('a second session change cancels a placement waiting behind the first', async ($, on) => {
    const world = lifecycleWorld(on)
    await $.session.start(Fixtures.SESSION)
    world.state.delayOpen = 1000
    const old = $.command.run(Fixtures.DIFF)
    await world.clock.settle()
    expect(world.opened).toHaveLength(1)
    await $.command.run(Fixtures.CLEAR)
    world.state.delayOpen = 0
    const middle = $.command.run(Fixtures.DIFF)
    await world.clock.settle()
    await $.command.run(Fixtures.RESUME)
    Object.assign(world.script, MOVED)
    const current = $.command.run(Fixtures.DIFF)
    await world.clock.advance(3000)

    expect(await old).toEqual({ text: Names.SESSION_CHANGED_TEXT })
    expect(await middle).toEqual({ text: Names.SESSION_CHANGED_TEXT })
    expect(await current).toEqual({ text: Names.PANEL_SHOWN_TEXT })
    expect(world.opened, 'the ended middle session never places a pane').toHaveLength(2)
    expect(world.closed).toHaveLength(1)
    expect(world.pane.visible).toBe(true)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  for (const command of ['clear', 'resume'] as const) {
    for (const path of ['manual', 'auto'] as const) {
      test(`/${command} during ${path} pane session identification preserves current pane state and data`, async ($, on) => {
        const world = lifecycleWorld(on)
        await $.session.start(Fixtures.SESSION)
        await $.ui.render(Fixtures.HINT)
        await world.clock.settle()
        world.state.delaySessionId = 1000
        const opening = path === 'manual'
          ? $.command.run(Fixtures.DIFF)
          : $.tool.call({
              tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
            })
        await world.clock.settle()
        expect(world.pane.visible, 'the pane has been placed').toBe(true)
        expect(world.reads).toHaveLength(1)

        Object.assign(world.script, MOVED)
        await $.command.run(command === 'clear' ? Fixtures.CLEAR : Fixtures.RESUME)
        world.state.delaySessionId = 0
        await world.clock.advance(3000)
        const reply = await opening
        if (path === 'manual') {
          expect(reply).toEqual({
            text: command === 'clear' ? Names.PANEL_SHOWN_TEXT : Names.SESSION_CHANGED_TEXT,
          })
        }
        expect(world.pane.visible).toBe(command === 'clear')
        if (command === 'clear') {
          const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
          expect(text).toContain('other.ts')
          expect(text).not.toContain('app.ts')
        } else {
          expect(await $.command.run(Fixtures.DIFF)).toEqual({ text: Names.PANEL_SHOWN_TEXT })
          await world.clock.advance(Fixtures.SETTLE_MS)
          const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
          expect(text).toContain('other.ts')
          expect(text).not.toContain('app.ts')
        }
      })
    }
  }

  for (const command of ['clear', 'resume'] as const) {
    for (const path of ['manual', 'auto'] as const) {
      test(`the new ${path} pane survives an old placement and its cleanup after /${command}`, async ($, on) => {
        const world = lifecycleWorld(on)
        await $.session.start(Fixtures.SESSION)
        await $.ui.render(Fixtures.HINT)
        await world.clock.settle()
        world.state.delayOpen = 1000
        const old = $.command.run(Fixtures.DIFF)
        await world.clock.settle()
        expect(world.opened).toHaveLength(1)
        expect(world.pane.visible).toBe(false)

        Object.assign(world.script, MOVED)
        await $.command.run(command === 'clear' ? Fixtures.CLEAR : Fixtures.RESUME)
        world.state.delayOpen = 0
        world.state.delayClose = 1000
        const current = path === 'manual'
          ? $.command.run(Fixtures.DIFF)
          : $.tool.call({
              tool: 'Edit', file_path: '/work/other.ts', old_string: '1', new_string: '2',
            })
        await world.clock.advance(4000)
        const oldReply = await old
        const currentReply = await current
        expect(world.pane.visible, 'old cleanup cannot remove the new pane').toBe(true)
        const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
        expect(text).toContain('other.ts')
        expect(text).not.toContain('app.ts')
        expect(oldReply).toEqual({ text: Names.SESSION_CHANGED_TEXT })
        expect(world.closed.map(pane => pane.id), 'the old placement was removed').toEqual(['diff'])
        if (path === 'manual') {
          expect(currentReply).toEqual({ text: Names.PANEL_SHOWN_TEXT })
        }

        world.state.delayClose = 0
        expect(await $.command.run(Fixtures.DIFF)).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
        expect(world.pane.visible).toBe(false)
      })
    }
  }

  for (const command of ['clear', 'resume'] as const) {
    for (const path of ['manual', 'auto'] as const) {
      test(`/${command} during ${path} pane placement removes the ended session pane`, async ($, on) => {
        const world = lifecycleWorld(on)
        await $.session.start(Fixtures.SESSION)
        await $.ui.render(Fixtures.HINT)
        await world.clock.settle()
        world.state.delayOpen = 1000

        const opening = path === 'manual'
          ? $.command.run(Fixtures.DIFF)
          : $.tool.call({
              tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
            })
        await world.clock.settle()
        expect(world.opened, 'placement was requested').toHaveLength(1)
        expect(world.pane.visible, 'placement has not completed').toBe(false)
        expect(world.reads).toHaveLength(1)

        Object.assign(world.script, MOVED)
        await $.command.run(command === 'clear' ? Fixtures.CLEAR : Fixtures.RESUME)
        world.state.delayOpen = 0
        await world.clock.advance(3000)
        const reply = await opening

        expect(world.pane.visible, 'the ended session cannot leave a pane behind').toBe(false)
        expect(world.closed.map(pane => pane.id)).toEqual(['diff'])
        expect(world.reads, 'discarding the old placement does not read again').toHaveLength(1)
        if (path === 'manual') {
          expect(reply).toEqual({ text: Names.SESSION_CHANGED_TEXT })
        }

        expect(await $.command.run(Fixtures.DIFF)).toEqual({ text: Names.PANEL_SHOWN_TEXT })
        await world.clock.advance(Fixtures.SETTLE_MS)
        expect(world.pane.visible).toBe(true)
        const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
        expect(text).toContain('other.ts')
        expect(text).not.toContain('app.ts')
      })
    }
  }

  for (const command of ['clear', 'resume'] as const) {
    test(`/${command} during the first manual /diff read asks for another /diff and leaves no pane`, async ($, on) => {
      const world = lifecycleWorld(on)
      world.state.delayRead = 1000
      await $.session.start(Fixtures.SESSION)
      const opening = $.command.run(Fixtures.DIFF)
      await world.clock.settle()
      expect(world.reads, 'the first read is in flight').toHaveLength(1)
      expect(world.opened).toEqual([])

      world.state.delayRead = 0
      await $.command.run(command === 'clear' ? Fixtures.CLEAR : Fixtures.RESUME)
      await world.clock.advance(3000)
      expect(await opening).toEqual({
        text: 'The session changed. Run /diff again to show the diff panel.',
      })
      expect(world.opened, 'the interrupted command never opens a pane').toEqual([])
      expect(world.reads, 'the interrupted command does not restart').toHaveLength(1)

      expect(await $.command.run(Fixtures.DIFF)).toEqual({ text: Names.PANEL_SHOWN_TEXT })
      await world.clock.advance(Fixtures.SETTLE_MS)
      expect(world.opened.map(pane => pane.id)).toEqual(['diff'])
      const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
      expect(text).toContain('app.ts')
      expect(text).not.toContain('Loading diff')
    })
  }

  test('an ended auto-open cannot release the new session auto-open while its UI is pending', async ($, on) => {
    const world = lifecycleWorld(on)
    world.state.transcript = Fixtures.EDITED_TRANSCRIPT
    world.state.delayRead = 1000
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    await world.clock.settle()
    expect(world.reads, 'the old auto-open is awaiting its read').toHaveLength(1)
    expect(world.opened).toEqual([])

    world.state.transcript = []
    world.state.delayRead = 0
    world.state.delayOpen = 4000
    await $.command.run(Fixtures.CLEAR)
    const edit = {
      tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
    } as const
    await $.tool.call(edit)
    await world.clock.settle()
    expect(world.opened.map(pane => pane.id), 'the new auto-open is awaiting its UI').toEqual(['diff'])

    await world.clock.advance(3000)
    await $.tool.call(edit)
    await world.clock.settle()
    expect(world.opened.map(pane => pane.id), 'the old completion cannot permit another open').toEqual(['diff'])
    await world.clock.advance(3000)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('app.ts')
  })

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
    const messagesBefore = world.counts.messages
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await $.command.run(Fixtures.RESUME)
    await world.clock.advance(3000)
    expect(world.closed.map(pane => pane.id)).toEqual(['diff'])
    expect(world.opened.map(pane => pane.id)).toEqual(['diff'])
    expect(world.reads.slice(before), 'the closed pane has no old refresh left').toEqual([])
    expect(world.counts.messages - messagesBefore, 'only the restored-history read runs').toBe(1)
  })

  for (const command of ['clear', 'resume'] as const) {
    for (const stage of ['preference', 'settings', 'read'] as const) {
      test(`/${command} during auto-open ${stage} cancels the old open and permits a new edit`, async ($, on) => {
        const world = lifecycleWorld(on)
        world.state.transcript = Fixtures.EDITED_TRANSCRIPT
        if (stage === 'preference') world.state.delayPreference = 1000
        if (stage === 'settings') world.state.delaySettings = 1000
        if (stage === 'read') world.state.delayRead = 1000
        await $.session.start(Fixtures.SESSION)
        await $.ui.render(Fixtures.HINT)
        await world.clock.settle()
        expect(world.opened, 'the opening has not reached the UI').toEqual([])
        expect(
          stage === 'preference' ? world.counts.preferences :
            stage === 'settings' ? world.counts.settings : world.reads.length,
          'the selected await is in flight',
        ).toBeGreaterThan(0)

        world.state.transcript = []
        world.state.delayPreference = 0
        world.state.delaySettings = 0
        world.state.delayRead = 0
        await $.command.run(command === 'clear' ? Fixtures.CLEAR : Fixtures.RESUME)
        await world.clock.advance(3000)
        expect(world.opened, 'the ended session cannot open its pane').toEqual([])

        await $.tool.call({
          tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
        })
        await world.clock.advance(Fixtures.SETTLE_MS)
        expect(world.opened.map(pane => pane.id), 'the new session can still auto-open').toEqual(['diff'])
        const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
        expect(text).toContain('app.ts')
        expect(text).not.toContain('Loading diff')
        expect(text).not.toContain(Names.NOT_IN_REPOSITORY_TEXT)
      })
    }
  }

  for (const failure of ['read', 'body'] as const) {
    test(`/clear preserves a ${failure} failure mark from the ended session`, { plugins: [RECORDING] }, async ($, on) => {
      const world = lifecycleWorld(on)
      await $.session.start(Fixtures.SESSION)
      await $.command.run(Fixtures.DIFF)
      await world.clock.advance(Fixtures.SETTLE_MS)
      expect(world.marks, 'telemetry capture sees successful reads').toEqual(['ok'])
      world.marks.length = 0
      const bodiesBefore = world.counts.bodies
      world.state.failRead = failure === 'read'
      world.state.delayRead = failure === 'read' ? 1000 : 0
      world.state.failBody = failure === 'body'
      world.state.delayBody = failure === 'body' ? 1000 : 0
      await $.tool.call({ tool: 'Bash', command: 'make' })
      await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
      if (failure === 'body') expect(world.counts.bodies).toBe(bodiesBefore + 1)
      expect(world.marks, 'failure has not settled yet').toEqual([])
      world.state.failRead = false
      world.state.delayRead = 0
      world.state.failBody = false
      world.state.delayBody = 0
      await $.command.run(Fixtures.CLEAR)
      await world.clock.advance(4000)
      expect(world.marks).toEqual([
        failure === 'read' ? 'sad:git_diff_failed' : 'sad:git_hunks_failed',
        'ok',
      ])
      expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('app.ts')
    })
  }

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
