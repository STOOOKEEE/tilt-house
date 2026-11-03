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

const FALLBACK: DealerLook = {
  skin: '#d6a37e',
  shirt: '#ececec',
  vest: '#2f3b33',
  hair: '#3a2a1e',
  hat: 'none',
  accent: '#f0715f',
}

export function dealerLook(id: string): DealerLook {
  return LOOKS[id] ?? FALLBACK
}
