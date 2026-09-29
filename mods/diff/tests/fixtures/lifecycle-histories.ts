import type { lifecycleHistoryResult } from './lifecycle-history-result.js'

type Event = Parameters<typeof lifecycleHistoryResult>[0][number]

export function lifecycleHistories(change: 'view' | 'session', failures: number): Event[][] {
  const events: Event[] = [
    { type: 'request', id: 0 },
    { type: change },
    { type: 'request', id: 1 },
    { type: failures & 1 ? 'reject' : 'resolve', id: 0 },
    { type: failures & 2 ? 'reject' : 'resolve', id: 1 },
  ]
  const before = [[], [0], [1], [0], [2]]
  const histories: Event[][] = []
  const visit = (order: number[]) => {
    if (order.length === events.length) {
      histories.push(order.map(at => events[at]!))
      return
    }
    for (let at = 0; at < events.length; at += 1) {
      if (!order.includes(at) && before[at]!.every(required => order.includes(required))) {
        visit([...order, at])
      }
    }
  }
  visit([])
  return histories
}
