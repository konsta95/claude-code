import { lifecycleHistoryResult } from './lifecycle-history-result.js'

type Event = Parameters<typeof lifecycleHistoryResult>[0][number]

export function lifecycleSequence(scope: 'view' | 'session', physical: boolean, seed: number): Event[] {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  const history: Event[] = [
    { type: 'request', id: 0 }, { type: 'session' },
    { type: 'request', id: 1 }, { type: 'session' },
    { type: 'request', id: 2 }, { type: 'session' },
    { type: 'request', id: 3 }, { type: 'resolve', id: 0 },
  ]
  let id = 4
  for (let step = 0; step < 48; step += 1) {
    const expected = lifecycleHistoryResult(history, scope, physical, 2)
    const choice = next() % 7
    if (choice === 0) history.push({ type: 'view' })
    else if (choice === 1) history.push({ type: 'session' })
    else if (choice === 4) history.push({ type: 'request', id: id++, owner: next() % expected.owners })
    else if (choice >= 5 && expected.running.length > 0) {
      history.push({ type: choice === 5 ? 'resolve' : 'reject', id: expected.running[next() % expected.running.length]! })
    } else history.push({ type: 'request', id: id++ })
  }
  for (;;) {
    const expected = lifecycleHistoryResult(history, scope, physical, 2)
    if (expected.running.length === 0) return history
    history.push({ type: next() % 2 === 0 ? 'resolve' : 'reject', id: expected.running[0]! })
  }
}
