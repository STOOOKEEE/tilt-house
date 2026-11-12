# Poker rules

No-limit Texas hold'em, 2–6 players, play money. The rules are pure Rust in `core/src/poker.rs`
(shared by the session server and every verifier); the bots are `core/src/poker_npc.rs`. The
server API is in `docs/poker-api.md`.

## Cards and deck

- A card is `0..52`: rank `i / 4` (0 = deuce … 12 = ace), suit `i % 4` (`c d h s`). JSON `"As"`,
  `"Td"`, `"7c"`; borsh one byte.
- Deck seed: `HMAC-SHA256(hand_seed, "tilt-house/poker-deck/v1" + ":" + seed_1 + ":" + … )`, the
  players' client seeds in increasing seat order (client seeds never contain `:`).
- Shuffle: start from the sorted deck, for `i` from 51 down to 1 swap `i` with `rng.below(i + 1)`,
  where `rng = Rng::new(deck_seed)` (xoshiro256\*\* seeded by splitmix64, `core/src/rng.rs`).
- Deal: one card at a time from the seat left of the button, twice round. With `n` players, deal
  position `p` holds `deck[p]` and `deck[p + n]`; the board is `deck[2n+1..2n+4]` (flop),
  `deck[2n+5]` (turn) and `deck[2n+7]` (river), the skipped cards being the burns.

## Fairness

The server commits `sha256(hand_seed)` before the players' client seeds for the hand are final, and
reveals `hand_seed` when the hand ends. Since every seed enters the deck, nobody can steer it: the
server cannot change its seed after the commitment, and the players chose theirs without knowing
it. Server-controlled seats (bots) must have seeds fixed before the commitment (the server uses
`<bot>-<hand>`), or the server could grind them. Revealing the seed reveals every card of the hand,
folded ones included.

## Betting

- Blinds: the seat after the button posts the small blind, the next the big blind. Heads-up the
  button posts the small blind, acts first before the flop and last after it.
- Before the flop the seat after the big blind acts first (heads-up: the button); after it, the
  first live seat after the button.
- Moves: fold, check, call, raise to an amount (a bet when nobody has bet), all in. The smallest
  bet is one big blind; the smallest raise adds the last full bet or raise of the street.
- A player may always go all in for less. An all-in short of a full raise does not reopen the
  betting to players who already acted: facing it, they may only call or fold, unless the total
  raised since their last action is a full raise.
- Nobody may raise when every opponent is all in. A short stack posts what it has; the others
  still call the full big blind.
- When at most one player can still bet, the remaining board is dealt and the hand goes to
  showdown.

## Hand ranking

Best five of the seven cards: straight flush, four of a kind, full house, flush, straight, three
of a kind, two pair, pair, high card. Kickers break ties within a category, suits never do. The
ace plays high or low in straights (`A-2-3-4-5`, the wheel, is the lowest); straights do not wrap
(`K-A-2-3-4` is not one).

## Settling a hand

1. Uncalled chips (the part of the largest commitment nobody matched) go back to their owner.
2. Pots by commitment level: the main pot holds every player's chips up to the smallest all-in of
   a player still in, each side pot the next layer; a pot is contested by the players still in who
   reached its level.
3. Rake: `rake_bp` of the pot (rounded down), at most `rake_cap` per hand, and none if the hand
   ended before the flop ("no flop, no drop"). The hand's `rake_bp` is the lowest of its players'
   session tickets, so nobody pays more than the rake it accepted. The rake comes out of the main
   pot first.
4. Each pot goes to the best hand among its contenders; ties split evenly, odd chips one each to
   the first winners left of the button.

Each player gets `(put_in, won)`: chips that stayed in the pot and chips won after rake. Always
`Σ won + rake == Σ put_in`, and `won ≤ 6 × put_in` (`worst_case_payout(Game::Poker, ..)`).

## On chain and verification

Each hand becomes one session round per player dealt in (`Hand::round_for`): `bet` =
`Bet::Poker { table, hand }`, `stake` = `put_in`, `payout` = `won`, `outcome` =
`Outcome::Poker { hand_seed_hash, history_hash, seat, board }`. `history_hash` is
`sha256(borsh(HandHistory))`; the history (start, revealed seed, actions) replays the whole hand
(`replay_hand`), and `verify_poker_round` / `verify_poker_session` check a player's rounds against
the published histories.

## Bots

House bots are labeled at the table. They only fill empty seats while a human plays (up to four
players), and leave as soon as a human needs the seat. Their play (tight, loose or aggressive
from a starting-hand chart, then equity against pot odds) is described at the top of
`core/src/poker_npc.rs`.
