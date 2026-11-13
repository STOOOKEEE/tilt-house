import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MOCK_PARAMS,
  dayLabel,
  formatParam,
  getFloorDay,
  getTiltSnapshot,
  mockTilt,
  parseDay,
  parseTiltHourUntil,
  parseTiltLog,
  parseTiltParams,
  parseTiltSim,
  parseTiltState,
  tiltHourProgressBp,
  windowSecsLeft,
} from './tilt'
import { record, str } from './views'
import tiltSimJson from '../../public/tilt-sim.json?raw'

const NOW = 1_763_030_000
const ns = (secs: number) => `${secs}000000000`

const STATE = {
  total_supply: '1000000000000000',
  treasury: '600000000000000',
  circulating: '5200000000',
  welcome_remaining: '199999000000000',
  welcome_claims: 1,
  minted_total: '1000005200000000',
  burned_total: '0',
  today: 20_405,
  last_reported_day: null,
  streak: 2,
  longest_streak: 5,
  longest_streak_day: 20_400,
  tilt_hour: { round: 3, burned: '2500000000', burners: 2, window_end_ns: ns(NOW + 600), triggers: 1, last_started_ns: null },
  log_next_seq: 7,
}

describe('parseTiltState', () => {
  it('reads get_state', () => {
    const s = parseTiltState(STATE)
    expect(s).toMatchObject({ streak: 2, longest_streak: 5, last_reported_day: null, longest_streak_day: 20_400 })
    expect(s.tilt_hour).toMatchObject({ burned: '2500000000', burners: 2, last_started_ns: null })
  })

  it('fails closed on numbers for amounts and timestamps, or a missing field', () => {
    expect(() => parseTiltState({ ...STATE, treasury: 6e14 })).toThrow(/treasury/)
    expect(() => parseTiltState({ ...STATE, tilt_hour: { ...STATE.tilt_hour, window_end_ns: NOW } })).toThrow(/window_end_ns/)
    const { streak: _, ...noStreak } = STATE
    expect(() => parseTiltState(noStreak)).toThrow(/streak/)
  })
})

describe('parseTiltLog', () => {
  const entry = { seq: 4, kind: 'burn', reason: 'tilt_hour', account: 'bob.testnet', amount: '500000000', day: 20_405, timestamp_ns: ns(NOW) }

  it('reads mint, burn, streak and tilt_hour entries', () => {
    const log = parseTiltLog([entry, { ...entry, seq: 5, kind: 'streak', reason: 'reset', account: null, amount: '0' }])
    expect(log.map((e) => [e.kind, e.reason, e.account])).toEqual([
      ['burn', 'tilt_hour', 'bob.testnet'],
      ['streak', 'reset', null],
    ])
  })

  it('refuses an unknown kind or a negative amount', () => {
    expect(() => parseTiltLog([{ ...entry, kind: 'airdrop' }])).toThrow(/kind/)
    expect(() => parseTiltLog([{ ...entry, amount: '-1' }])).toThrow(/amount/)
  })
})

describe('parseTiltParams and formatParam', () => {
  it('keeps every parameter and shows it in its unit', () => {
    const params = parseTiltParams({ ...MOCK_PARAMS, welcome_daily_claims: '500' })
    expect(Object.keys(params)).toHaveLength(Object.keys(MOCK_PARAMS).length)
    expect(formatParam('tilt_hour_amount', params.tilt_hour_amount)).toBe('500.00 TILT')
    expect(formatParam('burn_bp', 100)).toBe('1.00%')
    expect(formatParam('tilt_hour_window_secs', 3_600)).toBe('60 min')
    expect(formatParam('launch_day', 20_405)).toBe(dayLabel(20_405))
    expect(formatParam('floor', 'floor.tilthouse.testnet')).toBe('floor.tilthouse.testnet')
    // A count sent as a string stays a count, not a TILT amount.
    expect(formatParam('welcome_daily_claims', params.welcome_daily_claims)).toBe('500')
  })

  it('refuses a parameter that is neither a string nor an integer', () => {
    expect(() => parseTiltParams({ burn_bp: 1.5 })).toThrow(/burn_bp/)
  })
})

describe('the USD floor day and Tilt Hour', () => {
  it('reads get_day: signed net, players largest first, null for no day', () => {
    const day = parseDay({
      day: 20_405,
      closed: false,
      players_net: '-3250000',
      wagered: '84000000',
      players: [{ account_id: 'alice.testnet', wagered: '60000000', net: '-5000000' }],
    })
    expect(day).toMatchObject({ players_net: '-3250000', players: [{ account_id: 'alice.testnet', net: '-5000000' }] })
    expect(parseDay(null)).toBeNull()
    expect(() => parseDay({ day: 1, closed: false, players_net: -3, wagered: '0', players: [] })).toThrow(/players_net/)
  })

  it('reads tilt_hour_until, 0 on a floor without it', () => {
    expect(parseTiltHourUntil({ seats: [], tilt_hour_until: NOW + 60 })).toBe(NOW + 60)
    expect(parseTiltHourUntil({ seats: [] })).toBe(0)
    expect(() => parseTiltHourUntil({ tilt_hour_until: '5' })).toThrow(/tilt_hour_until/)
  })

  it('measures the burn window against the threshold', () => {
    const hour = parseTiltState(STATE).tilt_hour
    expect(windowSecsLeft(hour, NOW)).toBe(600)
    expect(tiltHourProgressBp(hour, 10_000_000_000n, NOW)).toBe(2_500)
    expect(tiltHourProgressBp({ ...hour, burned: '20000000000' }, 10_000_000_000n, NOW)).toBe(10_000)
    // Window closed: what burned in it no longer counts.
    expect(windowSecsLeft(hour, NOW + 601)).toBe(0)
    expect(tiltHourProgressBp(hour, 10_000_000_000n, NOW + 601)).toBe(0)
    expect(tiltHourProgressBp({ ...hour, window_end_ns: '0' }, 10_000_000_000n, NOW)).toBe(0)
  })
})

