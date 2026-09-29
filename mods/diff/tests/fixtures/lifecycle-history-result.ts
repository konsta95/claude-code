type Event =
  | { type: 'request'; id: number; owner?: number }
  | { type: 'view' }
  | { type: 'session' }
  | { type: 'resolve'; id: number }
  | { type: 'reject'; id: number }

type Job = {
  id: number
  authority: number
  state: 'running' | 'queued' | 'settled' | 'discarded'
  callers: number[]
}

/**
 * Reference contract for one kind of work, with a settled event loop between
 * events. An authority change ends ordinary waits; admitted dependencies keep
 * their slots and physical waits until completion. Equivalent current requests
 * share work. Only the latest authority's queued work remains eligible.
 * This model says nothing about pane placement or work between dispatch turns.
 */
export function lifecycleHistoryResult(
  history: readonly Event[],
  scope: 'view' | 'session',
  physical: boolean,
  capacity: number,
) {
  const authorities = [0]
  const jobs: Job[] = []
  const outcomes: Record<number, string> = {}
  const started: number[] = []
  let authority = 0

  for (const event of history) {
    if (event.type === 'view' || event.type === 'session') {
      if (scope === 'view' || event.type === 'session') authority += 1
      authorities.push(authority)
      for (const job of jobs) {
        if (job.authority === authority) continue
        if (job.state === 'queued') job.state = 'discarded'
        for (const id of job.callers) {
          if (outcomes[id] === 'pending' && (!physical || job.state === 'discarded')) {
            outcomes[id] = 'cancelled'
          }
        }
      }
    } else if (event.type === 'request') {
      const requested = authorities[event.owner ?? authorities.length - 1]
      if (requested !== authority) {
        outcomes[event.id] = 'cancelled'
        continue
      }
      outcomes[event.id] = 'pending'
      const existing = jobs.find(job => job.authority === authority &&
        (job.state === 'running' || job.state === 'queued'))
      if (existing) existing.callers.push(event.id)
      else {
        const state = jobs.filter(job => job.state === 'running').length < capacity
          ? 'running' : 'queued'
        jobs.push({ id: event.id, authority, state, callers: [event.id] })
        if (state === 'running') started.push(event.id)
      }
    } else {
      const job = jobs.find(item => item.id === event.id && item.state === 'running')
      if (!job) throw new Error(`history completes an unstarted job: ${event.id}`)
      job.state = 'settled'
      for (const id of job.callers) {
        if (outcomes[id] === 'pending') outcomes[id] = event.type === 'resolve'
          ? `value:${event.id}` : `error:fault:${event.id}`
      }
      const waiting = jobs.find(item => item.state === 'queued' && item.authority === authority)
      if (waiting) {
        waiting.state = 'running'
        started.push(waiting.id)
      }
    }
  }

  return {
    started,
    outcomes,
    busy: jobs.some(job => job.authority === authority &&
      (job.state === 'running' || job.state === 'queued')),
    running: jobs.filter(job => job.state === 'running').map(job => job.id),
    owners: authorities.length,
  }
}
