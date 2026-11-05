import type { DealerLook } from './types'

// Temperament shows at a glance: greedy dealers wear a gold visor and a dark vest, promoters a
// top hat and loud colors, the cautious one a muted beanie.
const LOOKS: Record<string, DealerLook> = {
  ada: { skin: '#e8b48a', shirt: '#f2efe6', vest: '#22262e', hair: '#2b1d14', hat: 'visor', accent: '#f0c26a' },
  bruno: { skin: '#a8714a', shirt: '#fff6d8', vest: '#d8336f', hair: '#1a1210', hat: 'top_hat', accent: '#ec6fae' },
  chloe: { skin: '#f3c9a6', shirt: '#dfe5e0', vest: '#4d5b52', hair: '#b8662f', hat: 'beanie', accent: '#7ccf8f' },
  dmitri: { skin: '#d9a17a', shirt: '#e9e4d6', vest: '#141418', hair: '#8a8a8a', hat: 'visor', accent: '#f0c26a' },
  eve: { skin: '#7a4a2e', shirt: '#fbfbf5', vest: '#6b2fd6', hair: '#120c0a', hat: 'top_hat', accent: '#ec6fae' },
}

/** Looks a player can pick for their own table; `open_table` accepts exactly these names. */
export const LOOK_PRESETS = ['gold-visor', 'top-hat', 'beanie', 'bare'] as const
export type LookPreset = (typeof LOOK_PRESETS)[number]

const PRESETS: Record<LookPreset, DealerLook> = {
  'gold-visor': { skin: '#c98f66', shirt: '#f4f0e4', vest: '#1c2028', hair: '#3a2416', hat: 'visor', accent: '#f0c26a' },
  'top-hat': { skin: '#8d5a3a', shirt: '#fff3d0', vest: '#c23a8a', hair: '#1a1210', hat: 'top_hat', accent: '#ec6fae' },
  beanie: { skin: '#f0c4a0', shirt: '#e2e8e2', vest: '#3f5a4c', hair: '#6b3e1e', hat: 'beanie', accent: '#7ccf8f' },
  bare: { skin: '#d6a37e', shirt: '#ececec', vest: '#2f3b33', hair: '#3a2a1e', hat: 'none', accent: '#f0715f' },
}

/** The preset that matches a temperament, for tables that did not pick one. */
const BY_TEMPERAMENT: Record<string, LookPreset> = { greedy: 'gold-visor', promoter: 'top-hat', cautious: 'beanie' }

export function isLookPreset(value: string): value is LookPreset {
  return LOOK_PRESETS.some((preset) => preset === value)
}

/** Launch dealers keep their own look; other tables wear their preset, else their temperament's. */
export function dealerLook(id: string, look: string | null = null, temperament = ''): DealerLook {
  const own = LOOKS[id]
  if (own) return own
  if (look !== null && isLookPreset(look)) return PRESETS[look]
  return PRESETS[BY_TEMPERAMENT[temperament] ?? 'bare']
}
