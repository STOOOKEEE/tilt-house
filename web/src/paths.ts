import type { DealerView } from './near/views'

/** The page that plays a table: poker tables have their own room, every other game the casino table. */
export function tablePath(dealer: Pick<DealerView, 'id' | 'game'>): string {
  const id = encodeURIComponent(dealer.id)
  return dealer.game === 'poker' ? `/poker/${id}` : `/table/${id}`
}
