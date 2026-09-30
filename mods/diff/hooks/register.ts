import type {
  Args,
  On,
  PaneOpenArgs,
  ResultOf,
  SessionMessage,
  Timer,
} from 'claude-code'

import Ask from './ask'
import Backend from './backend'
import { COMMAND_SPEC } from './command-spec'
import { drawnFilesOf } from './drawn-files-of'
import { entryKindsOf } from './entry-kinds-of'
import type Git from './git'
import type { Host } from './host'
import { isCheckpointing } from './is-checkpointing'
import { isOnPaneSurface } from './is-on-pane-surface'
import { isOutsideWorkingTree } from './is-outside-working-tree'
import { isRecord } from './is-record'
import Limits from './limits'
import { Lifecycle } from './lifecycle'
import { messageOf } from './message-of'
import { mtimeOf } from './mtime-of'
import Names from './names'
import PaneState from './pane-state'
import PaneToggle from './pane-toggle'
import Record from './record'
import Tools from './tools'
import Turns from './turns'
import Views from './views'

/**
 * Registers the diff pane: `/diff` once the built-in stands down, the
 * pane's drawing and refresh, its opening on Claude's first edit, the ask.
 *
 * Git runs when the built-in's would: `session.start` binds the host and
 * registers `/diff`, and off its dispatch reads the transcript, so a resumed
 * session whose turns already edited opens as its first edit would; `/diff`
 * or the main loop's first checkpointed edit with room pins the backend,
 * until `/clear`, which reads afresh under a pane it leaves open; a docked
 * pane fetches, then opens, and such an edit inside the tree fetches until
 * one lists a file to open on.
 *
 * @param on the engine's registrar
 */
