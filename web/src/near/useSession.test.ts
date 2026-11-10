import { describe, expect, it } from 'vitest'
import { SessionError } from './session-client'
import { closedByServer } from './useSession'

describe('closedByServer', () => {
  it('recognizes the server closing the session, as the client reports it', () => {
    expect(closedByServer(new SessionError('session server: session is closing or closed', 409))).toBe(true)
    expect(closedByServer(new SessionError('session server: session not opened on chain yet', 409))).toBe(false)
    expect(closedByServer(new Error('session is closing or closed'))).toBe(false)
  })
})