describe('parseTiltSim', () => {
  const day = { day: 1, supply: '1000', treasury: '600', minted: '5', burned: '0', streak: 1, players_net: '-20', tilt_hours: 0 }

  it('reads every scenario', () => {
    const sim = parseTiltSim({ params: {}, days: 60, scenarios: { quiet: { description: 'q', series: [day] }, busy: { description: 'b', series: [] } } })
    expect(sim.scenarios.map((s) => s.id)).toEqual(['quiet', 'busy'])
    expect(sim.scenarios[0].series[0]).toEqual(day)
  })

  it('reads the file the sim writes', () => {
    const sim = parseTiltSim(JSON.parse(tiltSimJson))
    expect(sim.days).toBe(60)
    expect(sim.scenarios.map((s) => s.id).sort()).toEqual(['busy', 'hot-streak', 'quiet', 'whales'])
    for (const s of sim.scenarios) expect(s.series).toHaveLength(60)
  })

  it('refuses no scenario or a float amount', () => {
    expect(() => parseTiltSim({ days: 60, scenarios: {} })).toThrow(/scenario/)
    const bad = { days: 60, scenarios: { quiet: { description: 'q', series: [{ ...day, supply: 1.5 }] } } }
    expect(() => parseTiltSim(bad)).toThrow(/supply/)
  })
})

describe('RPC fallbacks', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** The view method and args of a stubbed `call_function` request. */
  function viewRequest(init: { body: string }): { method: string; args: unknown } {
    const params = record(record(JSON.parse(init.body), 'request').params, 'request.params')
    return { method: str(params.method_name, 'method_name'), args: JSON.parse(atob(str(params.args_base64, 'args_base64'))) }
  }

  /** Answers each view by method name, like the RPC: a result's bytes, a contract error or an RPC error. */
  function stubRpc(reply: (method: string) => { result: unknown } | { contractError: string } | { rpcError: string }) {
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const r = reply(viewRequest(init).method)
      const body =
        'rpcError' in r
          ? { error: { name: 'HANDLER_ERROR', cause: { name: r.rpcError } } }
          : 'contractError' in r
            ? { result: { error: r.contractError } }
            : { result: { result: [...new TextEncoder().encode(JSON.stringify(r.result))] } }
      return new Response(JSON.stringify(body))
    })
  }

  it('shows the mock while the token account does not exist, and fails on anything else', async () => {
    stubRpc(() => ({ rpcError: 'UNKNOWN_ACCOUNT' }))
    await expect(getTiltSnapshot('rpc', 'tilt.tilthouse.testnet', NOW)).resolves.toMatchObject({ mock: true })
    stubRpc(() => ({ rpcError: 'TIMEOUT_ERROR' }))
    await expect(getTiltSnapshot('rpc', 'tilt.tilthouse.testnet', NOW)).rejects.toThrow(/TIMEOUT/)
  })

  it('reads the newest 50 log entries once deployed', async () => {
    const asked: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const { method, args } = viewRequest(init)
      if (method === 'get_log') asked.push(args)
      const result = method === 'get_state' ? { ...STATE, log_next_seq: 80 } : method === 'get_params' ? MOCK_PARAMS : []
      return new Response(JSON.stringify({ result: { result: [...new TextEncoder().encode(JSON.stringify(result))] } }))
    })
    await expect(getTiltSnapshot('rpc', 'tilt.tilthouse.testnet', NOW)).resolves.toMatchObject({ mock: false, log: [] })
    expect(asked).toEqual([{ from: 30, limit: 50 }])
  })

  it('mocks the day while the USD floor has no get_day, keeping the real Tilt Hour', async () => {
    stubRpc((method) =>
      method === 'get_day' ? { contractError: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' } : { result: { tilt_hour_until: NOW + 10 } },
    )
    await expect(getFloorDay('rpc', 'floor.tilthouse.testnet', NOW)).resolves.toMatchObject({ mock: true, tiltHourUntil: NOW + 10 })
    stubRpc((method) => (method === 'get_day' ? { result: null } : { result: {} }))
    await expect(getFloorDay('rpc', 'floor.tilthouse.testnet', NOW)).resolves.toEqual({ today: null, tiltHourUntil: 0, mock: false })
  })

  it('builds a mock that parses like the real views', () => {
    const mock = mockTilt(NOW)
    expect(parseTiltState(JSON.parse(JSON.stringify(mock.state)))).toEqual(mock.state)
    expect(parseTiltLog(JSON.parse(JSON.stringify(mock.log)))).toEqual(mock.log)
  })
})
