import type { On, SessionMessage } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'
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

const UNKNOWN_STATE_REPLY = {
  text: "The diff panel couldn't tell whether it is shown; run /diff again to check",
}

const RECORDING: Plugin = {
  name: 'recording',
  tier: 'builtin',
  register(on) {
    on('telemetry.mark', async ($, e) => {
      await $.ui.log(`mark ${JSON.stringify(e)}`)
      return { value: undefined }
    })
    on('telemetry.log', async ($, e) => {
      await $.ui.log(`record ${JSON.stringify(e)}`)
      return { value: undefined }
    })
    on('engine.create', async ($, e, next) => {
      const beneath = await next(e)
      const added = {
        telemetry: { log: async () => undefined, mark: async () => undefined },
      }
      return { ...added, ...beneath }
    })
  },
}

const TIMER_OBSERVER: Plugin = {
  name: 'timer-observer',
  tier: 'user',
  register(on) {
    let targetMs: number | null = null
    let held = 0
    let release = () => {}
    on('command.run', { command: 'timer-control' }, (_$, e) => {
      if (e.args === 'release') release()
      else if (e.args.startsWith('arm ')) targetMs = Number(e.args.slice(4))
      return { text: String(held) }
    })
    on('clock.after', async (_$, e, next) => {
      const result = await next(e)
      if (e.ms === targetMs) {
        targetMs = null
        held += 1
        await new Promise<void>(resolve => { release = resolve })
      }
      return result
    })
  },
}

