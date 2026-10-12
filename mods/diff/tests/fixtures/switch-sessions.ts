import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { usageAt } from './usage-at.js'

/**
 * Models the observed host boundary: a successful switch ends the old session
 * before changing its ID; a command that never calls commit has no transition.
 */
export function switchSessions(on: On, drive: Engine, clock?: Pick<MockClock, 'now'>) {
  let id = 'fixture-session-0'
  let generation = 0
  let startedAt = clock?.now() ?? 0
  on('session.id', () => ({ value: id }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  if (clock) on('session.usage', () => ({ value: usageAt(startedAt) }))

  return async (reason: 'clear' | 'resume') => {
    await drive.session.end({ reason, sessionId: id, resume: { id } })
    id = `fixture-session-${++generation}`
    if (clock) startedAt = clock.now()
    return {}
  }
}
