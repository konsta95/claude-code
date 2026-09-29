import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { lifecycleHistories } from './fixtures/lifecycle-histories.js'
import { lifecycleHistoryResult } from './fixtures/lifecycle-history-result.js'
import { lifecycleSequence } from './fixtures/lifecycle-sequence.js'
import { lifecycleTrial } from './fixtures/lifecycle-trial.js'

tier('builtin')

describe('lifecycle', () => {
  test('the bounded history generator covers each permitted event order', () => {
    expect(lifecycleHistories('session', 0).map(events => events.map(event =>
      event.type === 'session' ? 'change' : `${event.type}:${'id' in event ? event.id : ''}`,
    ).join(','))).toEqual([
      'request:0,change,request:1,resolve:0,resolve:1',
      'request:0,change,request:1,resolve:1,resolve:0',
      'request:0,change,resolve:0,request:1,resolve:1',
      'request:0,resolve:0,change,request:1,resolve:1',
    ])
  })

  for (const scope of ['view', 'session'] as const) {
    const kinds = scope === 'view'
      ? ['probe', 'read', 'refresh', 'auto', 'head'] as const
      : ['session', 'pane-close', 'pane-cleanup'] as const
    for (const kind of kinds) {
      for (const physical of [false, true]) {
        for (const change of ['view', 'session'] as const) {
          test(`${kind}, physical=${physical}, ${change}: bounded result model`, async (_$, on) => {
            const clock = mock.clock(on)
            for (let failures = 0; failures < 4; failures += 1) {
              for (const history of lifecycleHistories(change, failures)) {
                // The second call may share the first job when its session did
                // not change. Complete only jobs that were actually admitted
                // by the independent model; a coalesced task never starts.
                const admitted: typeof history = []
                for (const event of history) {
                  const expected = lifecycleHistoryResult(admitted, scope, physical, 2)
                  if ((event.type === 'resolve' || event.type === 'reject') && !expected.running.includes(event.id)) continue
                  admitted.push(event)
                }
                await lifecycleTrial(clock, kind, scope, physical, admitted)
              }
            }
          })
        }
      }
    }
    for (const physical of [false, true]) {
      for (const seed of [0x15d, 0x94847, 0x91870, 0x01a0e7e9]) {
        test(`${scope}, physical=${physical}, seed=${seed}: retained work and faults`, async (_$, on) => {
          await lifecycleTrial(mock.clock(on), scope === 'view' ? 'read' : 'session', scope,
            physical, lifecycleSequence(scope, physical, seed))
        })
      }
    }
  }
})