function lifecycleWorld(on: On, drive: Engine, stored: Record<string, unknown> = {}) {
  const script: Record<string, string> = { ...Fixtures.REPOSITORY }
  const state = {
    delayRead: 0,
    delayMessages: 0,
    delayPreference: 0,
    delaySettings: 0,
    delayBody: 0,
    delayOpen: 0,
    delayPanes: 0,
    delayClose: 0,
    delaySessionId: 0,
    delayUsage: 0,
    heldProbe: null as Promise<void> | null,
    heldHead: null as Promise<void> | null,
    heldHeads: null as Promise<void> | null,
    heldRead: null as Promise<void> | null,
    heldBody: null as Promise<void> | null,
    heldBodies: null as Promise<void> | null,
    heldOpen: null as Promise<void> | null,
    heldClose: null as Promise<void> | null,
    heldCommandBefore: null as Promise<void> | null,
    heldCommandAfter: null as Promise<void> | null,
    heldCommit: null as Promise<void> | null,
    heldSessionId: null as Promise<void> | null,
    heldUsage: null as Promise<void> | null,
    commitsSession: true,
    failSessionId: false,
    failUsage: false,
    startedAt: 0,
    failRead: false,
    failBody: false,
    failOpen: false,
    failOpenAfter: false,
    failOpenWaiting: false,
    failPanes: false,
    refuseOpenAfter: false,
    refusePanes: false,
    denyOpen: false,
    denyClose: false,
    sessionId: 'test-session',
    transcript: [] as readonly SessionMessage[],
  }
  const clock = Fixtures.startsSession(on)
  const opened: { id: string }[] = []
  const closed: { id: string }[] = []
  const placedRows: number[] = []
  const openReplyFailures: ('error' | 'refusal')[] = []
  const pane = { visible: false, waiting: false }
  const reads: string[] = []
  const bodyPaths: string[] = []
  const counts = { messages: 0, preferences: 0, settings: 0, bodies: 0, probes: 0, identities: 0, heads: 0, usages: 0, panes: 0 }
  const marks: string[] = []
  const logs: string[] = []
  const preferences: unknown[] = []
  let committedId = state.sessionId
  let switches = 0

  on('process.run', async (_engine, e) => {
    const line = e.argv.join(' ')
    const value = Fixtures.gitIn(e.argv, script)
    if (line.includes('rev-parse --verify --quiet HEAD')) {
      counts.heads += 1
      const held = state.heldHead ?? state.heldHeads
      state.heldHead = null
      if (held) await held
    }
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
      bodyPaths.push(e.argv[e.argv.length - 1]!)
      const fails = state.failBody
      const held = state.heldBody ?? state.heldBodies
      state.heldBody = null
      if (held) await held
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
    if (e.argv.includes('rev-parse') && e.argv.includes('--path-format=absolute')) {
      counts.probes += 1
      const held = state.heldProbe
      state.heldProbe = null
      if (held) await held
    }
    if (e.argv.includes('--numstat')) {
      reads.push(value.stdout)
      const held = state.heldRead
      state.heldRead = null
      if (held) await held
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
    counts.usages += 1
    const startedAt = state.startedAt
    const held = state.heldUsage
    const fails = state.failUsage
    if (held) await held
    if (state.delayUsage > 0) await clock.sleep(state.delayUsage)
    if (fails) throw new Error('test usage unavailable')
    return { value: Fixtures.usageAt(startedAt) }
  })
  on('session.id', async () => {
    counts.identities += 1
    if (state.failSessionId) throw new Error('test session identity unavailable')
    const id = committedId
    const held = state.heldSessionId
    state.heldSessionId = null
    if (held) await held
    if (state.delaySessionId > 0) await clock.sleep(state.delaySessionId)
    return { value: id }
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('command.run', { command: ['clear', 'resume'] }, async (_$, e) => {
    const before = state.heldCommandBefore
    const after = state.heldCommandAfter
    const committing = state.heldCommit
    const commits = state.commitsSession
    state.heldCommandBefore = null
    state.heldCommandAfter = null
    state.heldCommit = null
    if (before) await before
    if (commits) {
      await drive.session.end({
        reason: e.command === 'clear' ? 'clear' : 'resume',
        sessionId: committedId, resume: { id: committedId },
      })
      if (committing) await committing
      if (state.sessionId === committedId) state.sessionId = `session-${++switches}`
      committedId = state.sessionId
    }
    if (after) await after
    return {}
  })
  on('tool.call', (_$, e) =>
    e.tool === 'Bash' && e.command === 'ls'
      ? Fixtures.READ_ONLY_ANSWER
      : { result: 'done' },
  )
  on('ui.open', async (_engine, e) => {
    opened.push({ id: e.id })
    const fails = state.failOpen
    const denied = state.denyOpen
    const failAfter = state.failOpenAfter
    const failWaiting = state.failOpenWaiting
    const refuseAfter = state.refuseOpenAfter
    const held = state.heldOpen
    state.heldOpen = null
    state.denyOpen = false
    if (held) await held
    if (state.delayOpen > 0) await clock.sleep(state.delayOpen)
    if (denied) return { deny: 'test open denied' }
    if (fails) throw new Error('test placement failed')
    if (failWaiting) {
      pane.waiting = true
      throw new Error('test open response failed while waiting')
    }
    pane.visible = true
    if (typeof e.rows === 'number') placedRows.push(e.rows)
    if (failAfter) {
      openReplyFailures.push('error')
      throw new Error('test open response failed after placement')
    }
    if (refuseAfter) {
      openReplyFailures.push('refusal')
      return { deny: 'test open refused after placement' }
    }
    return { value: undefined }
  })
  on('ui.panes', async () => {
    counts.panes += 1
    const fails = state.failPanes
    const refuses = state.refusePanes
    const listed = pane.visible ? [{
      id: 'diff', title: 'Diff', isShown: true, isFocused: false, isPlaced: true,
    }] : pane.waiting ? [{
      id: 'diff', title: 'Diff', isShown: false, isFocused: false, isPlaced: false,
    }] : []
    if (state.delayPanes > 0) await clock.sleep(state.delayPanes)
    if (fails) throw new Error('test pane state unavailable')
    if (refuses) return { deny: 'test pane lookup refused' }
    return { value: listed }
  })
  on('ui.close', async (_engine, e) => {
    closed.push({ id: e.id })
    const denied = state.denyClose
    state.denyClose = false
    const held = state.heldClose
    state.heldClose = null
    if (held) await held
    if (state.delayClose > 0) await clock.sleep(state.delayClose)
    if (denied) return { deny: 'test close denied' }
    pane.visible = false
    pane.waiting = false
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

  return { clock, opened, closed, placedRows, openReplyFailures, pane, script, state, reads, bodyPaths, counts, marks, logs, preferences }
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

function heldCall() {
  let release = () => {}
  const waiting = new Promise<void>(resolve => { release = resolve })
  return { waiting, release }
}

describe('owner-lifecycle', () => {
  for (const outcome of ['error', 'refusal'] as const) {
    test(`a detail fit with an after-placement ${outcome} still lets the list return to its size`, async ($, on) => {
      const world = lifecycleWorld(on, $)
      world.state.transcript = Fixtures.EDITED_TRANSCRIPT
      await $.session.start(Fixtures.SESSION)
      await $.command.run(Fixtures.DIALOG_DIFF)
      await world.clock.advance(Fixtures.SETTLE_MS)
      const ui = await $.ui.mount({ ...Fixtures.INLINE_PANE, plugin: 'diff', surface: 'terminal' })
      const listRows = world.placedRows[world.placedRows.length - 1]
      if (listRows === undefined) throw new Error('the initial list has no placed row count')
      world.state.failOpenAfter = outcome === 'error'
      world.state.refuseOpenAfter = outcome === 'refusal'
      try {
        await ui.press({ key: 'file:app.ts' })
        await world.clock.advance(Fixtures.SETTLE_MS)
        expect(world.openReplyFailures).toEqual([outcome])
        expect(world.placedRows[world.placedRows.length - 1]).toBeGreaterThan(listRows)
        world.state.failOpenAfter = false
        world.state.refuseOpenAfter = false
        await ui.select({ key: 'source', value: 'current' })
        await world.clock.advance(Fixtures.SETTLE_MS)
      } finally {
        world.state.failOpenAfter = false
        world.state.refuseOpenAfter = false
        await ui.unmount()
      }
      expect({ visible: world.pane.visible, rows: world.placedRows[world.placedRows.length - 1] })
        .toEqual({ visible: true, rows: listRows })
    })
  }

  test('a denied hide after a held detail fit still lets the list return to its size', async ($, on) => {
    const world = lifecycleWorld(on, $)
    world.state.transcript = Fixtures.EDITED_TRANSCRIPT
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIALOG_DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const ui = await $.ui.mount({ ...Fixtures.INLINE_PANE, plugin: 'diff', surface: 'terminal' })
    const listRows = world.placedRows[world.placedRows.length - 1]
    const fitting = heldCall()
    world.state.heldOpen = fitting.waiting
    let denied = false
    let hiding: Promise<unknown> | null = null
    try {
      await ui.press({ key: 'file:app.ts' })
      await world.clock.settle()
      world.state.denyClose = true
      hiding = $.command.run(Fixtures.DIALOG_DIFF).catch(() => { denied = true })
      await world.clock.settle()
      fitting.release()
      await world.clock.advance(Fixtures.SETTLE_MS)
      await hiding
      await ui.select({ key: 'source', value: 'current' })
      await world.clock.advance(Fixtures.SETTLE_MS)
    } finally {
      fitting.release()
      await world.clock.settle()
      await hiding
      await ui.unmount()
    }
    expect({ denied, closes: world.closed.length, visible: world.pane.visible,
      rows: world.placedRows[world.placedRows.length - 1] }).toEqual({
      denied: true, closes: 1, visible: true, rows: listRows,
    })
  })

  test('a detail fit held across clear cannot leave the retained list at the old detail size', async ($, on) => {
    const world = lifecycleWorld(on, $)
    world.state.transcript = Fixtures.EDITED_TRANSCRIPT
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIALOG_DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const ui = await $.ui.mount({ ...Fixtures.INLINE_PANE, plugin: 'diff', surface: 'terminal' })
    const listRows = world.placedRows[world.placedRows.length - 1]
    const fitting = heldCall()
    world.state.heldOpen = fitting.waiting
    try {
      await ui.press({ key: 'file:app.ts' })
      await world.clock.settle()
      await $.command.run(Fixtures.CLEAR)
      await world.clock.advance(Fixtures.SETTLE_MS)
    } finally {
      fitting.release()
      await world.clock.advance(Fixtures.SETTLE_MS)
      await ui.unmount()
    }
    expect({ closes: world.closed.length, visible: world.pane.visible,
      rows: world.placedRows[world.placedRows.length - 1] }).toEqual({
      closes: 0, visible: true, rows: listRows,
    })
  })

  test('returning to the current source while a detail fit is held restores the latest list size', async ($, on) => {
    const world = lifecycleWorld(on, $)
    world.state.transcript = Fixtures.EDITED_TRANSCRIPT
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIALOG_DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const ui = await $.ui.mount({ ...Fixtures.INLINE_PANE, plugin: 'diff', surface: 'terminal' })
    const listRows = world.placedRows[world.placedRows.length - 1]
    expect(typeof listRows).toBe('number')
    const initialOpens = world.opened.length
    const fitting = heldCall()
    world.state.heldOpen = fitting.waiting
    try {
      await ui.press({ key: 'file:app.ts' })
      await world.clock.settle()
      await ui.select({ key: 'source', value: 'current' })
      await world.clock.settle()
    } finally {
      fitting.release()
      await world.clock.advance(Fixtures.SETTLE_MS)
      await ui.unmount()
    }
    expect(world.opened.length).toBeGreaterThan(initialOpens)
    expect(world.placedRows[world.placedRows.length - 1]).toBe(listRows)
    expect(world.pane.visible).toBe(true)
  })

  test('hiding an inline pane waits for its earlier size fit to finish', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIALOG_DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    await $.ui.render(Fixtures.INLINE_PANE)
    expect(world.pane.visible).toBe(true)
    const initialOpens = world.opened.length
    const fitting = heldCall()
    world.state.heldOpen = fitting.waiting
    let reply: unknown = 'pending'
    let hiding: Promise<unknown> | null = null
    let beforeRelease: unknown
    try {
      await $.ui.press({ plugin: 'diff', key: 'file:app.ts' })
      await world.clock.settle()
      hiding = $.command.run(Fixtures.DIALOG_DIFF).then(result => { reply = result })
      await world.clock.settle()
      beforeRelease = { fits: world.opened.length - initialOpens, closes: world.closed.length, reply }
    } finally {
      fitting.release()
      await world.clock.settle()
      await hiding
      await world.clock.advance(Fixtures.SETTLE_MS)
    }
    expect({ beforeRelease, reply, visible: world.pane.visible }).toEqual({
      beforeRelease: { fits: 1, closes: 0, reply: 'pending' },
      reply: { text: Names.DIALOG_DISMISSED_TEXT },
      visible: false,
    })
  })

  test('a size fit requested during a successful hide cannot reopen the inline pane', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIALOG_DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    await $.ui.render(Fixtures.INLINE_PANE)
    expect(world.pane.visible).toBe(true)
    const initialOpens = world.opened.length
    const closing = heldCall()
    const fitting = heldCall()
    world.state.heldClose = closing.waiting
    const hiding = $.command.run(Fixtures.DIALOG_DIFF)
    let beforeRelease: unknown
    try {
      await world.clock.settle()
      world.state.heldOpen = fitting.waiting
      await $.ui.press({ plugin: 'diff', key: 'file:app.ts' })
      await world.clock.settle()
      beforeRelease = { fits: world.opened.length - initialOpens, closes: world.closed.length }
    } finally {
      closing.release()
      await world.clock.settle()
      fitting.release()
      await world.clock.advance(Fixtures.SETTLE_MS)
    }
    expect({ reply: await hiding, beforeRelease, fits: world.opened.length - initialOpens, visible: world.pane.visible }).toEqual({
      reply: { text: Names.DIALOG_DISMISSED_TEXT },
      beforeRelease: { fits: 0, closes: 1 },
      fits: 0,
      visible: false,
    })
  })

  test('review: unknown waiting cleanup stays ordered before a new session successor', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    world.state.failOpenWaiting = true
    world.state.failPanes = true
    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect({ waiting: world.pane.waiting, opens: world.opened.length, lookups: world.counts.panes })
      .toEqual({ waiting: true, opens: 1, lookups: 1 })
    world.state.failOpenWaiting = false
    world.state.failPanes = false
    const closing = heldCall()
    world.state.heldClose = closing.waiting
    const oldCommand = $.command.run(Fixtures.DIFF).catch(
      (error: unknown) => ({ error: String(error) }),
    )
    await world.clock.settle()
    const closeCalls = world.closed.length
    await $.command.run(Fixtures.CLEAR)
    let successorReply: unknown = 'pending'
    const successor = $.command.run(Fixtures.DIFF).then(reply => { successorReply = reply }).catch(
      (error: unknown) => { successorReply = { error: String(error) } },
    )
    await world.clock.settle()
    const beforeRelease = { opens: world.opened.length, reply: successorReply }
    closing.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    const oldReply = await oldCommand
    await successor

    expect({ closeCalls, beforeRelease, oldReply, successorReply, visible: world.pane.visible }).toEqual({
      closeCalls: 1,
      beforeRelease: { opens: 1, reply: 'pending' },
      oldReply: { text: Names.SESSION_CHANGED_TEXT },
      successorReply: { text: Names.PANEL_SHOWN_TEXT },
      visible: true,
    })
  })

  test('review: an older absent lookup cannot settle a later uncertain placed open', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    world.state.failOpen = true
    world.state.failPanes = true
    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    world.state.failOpen = false
    world.state.failPanes = false
    world.state.delayPanes = 2000
    const oldCommand = $.command.run(Fixtures.DIFF).catch(
      (error: unknown) => ({ error: String(error) }),
    )
    await world.clock.settle()
    const oldLookupCount = world.counts.panes
    world.state.delayPanes = 0
    world.state.failOpenAfter = true
    world.state.delayOpen = 1000
    const newer = $.command.run(Fixtures.DIFF).catch(
      (error: unknown) => ({ error: String(error) }),
    )
    await world.clock.settle()
    const whileOpening = { opens: world.opened.length, lookups: world.counts.panes }
    world.state.failPanes = true
    await world.clock.advance(1000)
    const newerReply = await newer
    const afterNewer = { visible: world.pane.visible, opens: world.opened.length, lookups: world.counts.panes }
    world.state.failOpenAfter = false
    world.state.failPanes = false
    world.state.delayOpen = 0
    await world.clock.advance(1000 + Fixtures.SETTLE_MS)
    await oldCommand

    expect(oldLookupCount).toBe(2)
    expect(whileOpening).toEqual({ opens: 2, lookups: 3 })
    expect(newerReply).toEqual(UNKNOWN_STATE_REPLY)
    expect(afterNewer).toEqual({ visible: true, opens: 2, lookups: 4 })
    expect(world.closed).toHaveLength(0)
    expect(world.opened, 'the older absent result cannot authorize another open over the newer placed pane')
      .toHaveLength(2)
    expect(world.pane.visible).toBe(true)
  })

  for (const stateUnavailable of [false, true]) {
    test(`an after-placement open failure avoids duplicate retries when pane state is ${stateUnavailable ? 'unavailable' : 'placed'}`, async ($, on) => {
      const world = lifecycleWorld(on, $)
      await $.session.start(Fixtures.SESSION)
      await $.ui.render(Fixtures.HINT)
      world.state.failOpenAfter = true
      world.state.failPanes = stateUnavailable
      const edit = {
        tool: 'Edit' as const, file_path: '/work/app.ts', old_string: '1', new_string: '2',
      }
      await $.tool.call(edit)
      await world.clock.advance(Fixtures.SETTLE_MS)
      const afterFailure = { visible: world.pane.visible, opens: world.opened.length }
      world.state.failOpenAfter = false
      await $.tool.call(edit)
      await world.clock.advance(Fixtures.SETTLE_MS)
      const afterEdit = { visible: world.pane.visible, opens: world.opened.length }
      const uncertainReply = stateUnavailable ? await $.command.run(Fixtures.DIFF) : null
      world.state.failPanes = false
      const reply = await $.command.run(Fixtures.DIFF)
      expect(afterFailure).toEqual({ visible: true, opens: 1 })
      expect(afterEdit).toEqual({ visible: true, opens: 1 })
      if (stateUnavailable) {
        expect(uncertainReply).not.toEqual({ text: Names.PANEL_SHOWN_TEXT })
        expect(uncertainReply).not.toEqual({ text: Names.PANEL_HIDDEN_TEXT })
      }
      expect(reply).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
      expect(world.pane.visible).toBe(false)
    })
  }

  test('a failed auto-open looks the pane up and permits a later edit to retry', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    world.state.failOpen = true
    const edit = {
      tool: 'Edit' as const, file_path: '/work/app.ts', old_string: '1', new_string: '2',
    }
    await $.tool.call(edit)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const afterFailure = {
      visible: world.pane.visible, opens: world.opened.length, lookups: world.counts.panes,
    }
    world.state.failOpen = false
    await $.tool.call(edit)
    await world.clock.advance(Fixtures.SETTLE_MS)

    expect(afterFailure, 'the engine lists no pane').toEqual({ visible: false, opens: 1, lookups: 1 })
    expect(world.opened).toHaveLength(2)
    expect(world.pane.visible).toBe(true)
  })

  test('an open failure that left the pane waiting closes it and permits a later edit to retry', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    world.state.failOpenWaiting = true
    const edit = {
      tool: 'Edit' as const, file_path: '/work/app.ts', old_string: '1', new_string: '2',
    }
    await $.tool.call(edit)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const afterFailure = {
      waiting: world.pane.waiting, opens: world.opened.length, lookups: world.counts.panes,
      closed: world.closed.map(pane => pane.id),
    }
    world.state.failOpenWaiting = false
    await $.tool.call(edit)
    await world.clock.advance(Fixtures.SETTLE_MS)

    expect(afterFailure).toEqual({ waiting: false, opens: 1, lookups: 1, closed: ['diff'] })
    expect(world.opened).toHaveLength(2)
    expect(world.pane.visible).toBe(true)
  })

  for (const fault of ['thrown', 'refused'] as const) {
    test(`an unconfirmed auto-open answers /diff with the unknown state and logs both ${fault} failures`, async ($, on) => {
      const world = lifecycleWorld(on, $)
      await $.session.start(Fixtures.SESSION)
      await $.ui.render(Fixtures.HINT)
      world.state.failOpenAfter = fault === 'thrown'
      world.state.failPanes = fault === 'thrown'
      world.state.refuseOpenAfter = fault === 'refused'
      world.state.refusePanes = fault === 'refused'
      await $.tool.call({
        tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
      })
      await world.clock.advance(Fixtures.SETTLE_MS)
      const lookups = world.counts.panes
      const reply = await $.command.run(Fixtures.DIFF)

      expect(lookups, 'the rejected open was looked up').toBe(1)
      expect(world.counts.panes, '/diff looked the pane up again').toBe(2)
      expect(reply).toEqual(UNKNOWN_STATE_REPLY)
      const diagnostic = world.logs.find(line => line.includes('Could not tell whether the diff panel opened'))
      expect(diagnostic, 'a debug line explains the unknown state').toBeDefined()
      expect(diagnostic).toContain('ui.open')
      expect(diagnostic).toContain('ui.panes')
      if (fault === 'refused') {
        expect(diagnostic).toContain('test open refused after placement')
        expect(diagnostic).toContain('test pane lookup refused')
      }
      expect(world.opened).toHaveLength(1)
      expect(world.pane.visible, 'the pane stays as the engine left it').toBe(true)
    })
  }

  for (const stateUnavailable of [false, true]) {
    test(`/diff whose open fails after placement answers ${stateUnavailable ? 'the unknown state' : 'shown'} without opening again`, async ($, on) => {
      const world = lifecycleWorld(on, $)
      await $.session.start(Fixtures.SESSION)
      world.state.failOpenAfter = true
      world.state.failPanes = stateUnavailable
      const reply = await $.command.run(Fixtures.DIFF).catch(
        (error: unknown) => ({ error: String(error) }),
      )
      world.state.failOpenAfter = false
      world.state.failPanes = false
      const hidden = await $.command.run(Fixtures.DIFF)

      expect(reply).toEqual(stateUnavailable ? UNKNOWN_STATE_REPLY : { text: Names.PANEL_SHOWN_TEXT })
      expect(world.logs.join('\n')).toContain(stateUnavailable
        ? 'Could not tell whether the diff panel opened'
        : 'The diff panel opened, but opening it reported')
      expect(hidden).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
      expect(world.opened).toHaveLength(1)
      expect(world.pane.visible).toBe(false)
    })
  }

  test('a /diff queued behind an unconfirmed auto-open does not open again', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    world.state.delayOpen = 1000
    world.state.failOpenAfter = true
    world.state.failPanes = true
    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
    })
    await world.clock.settle()
    expect(world.opened, 'the auto-open is placing').toHaveLength(1)
    const queued = $.command.run(Fixtures.DIFF).catch(
      (error: unknown) => ({ error: String(error) }),
    )
    await world.clock.advance(1000 + Fixtures.SETTLE_MS)

    expect(await queued).toEqual(UNKNOWN_STATE_REPLY)
    expect(world.opened, 'the queued /diff did not open blindly').toHaveLength(1)
    expect(world.pane.visible).toBe(true)
  })

  for (const found of ['placed', 'waiting', 'absent'] as const) {
    test(`/diff settles an unconfirmed pane the engine then lists as ${found}`, async ($, on) => {
      const world = lifecycleWorld(on, $)
      await $.session.start(Fixtures.SESSION)
      await $.ui.render(Fixtures.HINT)
      world.state.failOpenAfter = found === 'placed'
      world.state.failOpenWaiting = found === 'waiting'
      world.state.failOpen = found === 'absent'
      world.state.failPanes = true
      const edit = {
        tool: 'Edit' as const, file_path: '/work/app.ts', old_string: '1', new_string: '2',
      }
      await $.tool.call(edit)
      await world.clock.advance(Fixtures.SETTLE_MS)
      world.state.failOpenAfter = false
      world.state.failOpenWaiting = false
      world.state.failOpen = false
      await $.tool.call(edit)
      await world.clock.advance(Fixtures.SETTLE_MS)
      const whileUnknown = { opens: world.opened.length, lookups: world.counts.panes }
      world.state.failPanes = false
      const reply = await $.command.run(Fixtures.DIFF)

      expect(whileUnknown, 'no edit reopens an unconfirmed pane').toEqual({ opens: 1, lookups: 1 })
      expect(world.counts.panes).toBe(2)
      expect(reply).toEqual({
        text: found === 'placed' ? Names.PANEL_HIDDEN_TEXT : Names.PANEL_SHOWN_TEXT,
      })
      expect(world.opened).toHaveLength(found === 'placed' ? 1 : 2)
      expect(world.closed.map(pane => pane.id), 'no waiting pane is left undrawn').toEqual(
        found === 'absent' ? [] : ['diff'],
      )
      expect(world.pane.visible).toBe(found !== 'placed')
    })
  }

  test('an unconfirmed pane stays unconfirmed across /clear, so a new edit does not reopen it', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    world.state.failOpenAfter = true
    world.state.failPanes = true
    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    world.state.failOpenAfter = false
    Object.assign(world.script, MOVED)
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(Fixtures.SETTLE_MS)
    await $.tool.call({
      tool: 'Edit', file_path: '/work/other.ts', old_string: '1', new_string: '2',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    const afterEdit = { visible: world.pane.visible, opens: world.opened.length }
    world.state.failPanes = false
    const reply = await $.command.run(Fixtures.DIFF)

    expect(afterEdit).toEqual({ visible: true, opens: 1 })
    expect(reply).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
    expect(world.pane.visible).toBe(false)
  })

  test('/resume removes a pane whose placement was never confirmed', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    world.state.failOpenAfter = true
    world.state.failPanes = true
    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    world.state.failOpenAfter = false
    world.state.failPanes = false
    await $.command.run(Fixtures.RESUME)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const afterResume = { visible: world.pane.visible, closed: world.closed.map(pane => pane.id) }
    const reply = await $.command.run(Fixtures.DIFF)

    expect(afterResume, 'the ended session cannot leave a pane behind').toEqual({
      visible: false, closed: ['diff'],
    })
    expect(reply).toEqual({ text: Names.PANEL_SHOWN_TEXT })
    expect(world.pane.visible).toBe(true)
  })

  test('a lookup answered after /resume removed the pane cannot mark it open', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    world.state.failOpenAfter = true
    world.state.failPanes = true
    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    world.state.failOpenAfter = false
    world.state.failPanes = false
    world.state.delayPanes = 1000
    const stale = $.command.run(Fixtures.DIFF).catch(
      (error: unknown) => ({ error: String(error) }),
    )
    await world.clock.settle()
    const lookups = world.counts.panes
    await $.command.run(Fixtures.RESUME)
    await world.clock.advance(1000 + Fixtures.SETTLE_MS)
    const staleReply = await stale
    const afterResume = { visible: world.pane.visible, closed: world.closed.map(pane => pane.id) }
    world.state.delayPanes = 0
    const reply = await $.command.run(Fixtures.DIFF)

    expect(lookups, '/diff is looking the pane up').toBe(2)
    expect(staleReply).toEqual({ text: Names.SESSION_CHANGED_TEXT })
    expect(afterResume).toEqual({ visible: false, closed: ['diff'] })
    expect(reply, 'the stale answer left the removed pane closed').toEqual({ text: Names.PANEL_SHOWN_TEXT })
    expect(world.pane.visible).toBe(true)
  })

  test('a lookup begun before the pane was hidden cannot settle a later unconfirmed open', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    world.state.failOpenAfter = true
    world.state.failPanes = true
    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    world.state.failOpenAfter = false
    world.state.failPanes = false
    world.state.delayPanes = 1000
    const stale = $.command.run(Fixtures.DIFF).catch(
      (error: unknown) => ({ error: String(error) }),
    )
    await world.clock.settle()
    const lookups = world.counts.panes
    world.state.delayPanes = 0
    const hidden = await $.command.run(Fixtures.DIFF)
    world.state.failOpen = true
    world.state.failPanes = true
    const reopened = await $.command.run(Fixtures.DIFF).catch(
      (error: unknown) => ({ error: String(error) }),
    )
    await world.clock.advance(1000 + Fixtures.SETTLE_MS)
    const staleReply = await stale

    expect(lookups, '/diff is looking the pane up').toBe(2)
    expect(hidden).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
    expect(reopened).toEqual(UNKNOWN_STATE_REPLY)
    expect(staleReply, 'the placed answer predates the hide').toEqual(UNKNOWN_STATE_REPLY)
    expect(world.opened).toHaveLength(2)
    expect(world.closed.map(pane => pane.id), 'no close follows the unconfirmed open').toEqual(['diff'])
    expect(world.pane.visible).toBe(false)
  })

  test('a refused removal of an ended placement leaves the new session unconfirmed', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    await world.clock.settle()
    world.state.failOpenAfter = true
    world.state.delayOpen = 1000
    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
    })
    await world.clock.settle()
    Object.assign(world.script, MOVED)
    await $.command.run(Fixtures.CLEAR)
    world.state.delayOpen = 0
    world.state.failOpenAfter = false
    world.state.denyClose = true
    await world.clock.advance(3000)
    await $.tool.call({
      tool: 'Edit', file_path: '/work/other.ts', old_string: '1', new_string: '2',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    const afterEdit = { visible: world.pane.visible, opens: world.opened.length }
    const reply = await $.command.run(Fixtures.DIFF)

    expect(world.logs.join('\n')).toContain('test close denied')
    expect(afterEdit, 'the new session does not open over an unconfirmed pane').toEqual({
      visible: true, opens: 1,
    })
    expect(reply).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
    expect(world.pane.visible).toBe(false)
  })

  for (const command of ['clear', 'resume'] as const) {
    for (const stage of ['open', 'lookup'] as const) {
      test(`/${command} during an after-placement open failure's ${stage} removes the ended session pane`, async ($, on) => {
        const world = lifecycleWorld(on, $)
        await $.session.start(Fixtures.SESSION)
        await $.ui.render(Fixtures.HINT)
        await world.clock.settle()
        world.state.failOpenAfter = true
        if (stage === 'open') world.state.delayOpen = 1000
        else world.state.delayPanes = 1000
        await $.tool.call({
          tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
        })
        await world.clock.settle()
        const beforeSwitch = { opens: world.opened.length, lookups: world.counts.panes }

        Object.assign(world.script, MOVED)
        await $.command.run(command === 'clear' ? Fixtures.CLEAR : Fixtures.RESUME)
        world.state.delayOpen = 0
        world.state.failOpenAfter = false
        await world.clock.advance(3000)
        const afterSwitch = {
          visible: world.pane.visible, closed: world.closed.map(pane => pane.id),
          lookups: world.counts.panes,
        }
        await $.tool.call({
          tool: 'Edit', file_path: '/work/other.ts', old_string: '1', new_string: '2',
        })
        await world.clock.advance(Fixtures.SETTLE_MS)

        expect(beforeSwitch).toEqual({ opens: 1, lookups: stage === 'open' ? 0 : 1 })
        expect(afterSwitch, 'the ended session cannot leave a pane behind').toEqual({
          visible: false, closed: ['diff'], lookups: stage === 'open' ? 0 : 1,
        })
        expect(world.opened, 'the new session opens its own pane').toHaveLength(2)
        expect(world.pane.visible).toBe(true)
        const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
        expect(text).toContain('other.ts')
        expect(text).not.toContain('app.ts')
      })
    }
  }

  test('body capacity retains old filter work and recovers only the newest session', async ($, on) => {
    const world = lifecycleWorld(on, $)
    const paths = ['app.ts', ...Array.from({ length: Limits.BODY_FETCH_CONCURRENCY }, (_, at) => `body${at}.test.ts`)]
    Object.assign(world.script, Fixtures.answersOf(
      paths.map(path => `1\t1\t${path}\0`).join(''),
      Object.fromEntries(paths.map(path => [path, '@@ -1 +1 @@\n-old\n+old_body\n'])),
    ))
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    await $.ui.render(Fixtures.PANE)
    const before = world.counts.bodies
    const first = heldCall()
    const second = heldCall()
    world.state.heldBodies = first.waiting
    await $.ui.press({ plugin: 'diff', key: 'noise' })
    await world.clock.settle()
    world.state.heldBodies = second.waiting
    await $.command.run(Fixtures.CLEAR)
    await world.clock.settle()
    world.script['-- app.ts'] = '@@ -1 +1 @@\n-old\n+recovered_body\n'
    for (let i = 0; i < 4; i += 1) {
      await $.command.run(Fixtures.CLEAR)
      await world.clock.settle()
    }
    const saturated = { bodies: world.counts.bodies - before, logs: [...world.logs] }
    world.state.heldBodies = null
    first.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    const recovered = {
      bodies: world.counts.bodies,
      text: Fixtures.textOf(await $.ui.render(Fixtures.PANE)),
    }
    second.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(saturated.bodies).toBe(2 * Limits.BODY_FETCH_CONCURRENCY)
    expect(saturated.logs.join('\n')).toContain('waiting for earlier work')
    expect(recovered.text).toContain('+recovered_body')
    expect(recovered.bodies).toBe(before + 2 * Limits.BODY_FETCH_CONCURRENCY + paths.length)
    expect(world.counts.bodies).toBe(recovered.bodies)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('+recovered_body')
  })

  test('filter toggles share pending body loads and do not multiply physical reads', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    Object.assign(world.script, Fixtures.MANY_FILES, {
      'HEAD --shortstat': ` ${Fixtures.MANY_FILE_COUNT + 1} files changed`,
      'HEAD --numstat': Fixtures.MANY_FILES['HEAD --numstat'] + '1\t1\textra.test.ts\0',
      '-- extra.test.ts': '@@ -1 +1 @@\n-old\n+test\n',
    })
    const held = heldCall()
    world.state.heldBodies = held.waiting
    const before = world.counts.bodies
    const pathStart = world.bodyPaths.length
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
    await $.ui.render(Fixtures.PANE)
    for (let i = 0; i < 4; i += 1) {
      await $.ui.render(Fixtures.PANE)
      await $.ui.press({ plugin: 'diff', key: 'noise' })
      await world.clock.settle()
    }
    const whileHeld = world.counts.bodies - before
    world.state.heldBodies = null
    held.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    const paths = world.bodyPaths.slice(pathStart)
    expect({ whileHeld, paths: paths.length, unique: new Set(paths).size }).toEqual({
      whileHeld: Limits.BODY_FETCH_CONCURRENCY,
      paths: Fixtures.MANY_FILE_COUNT + 1,
      unique: Fixtures.MANY_FILE_COUNT + 1,
    })
    expect(world.pane.visible).toBe(true)
  })

  test('a cancelled refresh wait cannot consume its replacement debounce', { plugins: [TIMER_OBSERVER] }, async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    await $.command.run({ ...Fixtures.DIFF, command: 'timer-control', args: `arm ${Limits.REFRESH_DEBOUNCE_MS}` })
    await $.tool.call({ tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2' })
    await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
    const beforeReplacement = world.reads.length
    await $.tool.call({ tool: 'Edit', file_path: '/work/app.ts', old_string: '2', new_string: '3' })
    const released = await $.command.run({ ...Fixtures.DIFF, command: 'timer-control', args: 'release' })
    await world.clock.settle()
    const afterOldRelease = world.reads.length
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(released).toEqual({ text: '1' })
    expect(afterOldRelease).toBe(beforeReplacement)
    expect(world.reads.length).toBe(beforeReplacement + 1)
  })

  test('a head read waiting for capacity stays undispatched after manual hide', async ($, on) => {
    const world = lifecycleWorld(on, $)
    on('fs.list', () => ({ value: [] }))
    world.script['rev-parse --verify --quiet HEAD'] = 'head-a'
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const first = heldCall()
    const second = heldCall()
    world.state.heldHead = first.waiting
    await world.clock.advance(Limits.HEAD_POLL_MS)
    world.state.heldHead = second.waiting
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(Fixtures.SETTLE_MS + Limits.HEAD_POLL_MS)
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(Fixtures.SETTLE_MS + Limits.HEAD_POLL_MS)
    const beforeHide = world.counts.heads
    const hidden = await $.command.run(Fixtures.DIFF)
    first.release()
    await world.clock.settle()
    const whileHidden = world.counts.heads
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Limits.HEAD_POLL_MS)
    const afterReopen = world.counts.heads
    second.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(beforeHide).toBe(3)
    expect(hidden).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
    expect(whileHidden).toBe(3)
    expect(afterReopen).toBe(5)
    expect(world.pane.visible).toBe(true)
  })

  test('held head reads keep capacity across sessions and the latest poll recovers', async ($, on) => {
    const world = lifecycleWorld(on, $)
    on('fs.list', () => ({ value: [] }))
    world.script['rev-parse --verify --quiet HEAD'] = 'head-a'
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const first = heldCall()
    const second = heldCall()
    world.state.heldHead = first.waiting
    await world.clock.advance(Limits.HEAD_POLL_MS)
    world.state.heldHead = second.waiting
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(Fixtures.SETTLE_MS + Limits.HEAD_POLL_MS)
    for (let i = 0; i < 4; i += 1) {
      await $.command.run(Fixtures.CLEAR)
      await world.clock.advance(Fixtures.SETTLE_MS + Limits.HEAD_POLL_MS)
    }
    const saturated = { heads: world.counts.heads, logs: [...world.logs] }
    world.script['rev-parse --verify --quiet HEAD'] = 'head-c'
    first.release()
    await world.clock.settle()
    const recovered = world.counts.heads
    const beforeMove = world.reads.length
    world.script['rev-parse --verify --quiet HEAD'] = 'head-d'
    await world.clock.advance(Limits.HEAD_POLL_MS)
    const afterMove = world.reads.length
    second.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(saturated.heads).toBe(3)
    expect(saturated.logs.join('\n')).toContain('waiting for earlier work')
    expect(recovered).toBe(4)
    expect(afterMove).toBe(beforeMove + 1)
    expect(world.reads.length).toBe(afterMove)
    expect(world.pane.visible).toBe(true)
  })

  test('a held head poll is shared by later ticks of the same view', async ($, on) => {
    const world = lifecycleWorld(on, $)
    on('fs.list', () => ({ value: [] }))
    world.script['rev-parse --verify --quiet HEAD'] = 'head-a'
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const held = heldCall()
    world.state.heldHeads = held.waiting
    const before = world.counts.heads
    await world.clock.advance(Limits.HEAD_POLL_MS * 5)
    const whileHeld = world.counts.heads - before
    world.state.heldHeads = null
    held.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(whileHeld).toBe(1)
    expect(world.pane.visible).toBe(true)
  })

  test('an ended session poll cannot replace its successor baseline or request a refresh', async ($, on) => {
    const world = lifecycleWorld(on, $)
    on('fs.list', () => ({ value: [] }))
    world.script['rev-parse --verify --quiet HEAD'] = 'head-a'
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS + Limits.HEAD_POLL_MS)
    const held = heldCall()
    world.script['rev-parse --verify --quiet HEAD'] = 'head-b'
    world.state.heldHead = held.waiting
    await world.clock.advance(Limits.HEAD_POLL_MS)
    world.script['rev-parse --verify --quiet HEAD'] = 'head-c'
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(Fixtures.SETTLE_MS + Limits.HEAD_POLL_MS)
    const beforeRelease = { reads: world.reads.length, heads: world.counts.heads }
    held.release()
    await world.clock.advance(Fixtures.SETTLE_MS + Limits.HEAD_POLL_MS)
    expect(beforeRelease.heads).toBe(5)
    expect(world.reads.length).toBe(beforeRelease.reads)
    expect(world.pane.visible).toBe(true)
  })

  test('a poll finishing after manual hide does not refresh the hidden pane', async ($, on) => {
    const world = lifecycleWorld(on, $)
    on('fs.list', () => ({ value: [] }))
    world.script['rev-parse --verify --quiet HEAD'] = 'head-a'
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS + Limits.HEAD_POLL_MS)
    const held = heldCall()
    world.script['rev-parse --verify --quiet HEAD'] = 'head-b'
    world.state.heldHead = held.waiting
    await world.clock.advance(Limits.HEAD_POLL_MS)
    const hidden = await $.command.run(Fixtures.DIFF)
    const beforeRelease = world.reads.length
    held.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.counts.heads).toBe(3)
    expect(hidden).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
    expect(world.reads.length).toBe(beforeRelease)
    expect(world.pane.visible).toBe(false)
  })

  test('an older successful resume close cannot close a successor pane', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const closing = heldCall()
    world.state.heldClose = closing.waiting
    const resuming = $.command.run(Fixtures.RESUME)
    await world.clock.settle()
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(Fixtures.SETTLE_MS)
    await $.command.run(Fixtures.DIFF)
    let reply: unknown = 'pending'
    const reopening = $.command.run(Fixtures.DIFF).then(result => { reply = result })
    await world.clock.settle()
    const beforeRelease = { reply, logs: [...world.logs] }
    closing.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    await resuming
    await reopening
    expect(beforeRelease.reply).toBe('pending')
    expect(beforeRelease.logs.join('\n')).toContain('waiting for an earlier pane operation')
    expect(reply).toEqual({ text: Names.PANEL_SHOWN_TEXT })
    expect(world.pane.visible).toBe(true)
  })

  test('a retained pane retries session identity after the next successful edit', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    world.state.failSessionId = true
    await $.command.run(Fixtures.CLEAR)
    await world.clock.settle()
    const beforeEdit = world.counts.identities
    world.state.failSessionId = false
    Object.assign(world.script, MOVED)
    await $.tool.call({
      tool: 'Edit', file_path: '/work/other.ts', old_string: '1', new_string: '2',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    const recovered = {
      identities: world.counts.identities,
      pane: Fixtures.textOf(await $.ui.render(Fixtures.PANE)),
    }
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(recovered.identities).toBeGreaterThan(beforeEdit)
    expect(recovered.pane).toContain('other.ts')
  })

  test('a base change while the new session probe waits repins before publishing', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    await $.ui.render(Fixtures.PANE)
    const probe = heldCall()
    world.state.heldProbe = probe.waiting
    await $.command.run(Fixtures.CLEAR)
    await world.clock.settle()
    Object.assign(world.script, MOVED)
    await $.ui.press({ plugin: 'diff', key: 'base' })
    await world.clock.advance(Fixtures.SETTLE_MS)
    const beforeRelease = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    probe.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(beforeRelease).toContain('other.ts')
    expect(beforeRelease).not.toContain(Names.NOT_IN_REPOSITORY_TEXT)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  test('held session confirmations keep capacity and resume only the latest waiting session', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    const first = heldCall()
    const second = heldCall()
    world.state.heldSessionId = first.waiting
    await $.command.run(Fixtures.CLEAR)
    await world.clock.settle()
    world.state.heldSessionId = second.waiting
    await $.command.run(Fixtures.CLEAR)
    await world.clock.settle()
    for (let i = 0; i < 6; i += 1) {
      await $.command.run(Fixtures.CLEAR)
      await world.clock.settle()
    }
    const saturated = { identities: world.counts.identities, reads: world.reads.length, logs: [...world.logs] }
    Object.assign(world.script, MOVED)
    first.release()
    await world.clock.settle()
    const afterRelease = world.counts.identities
    const opening = $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const beforeSecondRelease = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    second.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    await opening
    expect(saturated.identities).toBe(2)
    expect(saturated.reads).toBe(0)
    expect(saturated.logs.join('\n')).toContain('waiting for earlier work')
    expect(afterRelease).toBe(3)
    expect(beforeSecondRelease).toContain('other.ts')
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  test('an unavailable session identity can retry on the next manual request', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    world.state.failSessionId = true
    await $.command.run(Fixtures.CLEAR)
    await world.clock.settle()
    const waiting = { reads: world.reads.length, logs: [...world.logs] }
    world.state.failSessionId = false
    expect(await $.command.run(Fixtures.DIFF)).toEqual({ text: Names.PANEL_SHOWN_TEXT })
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(waiting.reads).toBe(0)
    expect(waiting.logs.join('\n')).toContain('active session to be confirmed')
    expect(world.pane.visible).toBe(true)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('app.ts')
  })

  test('a base revision does not duplicate or abandon a pending session confirmation', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    await $.ui.render(Fixtures.PANE)
    const identities = world.counts.identities
    const identity = heldCall()
    world.state.heldSessionId = identity.waiting
    await $.command.run(Fixtures.CLEAR)
    await world.clock.settle()
    await $.ui.press({ plugin: 'diff', key: 'base' })
    await world.clock.settle()
    const whileHeld = world.counts.identities
    identity.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(whileHeld - identities).toBe(1)
    expect(world.pane.visible).toBe(true)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('app.ts')
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).not.toContain(Names.NOT_IN_REPOSITORY_TEXT)
  })

  for (const delayedIdentity of [false, true]) {
    test(`an older command return cannot confirm an uncommitted session with ${delayedIdentity ? 'delayed' : 'immediate'} identity`, async ($, on) => {
      const world = lifecycleWorld(on, $)
      await $.session.start(Fixtures.SESSION)
      const returned = heldCall()
      world.state.heldCommandAfter = returned.waiting
      const old = $.command.run(Fixtures.RESUME)
      await world.clock.settle()

      const committed = heldCall()
      const identity = heldCall()
      world.state.heldCommit = committed.waiting
      const current = $.command.run(Fixtures.CLEAR)
      await world.clock.settle()
      if (delayedIdentity) world.state.heldSessionId = identity.waiting
      returned.release()
      await old
      await world.clock.settle()
      let reply: unknown = 'pending'
      const opening = $.command.run(Fixtures.DIFF).then(result => { reply = result })
      await world.clock.settle()
      const beforeCommit = { reply, reads: world.reads.length, opens: world.opened.length }

      Object.assign(world.script, MOVED)
      committed.release()
      await current
      identity.release()
      await world.clock.advance(Fixtures.SETTLE_MS)
      await opening
      expect(beforeCommit).toEqual({ reply: 'pending', reads: 0, opens: 0 })
      expect(reply).toEqual({ text: Names.PANEL_SHOWN_TEXT })
      expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
    })
  }

  test('session commit order wins when an earlier command begins its switch later', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    const beginning = heldCall()
    world.state.heldCommandBefore = beginning.waiting
    const earlier = $.command.run(Fixtures.CLEAR)
    await world.clock.settle()
    await $.command.run(Fixtures.RESUME)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    Object.assign(world.script, MOVED)
    beginning.release()
    await earlier
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.pane.visible).toBe(true)
    expect(world.closed).toEqual([])
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  for (const outcome of ['cancelled', 'missing'] as const) {
    test(`a ${outcome} resume without a session end leaves the pane and reads alone`, async ($, on) => {
      const world = lifecycleWorld(on, $)
      await $.session.start(Fixtures.SESSION)
      await $.command.run(Fixtures.DIFF)
      await world.clock.advance(Fixtures.SETTLE_MS)
      world.state.commitsSession = false
      const reads = world.reads.length
      await $.command.run({ ...Fixtures.RESUME, args: outcome === 'missing' ? 'missing-session' : '' })
      await world.clock.advance(Fixtures.SETTLE_MS)
      expect(world.closed).toEqual([])
      expect(world.pane.visible).toBe(true)
      expect(world.reads).toHaveLength(reads)
      expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('app.ts')
    })
  }

  test('a committed resume revokes old reads before its pane close settles', { plugins: [RECORDING] }, async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    world.marks.length = 0
    const read = heldCall()
    const close = heldCall()
    Object.assign(world.script, MOVED)
    world.state.heldRead = read.waiting
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
    world.state.heldClose = close.waiting
    const resuming = $.command.run(Fixtures.RESUME)
    await world.clock.settle()
    const closeStarted = world.closed.length
    read.release()
    await world.clock.settle()
    const beforeClose = [...world.marks]
    const paneBeforeClose = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    close.release()
    await resuming
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(closeStarted).toBe(1)
    expect(paneBeforeClose, 'the ended read cannot replace visible data').not.toContain('other.ts')
    expect(beforeClose, 'the ended read has no successful publication authority').toEqual([])
    expect(world.pane.visible).toBe(false)
  })

  test('a late return from an older committed command cannot reset a newer pane', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    const returned = heldCall()
    world.state.heldCommandAfter = returned.waiting
    const old = $.command.run(Fixtures.RESUME)
    await world.clock.settle()
    await $.command.run(Fixtures.CLEAR)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const reads = world.reads.length
    returned.release()
    await old
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.pane.visible).toBe(true)
    expect(world.closed).toEqual([])
    expect(world.reads).toHaveLength(reads)
  })

  for (const tool of ['Bash', 'PowerShell'] as const) {
    test(`${tool} writes still refresh the pane under portable hook filters`, async ($, on) => {
      const world = lifecycleWorld(on, $)
      await $.session.start(Fixtures.SESSION)
      await $.command.run(Fixtures.DIFF)
      await world.clock.advance(Fixtures.SETTLE_MS)
      Object.assign(world.script, MOVED)
      await $.tool.call({ tool, command: 'make' })
      await world.clock.advance(Fixtures.SETTLE_MS)
      expect(world.reads).toHaveLength(2)
      expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
    })
  }

  test('an unavailable base fetch can reload a body whose old owner was revoked', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    Object.assign(world.script, MOVED, {
      'HEAD --shortstat': ' 2 files changed, 2 insertions(+)',
      'HEAD --numstat': '1\t0\tother.ts\0' + '1\t0\tother.test.ts\0',
      '-- other.test.ts': '@@ -1 +1 @@\n-old\n+test\n',
    })
    const held = heldCall()
    world.state.heldBody = held.waiting
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
    await $.ui.render(Fixtures.PANE)
    world.state.failRead = true
    await $.ui.press({ plugin: 'diff', key: 'base' })
    await world.clock.settle()
    held.release()
    await world.clock.settle()
    await $.ui.render(Fixtures.PANE)
    await $.ui.press({ plugin: 'diff', key: 'noise' })
    await world.clock.advance(Fixtures.SETTLE_MS)

    const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    expect(text).toContain('+const b = 2')
    expect(text).not.toContain('Loading diff')
    expect(world.counts.bodies).toBe(4)
  })

  test('skipping undispatched bodies after clear is not a Git failure', { plugins: [RECORDING] }, async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    world.marks.length = 0
    Object.assign(world.script, Fixtures.MANY_FILES)
    const held = heldCall()
    world.state.heldBodies = held.waiting
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
    const entered = world.counts.bodies
    world.state.heldBodies = null
    Object.assign(world.script, MOVED)
    await $.command.run(Fixtures.CLEAR)
    held.release()
    await world.clock.advance(Fixtures.SETTLE_MS)

    expect(entered).toBe(1 + Limits.BODY_FETCH_CONCURRENCY)
    expect(world.marks).toEqual(['ok'])
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  test('capacity saturation reports waiting and retries the latest base when old work settles', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    await $.ui.render(Fixtures.PANE)

    const first = heldCall()
    const second = heldCall()
    let saturated: { reads: number; logs: string[] } | null = null
    try {
      world.state.heldRead = first.waiting
      await $.tool.call({ tool: 'Bash', command: 'make' })
      await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
      world.state.heldRead = second.waiting
      await $.ui.press({ plugin: 'diff', key: 'base' })
      await world.clock.settle()
      Object.assign(world.script, MOVED)
      await $.ui.press({ plugin: 'diff', key: 'base' })
      await world.clock.settle()
      saturated = { reads: world.reads.length, logs: [...world.logs] }
    } finally {
      first.release()
      second.release()
      await world.clock.advance(Fixtures.SETTLE_MS)
    }

    expect(saturated?.reads).toBe(3)
    expect(saturated?.logs.join('\n')).toContain('waiting for earlier work')
    expect(world.reads).toHaveLength(4)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  test('a body from a revoked base cannot publish while the next base read is held', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const body = heldCall()
    const read = heldCall()
    world.script['-- app.ts'] = '@@ -1 +1 @@\n-old\n+obsolete_body\n'
    world.state.heldBody = body.waiting
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
    expect(world.counts.bodies).toBe(2)
    await $.ui.render(Fixtures.PANE)

    Object.assign(world.script, MOVED)
    world.state.heldRead = read.waiting
    await $.ui.press({ plugin: 'diff', key: 'base' })
    await world.clock.settle()
    body.release()
    await world.clock.settle()
    const beforeRead = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    read.release()
    await world.clock.advance(Fixtures.SETTLE_MS)

    expect(beforeRead).not.toContain('obsolete_body')
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  test('a base switch can publish while the previous view read is held', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)

    const held = heldCall()
    world.state.heldRead = held.waiting
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
    await $.ui.render(Fixtures.PANE)
    Object.assign(world.script, MOVED)
    await $.ui.press({ plugin: 'diff', key: 'base' })
    await world.clock.settle()
    const beforeRelease = Fixtures.textOf(await $.ui.render(Fixtures.PANE))

    held.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(beforeRelease).toContain('other.ts')
    expect(beforeRelease).not.toContain('app.ts')
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  test('an old refresh completion cannot release a newer refresh or lose its catch-up edit', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)

    const old = heldCall()
    world.state.heldRead = old.waiting
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)

    const current = heldCall()
    world.state.heldRead = current.waiting
    Object.assign(world.script, MOVED)
    await $.command.run(Fixtures.CLEAR)
    await world.clock.settle()
    const whileBothHeld = world.reads.length

    old.release()
    await world.clock.settle()
    world.script['HEAD --numstat'] = '1\t0\tlatest.ts\0'
    world.script['-- latest.ts'] = '@@ -1 +1 @@\n-old\n+latest\n'
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
    const whileCurrentHeld = world.reads.length

    current.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(whileBothHeld).toBe(3)
    expect(whileCurrentHeld).toBe(3)
    expect(world.reads).toHaveLength(4)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('latest.ts')
  })

  test('clear refreshes the retained pane while an ended session read is held', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)

    const held = heldCall()
    world.state.heldRead = held.waiting
    await $.tool.call({ tool: 'Bash', command: 'make' })
    await world.clock.advance(Limits.REFRESH_DEBOUNCE_MS)
    expect(world.reads).toHaveLength(2)
    Object.assign(world.script, MOVED)
    await $.command.run(Fixtures.CLEAR)
    await world.clock.settle()
    const beforeRelease = Fixtures.textOf(await $.ui.render(Fixtures.PANE))

    held.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(beforeRelease).toContain('other.ts')
    expect(beforeRelease).not.toContain('app.ts')
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  test('a held old probe cannot hold or restart the new session command', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    const held = heldCall()
    world.state.heldProbe = held.waiting
    const old = $.command.run(Fixtures.DIFF).catch(error => ({ error: String(error) }))
    await world.clock.settle()
    expect(world.counts.probes).toBe(1)

    await $.command.run(Fixtures.CLEAR)
    Object.assign(world.script, MOVED)
    let reply: unknown = 'pending'
    const current = $.command.run(Fixtures.DIFF).then(
      result => { reply = result },
      error => { reply = { error: String(error) } },
    )
    await world.clock.settle()
    const beforeRelease = { reply, visible: world.pane.visible }
    held.release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    const oldReply = await old
    await current

    expect(beforeRelease).toEqual({
      reply: { text: Names.PANEL_SHOWN_TEXT }, visible: true,
    })
    expect(oldReply).toEqual({ text: Names.SESSION_CHANGED_TEXT })
    expect(world.opened).toHaveLength(1)
  })

  test('a denied auto-open permits a later edit to retry', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    world.state.denyOpen = true
    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.opened).toHaveLength(1)
    expect(world.pane.visible).toBe(false)

    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '2', new_string: '3',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.opened).toHaveLength(2)
    expect(world.pane.visible).toBe(true)
  })

  test('a failed auto-open permits a later edit to retry', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    world.state.failOpen = true
    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.opened).toHaveLength(1)
    expect(world.pane.visible).toBe(false)

    world.state.failOpen = false
    await $.tool.call({
      tool: 'Edit', file_path: '/work/app.ts', old_string: '2', new_string: '3',
    })
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.opened).toHaveLength(2)
    expect(world.pane.visible).toBe(true)
  })

  test('a normal pane opening records shown once across a close and reopen', { plugins: [RECORDING] }, async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await $.command.run(Fixtures.DIFF)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.logs.filter(line => line.includes('tengu_repl_diff_panel_shown'))).toHaveLength(1)
  })

  test('clear during pane identification records the retained pane for the current session', { plugins: [RECORDING] }, async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    world.state.delaySessionId = 1000
    const opening = $.command.run(Fixtures.DIFF)
    await world.clock.settle()
    expect(world.pane.visible).toBe(true)

    world.state.sessionId = 'new-session'
    await $.command.run(Fixtures.CLEAR)
    world.state.delaySessionId = 0
    await world.clock.advance(3000)
    expect(await opening).toEqual({ text: Names.PANEL_SHOWN_TEXT })
    expect(world.pane.visible).toBe(true)
    expect(world.logs.filter(line => line.includes('tengu_repl_diff_panel_shown'))).toHaveLength(1)

    await $.command.run(Fixtures.DIFF)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.logs.filter(line => line.includes('tengu_repl_diff_panel_shown'))).toHaveLength(1)
  })

  test('a pane retained by clear counts once in each new session', { plugins: [RECORDING] }, async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.logs.filter(line => line.includes('tengu_repl_diff_panel_shown'))).toHaveLength(1)

    world.state.sessionId = 'second-session'
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.pane.visible).toBe(true)
    expect(world.logs.filter(line => line.includes('tengu_repl_diff_panel_shown'))).toHaveLength(2)

    await $.command.run(Fixtures.DIFF)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.logs.filter(line => line.includes('tengu_repl_diff_panel_shown'))).toHaveLength(2)

    world.state.sessionId = 'third-session'
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.logs.filter(line => line.includes('tengu_repl_diff_panel_shown'))).toHaveLength(3)
  })

  test('delayed pane identification does not hold the shown reply or count after closing', { plugins: [RECORDING] }, async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    world.state.delaySessionId = 60_000
    let reply: unknown = 'pending'
    const opening = $.command.run(Fixtures.DIFF).then(
      result => { reply = result },
      error => { reply = { error: String(error) } },
    )
    await world.clock.advance(Fixtures.SETTLE_MS)
    const beforeIdentification = { reply, visible: world.pane.visible }
    await $.command.run(Fixtures.DIFF)
    world.state.delaySessionId = 0
    await world.clock.advance(60_000)
    await opening

    expect(beforeIdentification).toEqual({
      reply: { text: Names.PANEL_SHOWN_TEXT }, visible: true,
    })
    expect(world.pane.visible).toBe(false)
    expect(world.logs.filter(line => line.includes('tengu_repl_diff_panel_shown'))).toHaveLength(0)

    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(world.logs.filter(line => line.includes('tengu_repl_diff_panel_shown'))).toHaveLength(1)
  })

  test('a held old placement reports waiting and preserves ordered successor placement', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    world.state.delayOpen = 60_000
    const old = $.command.run(Fixtures.DIFF).catch(() => undefined)
    await world.clock.settle()
    expect(world.opened).toHaveLength(1)

    await $.command.run(Fixtures.CLEAR)
    Object.assign(world.script, MOVED)
    world.state.delayOpen = 0
    let reply: unknown = 'pending'
    const current = $.command.run(Fixtures.DIFF).then(
      result => { reply = result },
      error => { reply = { error: String(error) } },
    )
    await world.clock.advance(Fixtures.SETTLE_MS)
    const beforeRelease = { reply, visible: world.pane.visible, opened: world.opened.length }
    const waitingLog = [...world.logs]

    await world.clock.advance(60_000)
    await old
    await current
    expect(beforeRelease).toEqual({
      reply: 'pending', visible: false, opened: 1,
    })
    expect(waitingLog.join('\n')).toContain('waiting for an earlier pane operation')
    expect(reply).toEqual({ text: Names.PANEL_SHOWN_TEXT })
    expect(world.pane.visible).toBe(true)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('other.ts')
  })

  for (const command of ['clear', 'resume'] as const) {
    for (const fault of ['rejected', 'nonfinite'] as const) {
      test(`${command} with ${fault} timing waits for a verified timestamp and can retry`, async ($, on) => {
        const world = lifecycleWorld(on, $)
        filesWrittenAt(on, 2000)
        const isClear = command === 'clear'
        world.state.startedAt = isClear ? 100 : 5000
        await $.session.start(Fixtures.SESSION)
        await $.ui.render(Fixtures.HINT)
        await $.command.run(Fixtures.DIFF)
        await world.clock.settle()
        const reads = world.reads.length

        const currentStartedAt = isClear ? 5000 : 100
        world.state.startedAt = fault === 'nonfinite' ? Number.NaN : currentStartedAt
        world.state.transcript = Fixtures.EDITED_TRANSCRIPT
        world.state.failUsage = fault === 'rejected'
        await $.command.run(isClear ? Fixtures.CLEAR : Fixtures.RESUME)
        await world.clock.advance(Fixtures.SETTLE_MS)
        const beforeRecovery = { reads: world.reads.length, usages: world.counts.usages }

        world.state.failUsage = false
        world.state.startedAt = currentStartedAt
        await $.tool.call({ tool: 'Edit', file_path: '/work/trigger.ts', old_string: '1', new_string: '2' })
        await world.clock.advance(Fixtures.SETTLE_MS)
        const afterRecovery = {
          usages: world.counts.usages,
          visible: world.pane.visible,
          text: Fixtures.textOf(await $.ui.render(Fixtures.PANE)),
        }

        expect({
          beforeRecovery,
          afterRecovery: {
            usages: afterRecovery.usages, visible: afterRecovery.visible,
            hasFile: afterRecovery.text.includes('app.ts'),
            hasPreviousDating: afterRecovery.text.includes('1 file edited before this session'),
          },
        }, 'failed timing must not authorize a read dated by the ended session').toEqual({
          beforeRecovery: { reads, usages: 2 },
          afterRecovery: { usages: 3, visible: true, hasFile: !isClear, hasPreviousDating: isClear },
        })
      })
    }
  }

  test('manual diff reports unavailable timing and a later command can retry', async ($, on) => {
    const world = lifecycleWorld(on, $)
    filesWrittenAt(on, 2000)
    world.state.startedAt = 5000
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    world.state.failUsage = true
    await $.command.run(Fixtures.RESUME)
    await world.clock.settle()

    let reply: unknown = 'pending'
    const command = $.command.run(Fixtures.DIFF).then(
      result => { reply = result }, error => { reply = { error: String(error) } },
    )
    await world.clock.settle()
    const whileUnavailable = { reply, visible: world.pane.visible, opens: world.opened.length }

    world.state.failUsage = false
    world.state.startedAt = 100
    let retried: unknown = 'pending'
    const retry = $.command.run(Fixtures.DIFF).then(
      result => { retried = result }, error => { retried = { error: String(error) } },
    )
    await world.clock.advance(Fixtures.SETTLE_MS)
    await command
    await retry
    expect(whileUnavailable).toEqual({
      reply: { text: expect.stringContaining('active session timing is unavailable') },
      visible: false, opens: 1,
    })
    expect(retried).toEqual({ text: Names.PANEL_SHOWN_TEXT })
    expect(world.pane.visible).toBe(true)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('app.ts')
  })

  test('held current timing reports waiting and recovers when the dependency answers', async ($, on) => {
    const world = lifecycleWorld(on, $)
    filesWrittenAt(on, 2000)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    const reads = world.reads.length
    let release = () => {}
    world.state.heldUsage = new Promise<void>(resolve => { release = resolve })
    world.state.startedAt = 5000
    await $.command.run(Fixtures.CLEAR)
    await world.clock.settle()
    for (let edit = 0; edit < 3; edit += 1) {
      await $.tool.call({ tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2' })
      await world.clock.advance(Fixtures.SETTLE_MS)
    }
    const whileHeld = { reads: world.reads.length, usages: world.counts.usages, logs: [...world.logs] }

    world.state.heldUsage = null
    release()
    await world.clock.advance(Fixtures.SETTLE_MS)
    const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    expect({
      reads: whileHeld.reads, usages: whileHeld.usages,
      waiting: whileHeld.logs.join('\n').includes('waiting for the active session timing'),
      datedAfterRelease: text.includes('1 file edited before this session'),
    }).toEqual({ reads, usages: 2, waiting: true, datedAfterRelease: true })
  })

  test('a newer clear releases an open waiting for the ended session timing', async ($, on) => {
    const world = lifecycleWorld(on, $)
    filesWrittenAt(on, 2000)
    await $.session.start(Fixtures.SESSION)
    world.state.delayUsage = 60_000
    const older = $.command.run(Fixtures.CLEAR).catch(error => ({ error: String(error) }))
    await world.clock.settle()
    let oldReply: unknown = 'pending'
    const oldOpen = $.command.run(Fixtures.DIFF).then(
      result => { oldReply = result },
      error => { oldReply = { error: String(error) } },
    )
    await world.clock.settle()

    world.state.delayUsage = 0
    world.state.startedAt = 5000
    await $.command.run(Fixtures.CLEAR)
    Object.assign(world.script, MOVED)
    let reply: unknown = 'pending'
    const current = $.command.run(Fixtures.DIFF).then(
      result => { reply = result },
      error => { reply = { error: String(error) } },
    )
    await world.clock.advance(Fixtures.SETTLE_MS)
    const beforeRelease = { reply, oldReply }

    await world.clock.advance(60_000)
    await older
    await oldOpen
    await current
    expect(beforeRelease).toEqual({
      reply: { text: Names.PANEL_SHOWN_TEXT },
      oldReply: { text: Names.SESSION_CHANGED_TEXT },
    })
    const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    expect(text).toContain('No changes this session')
    expect(text).toContain('1 file edited before this session')
  })

  for (const command of ['clear', 'resume'] as const) {
    for (const path of ['manual', 'auto'] as const) {
      test(`denied ${path} cleanup waits for /${command} session timing before dating files`, async ($, on) => {
        const world = lifecycleWorld(on, $)
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
    const world = lifecycleWorld(on, $)
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
    const world = lifecycleWorld(on, $)
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
    const world = lifecycleWorld(on, $, { [Names.STORE_OPEN_KEY]: false })
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
      const world = lifecycleWorld(on, $)
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
    const world = lifecycleWorld(on, $)
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
    const world = lifecycleWorld(on, $)
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
        const world = lifecycleWorld(on, $)
        await $.session.start(Fixtures.SESSION)
        await $.ui.render(Fixtures.HINT)
        await world.clock.settle()
        world.state.delaySessionId = 1000
        let completed: unknown = 'pending'
        const opening = path === 'manual'
          ? $.command.run(Fixtures.DIFF)
          : $.tool.call({
              tool: 'Edit', file_path: '/work/app.ts', old_string: '1', new_string: '2',
            })
        void opening.then(reply => { completed = reply })
        await world.clock.settle()
        expect(world.pane.visible, 'the pane has been placed').toBe(true)
        expect(world.reads).toHaveLength(1)
        const beforeSwitch = completed

        Object.assign(world.script, MOVED)
        await $.command.run(command === 'clear' ? Fixtures.CLEAR : Fixtures.RESUME)
        world.state.delaySessionId = 0
        await world.clock.advance(3000)
        const reply = await opening
        if (path === 'manual') {
          expect(beforeSwitch, 'the shown reply already completed before the session switch').toEqual({
            text: Names.PANEL_SHOWN_TEXT,
          })
          expect(reply).toEqual({
            text: Names.PANEL_SHOWN_TEXT,
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
        const world = lifecycleWorld(on, $)
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
        const world = lifecycleWorld(on, $)
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
      const world = lifecycleWorld(on, $)
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
    const world = lifecycleWorld(on, $)
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
      const world = lifecycleWorld(on, $)
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
    const world = lifecycleWorld(on, $)
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
    const world = lifecycleWorld(on, $)
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
    const world = lifecycleWorld(on, $)
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
    const world = lifecycleWorld(on, $)
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
    const world = lifecycleWorld(on, $)
    world.state.transcript = Fixtures.EDITED_TRANSCRIPT
    world.state.delayMessages = 1000
    await $.session.start(Fixtures.SESSION)
    await $.ui.render(Fixtures.HINT)
    await world.clock.advance(3000)
    expect(world.opened.map(pane => pane.id)).toEqual(['diff'])
  })

  test('/resume refreshes a retained pane when its close is denied and restored history has no edits', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('app.ts')

    Object.assign(world.script, MOVED)
    world.state.denyClose = true
    await $.command.run(Fixtures.RESUME)
    await world.clock.advance(Fixtures.SETTLE_MS)

    expect(world.pane.visible).toBe(true)
    const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    expect(text).toContain('other.ts')
    expect(text).not.toContain('app.ts')
    expect(world.opened).toHaveLength(1)
    expect(await $.command.run(Fixtures.DIFF)).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
    expect(world.pane.visible).toBe(false)
  })

  test('/resume reports a denied close and reuses the retained pane for restored edits', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)

    Object.assign(world.script, MOVED)
    world.state.transcript = Fixtures.EDITED_TRANSCRIPT
    world.state.denyClose = true
    await $.command.run(Fixtures.RESUME)
    await world.clock.advance(Fixtures.SETTLE_MS)

    expect(world.logs.join('\n')).toContain('test close denied')
    expect(world.pane.visible).toBe(true)
    expect(world.opened).toHaveLength(1)
    expect(world.closed).toHaveLength(1)
    const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    expect(text).toContain('other.ts')
    expect(text).not.toContain('app.ts')
  })

  test('/resume waits for its session timing before refreshing a pane whose close was denied', async ($, on) => {
    const world = lifecycleWorld(on, $)
    filesWrittenAt(on, 2000)
    world.state.startedAt = 100
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(5000)
    const before = world.reads.length

    Object.assign(world.script, MOVED)
    world.state.startedAt = 5000
    world.state.delayUsage = 2000
    world.state.denyClose = true
    const resuming = $.command.run(Fixtures.RESUME)
    await world.clock.settle()
    expect(world.reads).toHaveLength(before)
    await world.clock.advance(3000)
    await resuming
    await world.clock.advance(Fixtures.SETTLE_MS)

    const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    expect(text).toContain('No changes this session')
    expect(text).toContain('1 file edited before this session')
  })

  test('a delayed denied resume close does not revive a pane closed by a later request', async ($, on) => {
    const world = lifecycleWorld(on, $)
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(Fixtures.SETTLE_MS)
    const before = world.reads.length
    world.state.delayClose = 1000
    world.state.denyClose = true
    const resuming = $.command.run(Fixtures.RESUME)
    await world.clock.settle()
    expect(world.closed).toHaveLength(1)

    world.state.delayClose = 0
    expect(await $.command.run(Fixtures.DIFF)).toEqual({ text: Names.PANEL_HIDDEN_TEXT })
    await world.clock.advance(2000)
    await resuming
    await world.clock.advance(Fixtures.SETTLE_MS)

    expect(world.pane.visible).toBe(false)
    expect(world.opened).toHaveLength(1)
    expect(world.reads.slice(before)).toEqual([])
  })

  test('an older denied resume close cannot reset a newer clear or discard its refresh', async ($, on) => {
    const world = lifecycleWorld(on, $)
    filesWrittenAt(on, 2000)
    world.state.startedAt = 100
    await $.session.start(Fixtures.SESSION)
    await $.command.run(Fixtures.DIFF)
    await world.clock.advance(5000)
    world.state.delayClose = 1000
    world.state.denyClose = true
    const resuming = $.command.run(Fixtures.RESUME)
    await world.clock.settle()
    expect(world.closed).toHaveLength(1)

    world.state.delayClose = 0
    world.state.delayRead = 2000
    world.state.startedAt = 5000
    Object.assign(world.script, MOVED)
    await $.command.run(Fixtures.CLEAR)
    await world.clock.advance(4000)
    await resuming
    await world.clock.advance(Fixtures.SETTLE_MS)

    expect(world.pane.visible).toBe(true)
    const text = Fixtures.textOf(await $.ui.render(Fixtures.PANE))
    expect(text).toContain('No changes this session')
    expect(text).toContain('1 file edited before this session')
  })

  test('/resume consumes a pending refresh when restored history has no edits', async ($, on) => {
    const world = lifecycleWorld(on, $)
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
        const world = lifecycleWorld(on, $)
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
      const world = lifecycleWorld(on, $)
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
      await world.clock.settle()
      const beforeFailure = [...world.marks]
      await world.clock.advance(4000)
      expect(beforeFailure, 'the new session finishes before the old failure').toEqual(['ok'])
      expect(world.marks).toEqual([
        'ok',
        failure === 'read' ? 'sad:git_diff_failed' : 'sad:git_hunks_failed',
      ])
      expect(Fixtures.textOf(await $.ui.render(Fixtures.PANE))).toContain('app.ts')
    })
  }

  test('/resume discards a restored-history read from the previous session', async ($, on) => {
    const world = lifecycleWorld(on, $)
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