export function register(on: On) {
  let host: Host | null = null
  let backend: Backend.Backend | null = null
  let sessionStartMs = 0
  let sessionStartReady: Promise<boolean> = Promise.resolve(true)
  type SessionChange = {
    owner: ReturnType<Lifecycle['owner']>
    endedId: string
    reason: 'clear' | 'resume'
    phase: 'pending' | 'initializing' | 'unavailable' | 'ready'
    requested: number
    attempted: number
    release: (ready: boolean) => void
  }
  type PaneLookup =
    | { kind: 'placed' | 'waiting' | 'absent' }
    | { kind: 'unknown'; reason: string }
  let sessionChange: SessionChange | null = null
  let isPaneOpen = false
  let isPaneUnknown = false
  let openingPane: Promise<boolean> | null = null
  type DialogFit = {
    engine: Host
    epoch: number
    revision: number
    focus: boolean
  }
  const paneOperations = {
    tail: null as Promise<unknown> | null,
    closes: new Set<Promise<boolean>>(),
    revision: 0,
    fit: null as DialogFit | null,
    fitting: null as Promise<void> | null,
  }
  let paneCloses = 0
  let dialogRows: number | null = null
  let hasAutoOpened = false
  let hasRestoredEdits = false
  let landed = 0
  let opens = 0
  let columns: number | null = null
  let shownSessionId: string | null = null
  let paneTrigger: (typeof Record.SHOWN_TRIGGERS)[number] | null = null
  let armed: Ask.ArmedAsk | null = null
  let carrying: Ask.ArmedAsk | null = null
  let queuedRefresh: {
    owner: ReturnType<Lifecycle['owner']>
    engine: Host
    read: PaneState.Fetched | null
  } | null = null
  let generation = 0
  let bodyStamp: string | null = null
  let bodyBase: string | null = null

  const bodyLoads = new Map<string, Promise<Git.FileHunks | null | undefined>>()

  const polled = { toplevel: '', headKey: '' }
  const lifecycle = new Lifecycle(2, kind => {
    host?.uiLog(kind === 'pane-close' || kind === 'pane-cleanup'
      ? 'The diff panel is waiting for an earlier pane operation to finish.'
      : 'The diff panel is waiting for earlier work to finish; it will refresh when that work settles.')
  }, Limits.BODY_FETCH_CONCURRENCY)
  const pin = {
    cwd: '',
    isEmpty: false,
    get epoch() { return lifecycle.owner().session },
  }

  let model: PaneState.PaneModel = PaneState.INITIAL_MODEL

  const timers = new Map<'refresh' | 'redraw' | 'poll', Timer>()
  const loggedBaseKinds = new Set<'ok' | 'sad'>()

  const backendHostOf = (
    engine: Host,
    owner: ReturnType<Lifecycle['owner']>,
    cwd: string,
    startedAt: number,
  ): Backend.BackendHost => ({
    run: (argv, init) =>
      engine.run(
        argv,
        cwd === '' ? init : { cwd, ...init },
      ),
    readFile: path => engine.readFile(path),
    mtimeOf: path => mtimeOf(engine)(path),
    entryKindsOf: dir => entryKindsOf(engine)(dir),
    nowMs: () => engine.now(),
    sessionStartMsOf: () => startedAt,
    onBranchBase: base => {
      if (!lifecycle.isSession(owner)) return
      const isError = base.kind === 'error'

      const outcome: Record.MarkOutcome = isError
        ? { kind: 'sad', reason: base.reason }
        : {
            kind: 'ok',
            props: {
              outcome: { value: base.kind, of: Record.BASE_OUTCOMES },
            },
          }

      if (!loggedBaseKinds.has(outcome.kind)) {
        loggedBaseKinds.add(outcome.kind)

        Record.recorderOf(engine).mark(
          Record.FEATURES.baseResolve,
          outcome,
        )
      }
    },
  })

  async function pinBackend(engine: Host): Promise<boolean> {
    requestSessionConfirmation(engine)
    if (backend || pin.isEmpty) {
      return Promise.resolve(true)
    }

    const owner = lifecycle.owner()
    return (await lifecycle.run('probe', owner, () => probeBackend(engine, owner))) ?? false
  }

  async function probeBackend(
    engine: Host,
    owner: ReturnType<Lifecycle['owner']>,
  ): Promise<boolean> {
    const asked = { isAnswered: true }
    const cwd = pin.cwd
    if (!(await waitForSessionStart(engine, owner))) return false
    const probeHost = backendHostOf(engine, owner, cwd, sessionStartMs)

    const probed = await Backend.backendOf(
      {
        ...probeHost,
        run: (argv, init) =>
          probeHost.run(argv, init).catch((error: unknown) => {
            asked.isAnswered &&=
              argv[0] !== 'git' || !/\baborted\b/.test(messageOf(error))

            throw error
          }),
      },
      Backend.INSTALLED_BACKEND_PROBES,
    )

    if (!lifecycle.isCurrent(owner)) {
      return false
    }

    if (!probed) {
      pin.isEmpty = asked.isAnswered
      return asked.isAnswered
    }

    const stored = PaneState.baseModeOf(
      await engine
        .storeGet(Names.baseStoreKeyOf(probed.repository.toplevel))
        .catch(() => undefined),
    )

    if (!lifecycle.isCurrent(owner)) return false
    backend = probed

    const mode = stored && probed.baseModes.includes(stored) ? stored : null

    model = {
      ...model,
      words: probed.words,
      baseModes: probed.baseModes,
      ...(mode && { requestedMode: mode }),
    }

    return true
  }

  function unpin() {
    backend = null
    pin.isEmpty = false
    lifecycle.advance(true)
    queuedRefresh = null
    polled.toplevel = ''
    polled.headKey = ''
    timers.get('poll')?.cancel()
    timers.delete('poll')
  }

  function dialogPane(): PaneOpenArgs {
    return {
      id: Names.PANE_ID,
      title: Names.PANE_TITLE,
      holdToasts: true,
      closeOnEscape: true,
      rows: Views.dialogRowsOf(model),
    }
  }

  function queuePane<T>(task: () => Promise<T>): Promise<T> {
    const queued = (paneOperations.tail ?? Promise.resolve())
      .catch(() => undefined)
      .then(task)
    paneOperations.tail = queued
    return queued.finally(() => {
      if (paneOperations.tail === queued) paneOperations.tail = null
    })
  }

  function fitDialog(engine: Host, focus = false) {
    const rows = Views.dialogRowsOf(model)

    const isStale =
      isPaneOpen && !isPaneUnknown && model.isFullscreen === false &&
      (focus || rows !== dialogRows || paneOperations.fitting !== null)

    if (isStale) {
      const previous = paneOperations.fit
      paneOperations.fit = {
        engine,
        epoch: pin.epoch,
        revision: paneOperations.revision,
        focus: focus || (previous?.epoch === pin.epoch &&
          previous.revision === paneOperations.revision && previous.focus),
      }
      drainDialogFit()
    }
  }

  function drainDialogFit() {
    if (paneOperations.fitting !== null || paneOperations.fit === null) return
    const queued = paneOperations.fit
    const closes = [...paneOperations.closes]
    const fitting = queuePane(async () => {
      const request = paneOperations.fit
      if (request?.epoch !== queued.epoch || request.revision !== queued.revision) return
      paneOperations.fit = null
      if (!request || request.epoch !== pin.epoch ||
        request.revision !== paneOperations.revision ||
        !isPaneOpen || isPaneUnknown || model.isFullscreen !== false) return

      await Promise.allSettled(closes)
      if (request.epoch !== pin.epoch || request.revision !== paneOperations.revision ||
        !isPaneOpen || isPaneUnknown || model.isFullscreen !== false) return

      const pane = dialogPane()
      if (!request.focus && pane.rows === dialogRows) return
      dialogRows = null
      await request.engine.openPane({ ...pane, ...(request.focus && { focus: true }) })
      if (request.epoch === pin.epoch && request.revision === paneOperations.revision && isPaneOpen) {
        dialogRows = pane.rows ?? null
      } else {
        dialogRows = null
      }
    })
    paneOperations.fitting = fitting
    void fitting.catch(() => undefined).finally(() => {
      if (paneOperations.fitting === fitting) paneOperations.fitting = null
      drainDialogFit()
    })
  }

  function redraw(engine: Host) {
    fitDialog(engine)

    if (timers.has('redraw')) {
      return
    }

    timers.set(
      'redraw',
      engine.after(Limits.REDRAW_COALESCE_MS, () => {
        timers.delete('redraw')
        engine.invalidate()
      }),
    )
  }

  async function loadBodies(engine: Host): Promise<boolean> {
    const { data } = model
    const pinned = backend

    if (!data || !pinned) {
      lifecycle.clearBodies()
      bodyStamp = null
      bodyBase = null
      bodyLoads.clear()
      model = { ...model, bodies: PaneState.NO_BODIES }

      return false
    }

    const stamp = bodyStampOf(data)
    const isNewBase = data.baseRef !== bodyBase

    if (stamp !== bodyStamp) {
      bodyStamp = stamp
      bodyLoads.clear()
    }

    if (isNewBase) {
      bodyBase = data.baseRef
      model = { ...model, bodies: PaneState.NO_BODIES }
      redraw(engine)
    }

    return fetchBodies(engine, pinned, data)
  }

  const bodyStampOf = (data: Git.DiffData) => {
    const { session, view } = lifecycle.owner()
    return `${session}|${view}|${generation}|${data.baseRef}`
  }

  async function fetchBodies(
    engine: Host,
    pinned: Backend.Backend,
    data: Git.DiffData,
  ): Promise<boolean> {
    const stamp = bodyStampOf(data)
    const owner = lifecycle.owner()
    lifecycle.beginBodies(owner, stamp)

    function loadOf(file: Git.FileStat): Promise<Git.FileHunks | null | undefined> {
      if (!lifecycle.isCurrent(owner)) return Promise.resolve(undefined)
      const load = lifecycle.runBody(owner, stamp, () => pinned.fetchFileHunks(data, file))
      bodyLoads.set(file.path, load)

      return load.then(body => {
        if (body !== undefined && lifecycle.isCurrent(owner) && bodyStamp === stamp) {
          model = {
            ...model,
            bodies: new Map(model.bodies).set(file.path, body),
          }

          redraw(engine)
        }

        return body
      })
    }

    return (
      await Promise.all(drawnFilesOf(model).filter(file => !bodyLoads.has(file.path)).map(loadOf))
    ).includes(null)
  }

  function startPoll(engine: Host, pinned: Backend.Backend) {
    if (polled.toplevel === pinned.repository.toplevel) {
      return
    }

    timers.get('poll')?.cancel()
    polled.toplevel = pinned.repository.toplevel
    polled.headKey = ''

    timers.set(
      'poll',
      engine.every(Limits.HEAD_POLL_MS, () => {
        if (!isPaneOpen || backend !== pinned || lifecycle.busy('head')) {
          return
        }

        const owner = lifecycle.owner()
        void lifecycle.run('head', owner, async () => {
          if (!isPaneOpen || backend !== pinned) return
          const key = await pinned.headKeyOf().catch(() => '')
          if (!lifecycle.isCurrent(owner) || !isPaneOpen || backend !== pinned) return

          const hasMoved = polled.headKey !== '' && key !== polled.headKey

          polled.headKey = key

          if (hasMoved) {
            scheduleRefresh(engine)
          }
        }).catch(() => undefined)
      }),
    )
  }

  async function readOf(
    engine: Host,
    pinned: Backend.Backend | null,
    waitForCompletion = false,
  ): Promise<PaneState.Fetched | null> {
    const owner = lifecycle.owner()
    const mode = model.requestedMode
    if (!(await waitForSessionStart(engine, owner))) {
      return null
    }

    const fetched = (): Promise<Git.FetchOutcome> =>
      pinned
        ? pinned.fetchDiff(mode)
        : Promise.resolve({ kind: 'no-repository' })

    return lifecycle.run('read', owner, async () => {
      const [outcome, messages] = await Promise.all([
        fetched(),
        engine.messages().catch((): SessionMessage[] => []),
      ])
      return { outcome, messages }
    }, waitForCompletion)
  }

  async function refresh(
    engine: Host,
    read: PaneState.Fetched | null = null,
  ): Promise<void> {
    const owner = lifecycle.owner()
    requestSessionConfirmation(engine)
    if (lifecycle.busy('refresh')) {
      queuedRefresh = {
        owner, engine,
        read: read ?? (queuedRefresh?.owner === owner ? queuedRefresh.read : null),
      }

      return
    }

    const record = Record.recorderOf(engine)

    await lifecycle.run('refresh', owner, async () => {
      try {
        if (!backend && !pin.isEmpty && !(await pinBackend(engine))) return
        if (!lifecycle.isCurrent(owner)) return
        const pinned = backend
        model = { ...model, isLoading: model.data === null }

        const fetched = read ?? (await readOf(engine, pinned, true))

        if (!fetched) return

        const { outcome } = fetched

        if (outcome.kind === 'unavailable') {
          record.mark(Record.FEATURES.read, {
            kind: 'sad',
            reason: 'git_diff_failed',
          })
        }

        if (!lifecycle.isCurrent(owner)) return

        model = PaneState.afterFetch(model, fetched)

        switch (outcome.kind) {
          case 'no-repository':
          case 'unavailable':
            break
          case 'data':
            generation += 1
            if (pinned) startPoll(engine, pinned)
            break
        }

        const hasHunksFailed = await loadBodies(engine)

        if (outcome.kind === 'data' && (hasHunksFailed || lifecycle.isCurrent(owner))) {
          record.mark(
            Record.FEATURES.read,
            hasHunksFailed
              ? { kind: 'sad', reason: 'git_hunks_failed' }
              : { kind: 'ok' },
          )
        }
      } catch (error) {
        if (lifecycle.isCurrent(owner)) {
          record.mark(Record.FEATURES.read, {
            kind: 'sad', reason: 'git_diff_threw',
          })
        }
        throw error
      } finally {
        if (lifecycle.isCurrent(owner)) redraw(engine)
      }
    })

    if (lifecycle.isCurrent(owner) && queuedRefresh?.owner === owner) {
      const queued = queuedRefresh
      queuedRefresh = null
      if (queued.read) void refresh(queued.engine, queued.read).catch(() => undefined)
      else scheduleRefresh(queued.engine)
    }
  }

  function scheduleRefresh(engine: Host): void {
    timers.get('refresh')?.cancel()

    timers.set(
      'refresh',
      engine.after(Limits.REFRESH_DEBOUNCE_MS, () => {
        timers.delete('refresh')
        void refresh(engine)
      }),
    )
  }

  function openPane(
    engine: Host,
    trigger: (typeof Record.SHOWN_TRIGGERS)[number],
    read: PaneState.Fetched | null = null,
  ): Promise<boolean> {
    const { epoch } = pin
    const closes = [...paneOperations.closes]
    opens += 1
    paneOperations.revision += 1
    if (paneOperations.tail !== null || closes.length > 0) {
      engine.uiLog('The diff panel is waiting for an earlier pane operation to finish.')
    }

    const opening = queuePane(async () => {
      if (epoch !== pin.epoch || isPaneUnknown) {
        return false
      }

      return isPaneOpen || placePane(engine, trigger, read, closes)
    })

    openingPane = opening

    return opening.finally(() => {
      if (openingPane === opening) {
        openingPane = null
      }
    })
  }

  async function placePane(
    engine: Host,
    trigger: (typeof Record.SHOWN_TRIGGERS)[number],
    read: PaneState.Fetched | null,
    closes: readonly Promise<boolean>[],
  ): Promise<boolean> {
    const { epoch } = pin
    const owner = lifecycle.owner()
    const isDialog = model.isFullscreen === false

    model = {
      ...model,
      selectedPath: null,
      dialogView: 'list',
      place: { ...model.place, top: 0, listStart: 0 },
    }

    dialogRows = isDialog ? Views.dialogRowsOf(model) : null

    const landedBefore = landed

    if (read) {
      model = PaneState.afterFetch(model, read)
    } else if (!isDialog) {
      await refresh(engine).catch(() => undefined)
    }

    await Promise.allSettled(closes)
    if (epoch !== pin.epoch) {
      return false
    }

    const closesAtOpen = paneCloses
    let isWaiting = false

    try {
      const opened = await engine.openPane(
        isDialog
          ? { ...dialogPane(), focus: true }
          : { id: Names.PANE_ID, title: Names.PANE_TITLE, holdToasts: true },
      )

      isWaiting = isRecord(opened) && opened.isPlaced === false
    } catch (error) {
      if (!(await isPlacedAfterRejection(engine, error, epoch, closesAtOpen, trigger))) {
        return false
      }
    }

    if (epoch !== pin.epoch) {
      const closedBefore = paneCloses

      try {
        await engine.closePane({ id: Names.PANE_ID })
      } catch (error) {
        engine.uiLog(
          `Could not close the diff panel after the session changed: ${Views.sanitizeName(messageOf(error))}`,
        )

        if (!isWaiting && paneCloses === closedBefore) {
          isPaneOpen = true
          paneTrigger = trigger
          void recordShown(engine)
          await pinBackend(engine).catch(() => false)

          if (isPaneOpen) {
            await refresh(engine).catch(() => undefined)
          }
        }
      }

      return isPaneOpen
    }

    if (isWaiting) {
      await engine.closePane({ id: Names.PANE_ID }).catch(() => undefined)

      return false
    }

    isPaneOpen = true
    paneTrigger = trigger
    void recordShown(engine)

    const isStale = isDialog || read !== null || landed !== landedBefore

    if (isStale) {
      void refresh(engine, read)
    }

    return true
  }

  async function paneOf(engine: Host): Promise<PaneLookup> {
    let panes: unknown

    try {
      panes = await engine.panes()
    } catch (error) {
      return { kind: 'unknown', reason: messageOf(error) }
    }

    if (!Array.isArray(panes)) {
      return { kind: 'unknown', reason: 'the engine listed no panes' }
    }

    const pane = panes
      .filter(isRecord)
      .find(listed => listed.id === Names.PANE_ID)

    if (!pane) {
      return { kind: 'absent' }
    }

    return typeof pane.isPlaced === 'boolean'
      ? { kind: pane.isPlaced ? 'placed' : 'waiting' }
      : { kind: 'unknown', reason: 'the engine did not say whether the diff panel is placed' }
  }

  async function isPlacedAfterRejection(
    engine: Host,
    error: unknown,
    epoch: number,
    closesAtOpen: number,
    trigger: (typeof Record.SHOWN_TRIGGERS)[number],
  ): Promise<boolean> {
    const pane = epoch === pin.epoch ? await paneOf(engine) : null

    if (pane === null || epoch !== pin.epoch) {
      try {
        await engine.closePane({ id: Names.PANE_ID })
      } catch (closeError) {
        engine.uiLog(
          `Could not close the diff panel after the session changed: ${Views.sanitizeName(messageOf(closeError))}`,
        )

        if (paneCloses === closesAtOpen) {
          isPaneUnknown = true
        }
      }

      throw error
    }

    if (paneCloses !== closesAtOpen) {
      throw error
    }

    const reason = Views.sanitizeName(messageOf(error))

    switch (pane.kind) {
      case 'absent':
        throw error
      case 'waiting':
        await engine.closePane({ id: Names.PANE_ID }).catch(() => undefined)
        throw error
      case 'unknown':
        isPaneUnknown = true
        paneTrigger = trigger
        engine.uiLog(
          `Could not tell whether the diff panel opened: ${reason}; the pane lookup failed: ${Views.sanitizeName(pane.reason)}`,
        )
        return false
      case 'placed':
        engine.uiLog(`The diff panel opened, but opening it reported: ${reason}`)
        return true
    }
  }

  async function settleUnknownPane(engine: Host): Promise<void> {
    const { epoch } = pin
    const closedBefore = paneCloses
    const opened = opens
    const pane = await paneOf(engine)

    if (!isPaneUnknown || epoch !== pin.epoch || paneCloses !== closedBefore || opens !== opened) {
      return
    }

    if (pane.kind === 'unknown') {
      engine.uiLog(
        `Could not tell whether the diff panel is shown: ${Views.sanitizeName(pane.reason)}`,
      )

      return
    }

    isPaneUnknown = false
    isPaneOpen = pane.kind === 'placed'

    if (isPaneOpen) {
      void recordShown(engine)
    }

    if (pane.kind === 'waiting') {
      await closePane(engine, true).catch(() => undefined)
    }
  }

  async function recordShown(engine: Host): Promise<void> {
    const { epoch } = pin
    const closedBefore = paneCloses
    const trigger = paneTrigger

    if (!isPaneOpen || trigger === null) {
      return
    }

    const sessionId = await engine.sessionId().catch(() => null)

    if (epoch !== pin.epoch || paneCloses !== closedBefore || !isPaneOpen) {
      return
    }

    if (sessionId !== null && sessionId !== shownSessionId) {
      shownSessionId = sessionId
      Record.recorderOf(engine).shown(trigger, Record.widthBucketOf(columns))
    }
  }

  async function closePane(engine: Host, isCleanup = false): Promise<boolean> {
    const owner = lifecycle.owner()
    const placements = paneOperations.tail
    if (paneOperations.tail !== null) {
      engine.uiLog('The diff panel is waiting for an earlier pane operation to finish.')
    }
    const closing = lifecycle.run(
      isCleanup ? 'pane-cleanup' : 'pane-close', owner, async () => {
        await placements?.catch(() => undefined)
        if (!lifecycle.isSession(owner)) return false
        await engine.closePane({ id: Names.PANE_ID })
        paneOperations.revision += 1
        isPaneOpen = false
        isPaneUnknown = false
        return true
      }, true,
    ).then(result => result ?? false)
    paneOperations.closes.add(closing)
    return closing.finally(() => { paneOperations.closes.delete(closing) })
  }

  function markTabSwitch(engine: Host, tab: (typeof Record.TABS)[number]) {
    Record.recorderOf(engine).mark(Record.FEATURES.tabSwitch, {
      kind: 'ok',
      props: { tab: { value: tab, of: Record.TABS } },
    })
  }

  const isTaken = () => isPaneOpen || hasAutoOpened || isPaneUnknown

  const hasRoomFor = (floor: number) =>
    model.isFullscreen === true && columns !== null && columns >= floor

  async function openOnFetchedFiles(
    engine: Host,
    floor: number,
  ): Promise<void> {
    if (lifecycle.busy('auto')) {
      return
    }

    const owner = lifecycle.owner()

    await lifecycle.run('auto', owner, async () => {
      while (lifecycle.isCurrent(owner) && !isTaken()) {
        const seen = landed
        const opened = opens
        const read = await readOf(engine, backend)

        if (!read) {
          return
        }

        const isOvertaken = opened !== opens

        const isCurrent =
          lifecycle.isCurrent(owner) && !isOvertaken && hasRoomFor(floor) && !isTaken()

        const isListing = isCurrent && PaneState.hasSessionFiles(read.outcome)

        if (isListing) {
          hasAutoOpened = true

          let isPlaced = false

          try {
            isPlaced = await openPane(engine, 'auto_open', read)
          } finally {
            if (lifecycle.isCurrent(owner) && !isPlaced) {
              hasAutoOpened = isPaneOpen
            }
          }

          if (!lifecycle.isCurrent(owner) || !isPlaced) {
            return
          }
        }

        const hasLostRoom = !isListing && !hasRoomFor(floor)

        if (seen === landed || isOvertaken || hasLostRoom) {
          return
        }

        if (isListing) {
          scheduleRefresh(engine)
        }
      }
    })
  }

  async function openOnFirstEdit(
    engine: Host,
    path: string | null = null,
  ): Promise<void> {
    const { epoch } = pin
    const isOvertaken = () => epoch !== pin.epoch || isTaken()

    if (isOvertaken()) {
      return
    }

    const preference = await engine.storeGet(Names.STORE_OPEN_KEY)
    const isKeptOpen = preference === true

    const floor = isKeptOpen
      ? Limits.OPEN_MIN_COLUMNS
      : Limits.AUTO_OPEN_MIN_COLUMNS

    const hasRoom = preference !== false && hasRoomFor(floor)

    if (!hasRoom || isOvertaken()) {
      return
    }

    const isCheckpointed = await engine.isCheckpointing().catch(() => true)

    if (!isCheckpointed || isOvertaken()) {
      return
    }

    await pinBackend(engine)

    if (!backend || isOvertaken()) {
      return
    }

    const isOutside =
      path !== null &&
      isOutsideWorkingTree(path, {
        cwd: pin.cwd,
        toplevel: backend.repository.toplevel,
      })

    if (!isOutside) {
      await openOnFetchedFiles(engine, floor)
    }
  }

  async function openOnRestore(engine: Host): Promise<void> {
    const { epoch } = pin
    const messages = await engine.messages().catch((): SessionMessage[] => [])

    if (epoch !== pin.epoch) {
      return
    }

    hasRestoredEdits = Turns.turnDiffsOf(messages).length > 0

    if (hasRestoredEdits) {
      await openOnFirstEdit(engine)
    }
  }

  function disarm(engine: Host) {
    armed = null
    model = { ...model, armedPath: null }
    engine.status(undefined)
  }

  const actionsOf = (engine: Host): Views.PaneActions => ({
    selectFile: path => {
      const isDocked = model.placement === 'dock'

      model = {
        ...model,
        selectedPath: path,
        dialogView: isDocked ? model.dialogView : 'detail',
        place: isDocked ? Views.placeAtFile(model, path) : model.place,
      }

      redraw(engine)
    },
    scrollList: delta => {
      model = { ...model, place: Views.listScrolledBy(model, delta) }
      redraw(engine)
    },
    toggleNoise: () => {
      model = { ...model, isNoiseShown: !model.isNoiseShown }
      void loadBodies(engine)
      redraw(engine)
    },
    togglePreSession: () => {
      model = { ...model, isPreSessionShown: !model.isPreSessionShown }
      void loadBodies(engine)
      redraw(engine)
    },
    cycleBase: () => {
      const { baseModes, requestedMode } = model

      const mode =
        baseModes[(baseModes.indexOf(requestedMode) + 1) % baseModes.length] ??
        requestedMode

      if (mode === requestedMode) {
        return
      }

      lifecycle.advance(false)
      queuedRefresh = null
      model = { ...model, requestedMode: mode }

      Record.recorderOf(engine).mark(Record.FEATURES.baseSwitch, {
        kind: 'ok',
        props: { mode: { value: mode, of: model.baseModes } },
      })

      const toplevel = model.data?.repository.toplevel

      if (toplevel !== undefined) {
        void engine
          .storeSet(Names.baseStoreKeyOf(toplevel), mode)
          .catch(() => undefined)
      }

      void refresh(engine)
      redraw(engine)
    },
    chooseSource: value => {
      const index = Number(value)
      const isTurn = value !== 'current' && Number.isInteger(index)

      const source: PaneState.Source = isTurn
        ? { kind: 'turn', index }
        : { kind: 'current' }

      model = { ...model, source, selectedPath: null, dialogView: 'list' }
      redraw(engine)
    },
    toggleAsk: path => {
      if (armed?.path === path) {
        disarm(engine)
        redraw(engine)

        return
      }

      arm(engine, path)
    },
  })

  function arm(engine: Host, path: string) {
    armed = Ask.armedAskOf(
      path,
      PaneState.pickedTurnOf(model)?.files.find(file => file.path === path)
        ?.hunks ??
        model.bodies.get(path)?.hunks ??
        [],
    )

    model = { ...model, armedPath: path }

    engine.status(
      `${Views.sanitizeName(path)} rides your next prompt (press ` +
        `asked ✓ to drop it)`,
    )

    redraw(engine)
  }

  async function startedAtOf(engine: Host): Promise<number | null> {
    const startedAt: unknown = await engine.startedAt().catch(() => undefined)

    return typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null
  }

  async function waitForSessionStart(
    engine: Host,
    owner: ReturnType<Lifecycle['owner']>,
  ): Promise<boolean> {
    if (sessionChange?.phase === 'initializing' && lifecycle.isSession(owner)) {
      engine.uiLog('The diff panel is waiting for the active session timing and any unfinished pane operation.')
    }
    const ready = await lifecycle.untilChanged(owner, sessionStartReady)
    return ready === true && lifecycle.isCurrent(owner)
  }

  async function resetSessionStart(engine: Host): Promise<void> {
    const { epoch } = pin
    const startedAt = await startedAtOf(engine)

    if (epoch === pin.epoch) {
      if (startedAt === null) {
        throw new Error(Names.SESSION_TIMING_UNAVAILABLE_TEXT)
      }
      sessionStartMs = startedAt
    }
  }

  async function bind(engine: Host, cwd: string): Promise<void> {
    sessionStartMs = (await startedAtOf(engine)) ?? (await engine.now())
    pin.cwd = cwd

    try {
      await engine.registerCommand(COMMAND_SPEC)
      host = engine
    } catch (error) {
      const reason = messageOf(error)

      if (!Names.BUILTIN_HOLDS_PATTERN.test(reason)) {
        engine.uiLog(Names.registerFailedTextOf(Views.sanitizeName(reason)))
      }
    }
  }

  on('session.start', async ($, e, next) => {
    await bind(
      {
        now: () => $.clock.now(),
        after: (ms, fn) => $.clock.after(ms, fn),
        every: (ms, fn) => $.clock.every(ms, fn),
        run: (argv, init) => $.process.run(argv, init),
        stat: path => $.fs.stat(path),
        listDir: path => $.fs.list(path),
        readFile: path => $.fs.read(path),
        storeGet: key => $.store.get(key),
        storeSet: (key, value) => $.store.set(key, value),
        isCheckpointing: async () =>
          isCheckpointing(
            await $.settings.read(),
            await $.env.get('CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING'),
          ),
        messages: () => $.session.messages(),
        invalidate: () => $.ui.invalidate('ui.render'),
        status: text => $.ui.status(text),
        uiLog: text => $.ui.log(text),
        openPane: pane => $.ui.open(pane),
        closePane: pane => $.ui.close(pane),
        panes: () => $.ui.panes(),
        registerCommand: spec => $.command.register(spec),
        sessionId: () => $.session.id(),
        startedAt: () =>
          $.session
            .usage()
            .then((usage: unknown) =>
              isRecord(usage) ? usage.startedAt : undefined,
            ),
        mark: entry => $.telemetry.mark(entry),
        log: entry => $.telemetry.log(entry),
      },
      e.cwd,
    )

    if (host) {
      void openOnRestore(host).catch(() => undefined)
    }

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (isOnPaneSurface(e)) {
      const viewport: { columns?: number; isFullscreen?: boolean } | undefined =
        e.viewport

      const isFirstMeasure = columns === null && viewport?.columns !== undefined

      columns = viewport?.columns ?? columns

      model = {
        ...model,
        isFullscreen: viewport?.isFullscreen ?? model.isFullscreen,
      }

      if (isFirstMeasure && hasRestoredEdits && host) {
        void openOnFirstEdit(host).catch(() => undefined)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== Names.PANE_ID || !host || !isOnPaneSurface(e)) {
      return next(e)
    }

    const { Box, Text, Button, Select, Code } = await $.ui.resolve(e)

    columns = e.viewport?.columns ?? columns

    model = {
      ...model,
      placement: e.props.placement,
      place: {
        ...model.place,
        columns: Math.max(
          1,
          e.props.bodyColumns - Limits.PANE_RIGHT_PAD_COLUMNS,
        ),
        rows: e.props.scroll.bodyRows,
      },
    }

    return Views.paneView(
      {
        ui: { Box, Text, Button, Select, Code },
        actions: actionsOf(host),
        columns: e.props.bodyColumns,
        rows: e.props.scroll.bodyRows,
      },
      model,
      { placement: e.props.placement, terminalColumns: columns },
    )
  })

  on('command.run', { command: Names.COMMAND_NAME }, async ($, e, next) => {
    if (!host) {
      return next(e)
    }

    const commandOwner = lifecycle.owner()
    if (isPaneUnknown) {
      await settleUnknownPane(host)
      if (!lifecycle.isSession(commandOwner)) return { text: Names.SESSION_CHANGED_TEXT }
      if (isPaneUnknown) return { text: Names.PANEL_STATE_UNKNOWN_TEXT }
    }
    if (!isPaneOpen) {
      let isAnswered = await pinBackend(host)
      if (!lifecycle.isSession(commandOwner)) return { text: Names.SESSION_CHANGED_TEXT }
      if (!isAnswered) isAnswered = await pinBackend(host)
      if (!lifecycle.isSession(commandOwner)) return { text: Names.SESSION_CHANGED_TEXT }

      if (!backend) {
        return {
          text: sessionChange?.phase === 'unavailable'
            ? Names.SESSION_TIMING_UNAVAILABLE_TEXT
            : isAnswered
            ? Names.NOT_IN_REPOSITORY_TEXT
            : Names.GIT_UNANSWERED_TEXT,
        }
      }
    }

    const { isFullscreen } = e.presentation

    columns = e.presentation.columns
    model = { ...model, isFullscreen }

    const toggle = PaneToggle.paneToggleOf({
      isOpen: isPaneOpen,
      columns: isFullscreen ? columns : null,
    })

    if (toggle === 'too-narrow') {
      return { text: Names.RESIZE_TERMINAL_TEXT }
    }

    const isOpening = toggle === 'open'
    const { epoch } = pin

    const isDone = isOpening
      ? await openPane(host, 'manual')
      : await closePane(host)

    if (!isDone) {
      return {
        text: epoch !== pin.epoch
          ? Names.SESSION_CHANGED_TEXT
          : isPaneUnknown
          ? Names.PANEL_STATE_UNKNOWN_TEXT
          : Names.RESIZE_TERMINAL_TEXT,
      }
    }

    if (!isFullscreen) {
      return isOpening ? {} : { text: Names.DIALOG_DISMISSED_TEXT }
    }

    markTabSwitch(host, isOpening ? 'diff' : 'convo')
    await host.storeSet(Names.STORE_OPEN_KEY, isOpening).catch(() => undefined)

    return {
      text: isOpening ? Names.PANEL_SHOWN_TEXT : Names.PANEL_HIDDEN_TEXT,
    }
  })

  on('ui.close', { id: Names.PANE_ID }, async ($, e, next) => {
    const isBack =
      e.origin.kind === 'person' &&
      model.placement === 'inline' &&
      model.dialogView === 'detail'

    if (isBack && host) {
      model = { ...model, dialogView: 'list' }
      redraw(host)

      fitDialog(host, true)

      return { deny: 'back to the file list' }
    }

    const result = await next(e)
    const isClosed = result.deny === undefined
    const isPersons = isClosed && e.origin.kind === 'person'

    if (isClosed) {
      paneCloses += 1
      isPaneOpen = false
      isPaneUnknown = false
      paneTrigger = null
    }

    const isDialog = model.isFullscreen === false

    if (isPersons && host && isDialog) {
      host.uiLog(Names.DIALOG_DISMISSED_TEXT)
    }

    if (isPersons && host && !isDialog) {
      markTabSwitch(host, 'convo')
      await host.storeSet(Names.STORE_OPEN_KEY, false).catch(() => undefined)
    }

    return result
  })

  on('ui.focus', { plugin: Names.PLUGIN_NAME }, ($, e, next) => {
    const isListed =
      model.placement === 'inline' && model.dialogView === 'list' && host

    const focus = isListed ? Views.dialogFocusOf(model, e.element) : null

    if (focus === 'stay') {
      return {}
    }

    if (!focus || !host) {
      return next(e)
    }

    model = { ...model, selectedPath: focus.selectedPath }
    fitDialog(host)
    host.invalidate()

    return next({ ...e, element: focus.landing })
  })

  on('ui.scroll', { requestId: Names.PANE_ID }, ($, e, next) => {
    const isOwnBody = e.origin.kind === 'person' && model.placement === 'dock'

    if (!isOwnBody || !host) {
      return next(e)
    }

    const isOverList = Views.isWheelOverList(model, e)

    model = {
      ...model,
      place: isOverList
        ? Views.listScrolledBy(model, e.by)
        : Views.bodyScrolledBy(model, e),
    }

    host.invalidate()

    return {}
  })

  function beginSessionChange(engine: Host, endedId: string, reason: 'clear' | 'resume') {
    const previous = sessionChange
    unpin()
    timers.get('refresh')?.cancel()
    timers.delete('refresh')
    queuedRefresh = null
    hasAutoOpened = false
    hasRestoredEdits = false
    bodyStamp = null
    bodyBase = null
    bodyLoads.clear()
    disarm(engine)
    model = PaneState.afterNewSession(model)
    let release = (_ready: boolean) => {}
    sessionStartReady = new Promise<boolean>(resolve => { release = resolve })
    sessionChange = {
      owner: lifecycle.owner(), endedId, reason, phase: 'pending',
      requested: 0, attempted: 0, release,
    }
    previous?.release(false)
  }

  function requestSessionConfirmation(engine: Host) {
    const change = sessionChange
    if (!change || (change.phase !== 'pending' && change.phase !== 'unavailable')) return
    change.requested += 1
    confirmSessionChange(engine, change)
  }

  function confirmSessionChange(engine: Host, change: SessionChange) {
    if (change !== sessionChange || change.phase === 'ready' || change.phase === 'initializing' || lifecycle.busy('session')) return

    if (change.phase === 'unavailable') {
      sessionStartReady = new Promise<boolean>(resolve => { change.release = resolve })
      change.phase = 'pending'
    }

    void lifecycle.run('session', change.owner, async () => {
      while (change === sessionChange && change.phase === 'pending') {
        change.attempted = change.requested
        const id = await engine.sessionId().catch(() => null)
        if (!lifecycle.isSession(change.owner) || change !== sessionChange) return

        if (id === null || id === change.endedId) {
          if (change.attempted !== change.requested) continue
          engine.uiLog('The diff panel is waiting for the active session to be confirmed.')
          return
        }

        change.phase = 'initializing'
        const starting = resetSessionStart(engine)
        void starting.catch(() => undefined)

        if ((isPaneOpen || isPaneUnknown) && change.reason === 'resume') {
          try {
            await closePane(engine, true)
          } catch (error) {
            engine.uiLog(
              `Could not close the diff panel after the session changed: ${Views.sanitizeName(messageOf(error))}`,
            )
          }
        }

        await starting
        if (!lifecycle.isSession(change.owner) || change !== sessionChange) return
        change.phase = 'ready'
        change.release(true)

        if (isPaneOpen) {
          void recordShown(engine)
          await pinBackend(engine)
          if (lifecycle.isSession(change.owner) && isPaneOpen) void refresh(engine)
        }
        if (lifecycle.isSession(change.owner) && change.reason === 'resume') {
          void openOnRestore(engine).catch(() => undefined)
        }
      }
    }).catch(error => {
      if (change !== sessionChange) return
      change.phase = 'unavailable'
      change.release(false)
      engine.uiLog(`Could not initialize the diff session: ${Views.sanitizeName(messageOf(error))}`)
    }).finally(() => {
      if ((change.phase === 'pending' || change.phase === 'unavailable') && change.attempted !== change.requested) {
        confirmSessionChange(engine, change)
      }
    })
  }

  on('session.end', ($, e, next) => {
    if (host && (e.reason === 'clear' || e.reason === 'resume')) {
      beginSessionChange(host, e.sessionId, e.reason)
    }
    return next(e)
  })

  on('command.run', { command: ['clear', 'resume'] }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (host) requestSessionConfirmation(host)
    }
  })

  function afterTool(
    engine: Host,
    e: Args<'tool.call'>,
    result: ResultOf['tool.call'] | undefined,
  ) {
    const isEdit = Tools.EDITING_TOOLS.some(name => name === e.tool)

    const hasEdited =
      isEdit &&
      result !== undefined &&
      result.deny === undefined &&
      result.isError !== true

    const hasLanded = isEdit ? hasEdited : Tools.mayHaveWritten(result)

    if (hasLanded) {
      landed += 1
    }

    if (hasLanded && isPaneOpen) {
      scheduleRefresh(engine)
    }

    const isMainLoopEdit = hasEdited && e.agentId === undefined

    if (isMainLoopEdit) {
      void openOnFirstEdit(engine, Tools.editedPathOf(e)).catch(() => undefined)
    }
  }

  on(
    'tool.call',
    {
      tool: [
        ...Tools.EDITING_TOOLS,
        ...Tools.SHELL_TOOLS.map(name => new RegExp('^' + name + '$')),
      ],
    },
    async ($, e, next) => {
      let result: ResultOf['tool.call'] | undefined

      try {
        result = await next(e)

        return result
      } finally {
        if (host) {
          afterTool(host, e, result)
        }
      }
    },
  )

  on('prompt.submit', async ($, e, next) => {
    const asked = armed

    if (!host || !asked || carrying === asked) {
      return next(e)
    }

    const context = e.context ?? []

    const text = Ask.fittedAskTextOf(
      asked.text,
      Limits.PROMPT_CONTEXT_MAX_CHARS -
        context.reduce((sum, entry) => sum + entry.length, 0),
    )

    if (text === undefined) {
      disarm(host)

      host.status(
        `${Views.sanitizeName(asked.path)}'s diff did not fit in the prompt ` +
          `and was dropped`,
      )

      redraw(host)

      return next(e)
    }

    carrying = asked

    try {
      const result = await next({ ...e, context: [...context, text] })

      if (result.drop === undefined) {
        Record.recorderOf(host).asked()

        if (armed === asked) {
          disarm(host)
          redraw(host)
        }
      }

      return result
    } finally {
      carrying = null
    }
  })
}
