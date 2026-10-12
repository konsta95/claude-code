type Owner = Readonly<{
  session: number
  view: number
  signal: AbortSignal
  sessionSignal: AbortSignal
}>

type Kind = 'probe' | 'read' | 'refresh' | 'auto' | 'head' | 'body' | 'session' | 'pane-close' | 'pane-cleanup'

type Work = {
  owner: Owner
  result: Promise<unknown>
  settled: Promise<unknown>
}

type Waiting = {
  work: Work
  start: () => void
  discard: () => void
}

type BodyScope = { owner: Owner; key: string }
type BodyWork = {
  scope: BodyScope
  start: () => void
  discard: () => void
}

/**
 * Authority for diff work: session and base changes revoke old commits;
 * completing an old job cannot release its replacement. Read cancellation
 * ends the caller's wait, not the underlying dependency. Retained jobs still
 * occupy capacity until that dependency settles. Pane effects must keep their
 * own ordering until the host supports cancellation at placement.
 */
export class Lifecycle {
  private changed = new AbortController()
  private sessionChanged = new AbortController()
  private current: Owner = {
    session: 0, view: 0, signal: this.changed.signal,
    sessionSignal: this.sessionChanged.signal,
  }
  private running = new Map<Kind, Work>()
  private retained = new Map<Kind, Set<Work>>()
  private waiting = new Map<Kind, Waiting>()
  private bodyScope: BodyScope | null = null
  private bodyRunning = new Set<BodyWork>()
  private bodyWaiting: BodyWork[] = []

  constructor(
    private capacity: number,
    private onWaiting: (kind: Kind) => void,
    private bodyCapacity: number,
  ) {}

  owner(): Owner {
    return this.current
  }

  isCurrent(owner: Owner): boolean {
    return owner === this.current
  }

  isSession(owner: Owner): boolean {
    return owner.session === this.current.session
  }

  advance(isSession: boolean): void {
    const previous = this.changed
    const previousSession = this.sessionChanged
    this.changed = new AbortController()
    if (isSession) this.sessionChanged = new AbortController()
    this.current = {
      session: this.current.session + (isSession ? 1 : 0),
      view: isSession ? 0 : this.current.view + 1,
      signal: this.changed.signal,
      sessionSignal: this.sessionChanged.signal,
    }
    previous.abort()
    if (isSession) previousSession.abort()
    for (const [kind, waiting] of this.waiting) {
      if (this.isSessionWork(kind) && !isSession) continue
      this.waiting.delete(kind)
      if (this.running.get(kind) === waiting.work) this.running.delete(kind)
      waiting.discard()
    }
    this.clearBodies()
  }

  clearBodies(): void {
    this.bodyScope = null
    const waiting = this.bodyWaiting
    this.bodyWaiting = []
    for (const work of waiting) work.discard()
  }

  beginBodies(owner: Owner, key: string): void {
    if (!this.isCurrent(owner)) return
    if (this.bodyScope?.owner === owner && this.bodyScope.key === key) return
    this.clearBodies()
    this.bodyScope = { owner, key }
  }

  runBody<T>(owner: Owner, key: string, task: () => Promise<T>): Promise<T | undefined> {
    const scope = this.bodyScope
    if (!this.isCurrent(owner) || scope?.owner !== owner || scope.key !== key) {
      return Promise.resolve(undefined)
    }

    return new Promise<T | undefined>((resolve, reject) => {
      const work: BodyWork = {
        scope,
        discard: () => resolve(undefined),
        start: () => {
          const finish = () => {
            this.bodyRunning.delete(work)
            this.startBodies()
          }
          void Promise.resolve()
            .then(() => this.bodyScope === scope && this.isCurrent(owner) ? task() : undefined)
            .then(
              value => { finish(); resolve(value) },
              error => { finish(); reject(error) },
            )
        },
      }
      this.bodyWaiting.push(work)
      if (this.bodyWaiting.length === 1 && this.bodyRunning.size >= this.capacity * this.bodyCapacity) {
        this.onWaiting('body')
      }
      this.startBodies()
    })
  }

