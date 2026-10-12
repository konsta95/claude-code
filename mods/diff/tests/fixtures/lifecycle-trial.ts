import type { MockClock } from 'claude-code/testing'
import { expect } from 'claude-code/testing'

import { Lifecycle } from '../../hooks/lifecycle.js'
import { lifecycleHistoryResult } from './lifecycle-history-result.js'

type Event = Parameters<typeof lifecycleHistoryResult>[0][number]

export async function lifecycleTrial(
  clock: MockClock,
  kind: Parameters<Lifecycle['run']>[0],
  scope: 'view' | 'session',
  physical: boolean,
  events: readonly Event[],
) {
  const lifecycle = new Lifecycle(2, () => {}, 1)
  const owners = [lifecycle.owner()]
  const gates = new Map<number, { resolve: (id: number) => void; reject: (error: Error) => void }>()
  const outcomes: Record<number, string> = {}
  const started: number[] = []
  const history: Event[] = []

  try {
    for (const event of events) {
      if (event.type === 'request') {
        outcomes[event.id] = 'pending'
        void lifecycle.run(kind, owners[event.owner ?? owners.length - 1]!, () => {
          started.push(event.id)
          return new Promise<number>((resolve, reject) => { gates.set(event.id, { resolve, reject }) })
        }, physical).then(
          value => { outcomes[event.id] = value === null ? 'cancelled' : `value:${value}` },
          error => { outcomes[event.id] = `error:${(error as Error).message}` },
        )
      } else if (event.type === 'view' || event.type === 'session') {
        lifecycle.advance(event.type === 'session')
        owners.push(lifecycle.owner())
      } else {
        const gate = gates.get(event.id)
        if (gate) {
          if (event.type === 'resolve') gate.resolve(event.id)
          else gate.reject(new Error(`fault:${event.id}`))
        }
      }
      history.push(event)
      await clock.settle()
      const expected = lifecycleHistoryResult(history, scope, physical, 2)
      expect({ started, outcomes, busy: lifecycle.busy(kind) }, JSON.stringify(history)).toEqual({
        started: expected.started, outcomes: expected.outcomes, busy: expected.busy,
      })
    }
  } finally {
    lifecycle.advance(true)
    for (const [id, gate] of gates) gate.resolve(id)
    await clock.settle()
  }
}