  private startBodies(): void {
    while (this.bodyRunning.size < this.capacity * this.bodyCapacity) {
      const inScope = [...this.bodyRunning].filter(work => work.scope === this.bodyScope).length
      if (inScope >= this.bodyCapacity) return
      const work = this.bodyWaiting.shift()
      if (!work) return
      if (work.scope !== this.bodyScope || !this.isCurrent(work.scope.owner)) {
        work.discard()
        continue
      }
      this.bodyRunning.add(work)
      work.start()
    }
  }

  busy(kind: Kind): boolean {
    const work = this.running.get(kind)
    return work !== undefined && this.owns(kind, work.owner)
  }

  private owns(kind: Kind, owner: Owner): boolean {
    return this.isSessionWork(kind) ? this.isSession(owner) : this.isCurrent(owner)
  }

  private isSessionWork(kind: Kind): boolean {
    return kind === 'session' || kind === 'pane-close' || kind === 'pane-cleanup'
  }

  async waitForPaneCloses(owner: Owner): Promise<boolean> {
    while (this.isSession(owner)) {
      const closing = ['pane-close', 'pane-cleanup'] as const
      const pending = closing.flatMap(kind => [
        ...(this.retained.get(kind) ?? []),
        ...(this.waiting.has(kind) ? [this.waiting.get(kind)!.work] : []),
      ])
      if (pending.length === 0) return true
      this.onWaiting('pane-close')
      await this.untilSessionChanged(owner, Promise.allSettled(pending.map(work => work.settled)))
    }
    return false
  }

  untilChanged<T>(owner: Owner, work: Promise<T>): Promise<T | null> {
    return this.untilRevoked(this.isCurrent(owner), owner.signal, work)
  }

  untilSessionChanged<T>(owner: Owner, work: Promise<T>): Promise<T | null> {
    return this.untilRevoked(this.isSession(owner), owner.sessionSignal, work)
  }

  private async untilRevoked<T>(
    isCurrent: boolean,
    signal: AbortSignal,
    work: Promise<T>,
  ): Promise<T | null> {
    if (!isCurrent) {
      // A caller may already have dispatched this work. Observe its rejection
      // even when its authority ended before the wait was installed.
      void work.catch(() => undefined)
      return null
    }

    return new Promise<T | null>((resolve, reject) => {
      const changed = () => resolve(null)
      signal.addEventListener('abort', changed, { once: true })
      void work.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', changed)
      })
    })
  }

  run<T>(
    kind: Kind,
    owner: Owner,
    task: () => Promise<T>,
    waitForCompletion = false,
  ): Promise<T | null> {
    if (!this.owns(kind, owner)) return Promise.resolve(null)

    const existing = this.running.get(kind)
    if (existing && this.owns(kind, existing.owner)) {
      return (waitForCompletion ? existing.settled : existing.result) as Promise<T | null>
    }

    const retained = this.retained.get(kind) ?? new Set<Work>()
    this.retained.set(kind, retained)

    const work: Work = {
      owner, result: Promise.resolve(null), settled: Promise.resolve(null),
    }
    this.running.set(kind, work)
    let start = () => {}
    let discard = () => {}
    const pending = new Promise<T | null>((resolve, reject) => {
      discard = () => resolve(null)
      start = () => {
        retained.add(work)
        const finish = () => {
          retained.delete(work)
          if (this.running.get(kind) === work) this.running.delete(kind)
          const waiting = this.waiting.get(kind)
          if (waiting && retained.size < this.capacity) {
            this.waiting.delete(kind)
            waiting.start()
          }
        }
        void Promise.resolve()
          .then(() => this.owns(kind, owner) ? task() : null)
          .then(
            value => { finish(); resolve(value) },
            error => { finish(); reject(error) },
          )
      }
    })
    work.settled = pending
    work.result = this.isSessionWork(kind)
      ? this.untilSessionChanged(owner, pending)
      : this.untilChanged(owner, pending)
    void work.result.catch(() => undefined)
    if (retained.size < this.capacity) start()
    else {
      this.waiting.set(kind, { work, start, discard })
      this.onWaiting(kind)
    }
    return (waitForCompletion ? pending : work.result) as Promise<T | null>
  }
}
