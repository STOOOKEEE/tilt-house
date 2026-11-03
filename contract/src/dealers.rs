//! Dealers: each one is a table (one game) backed by its own LP pool, priced by
//! `core_rules::reprice` from the last hour of its table.

use core_rules::dealer_rules::{CAUTIOUS, GREEDY, PROMOTER};
use core_rules::{worst_case_multiple, Game, Offer, Pool, Reason, Stats, Temperament};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::{env, near, require, AccountId};

use crate::views::to_json;
use crate::{fail, mt, now, House, HouseExt, HISTORY_PER_DEALER, MIN_BET};

/// Stats buckets: 6 × 10 min = the last hour (same as the simulator).
const BUCKET_SECS: u64 = 600;
const BUCKETS: usize = 6;
const MAX_ID_LEN: usize = 16;
const MAX_NAME_LEN: usize = 32;

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default)]
pub struct Bucket {
    epoch: u64,
    bets: u32,
    volume: u128,
    player_net: i128,
    inflow: i128,
}

// Plain borsh derives: core types carry no `BorshSchema` for the contract ABI.
#[derive(Clone, BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Dealer {
    pub id: String,
    pub name: String,
    pub game: Game,
    pub temperament: String,
    pub traits: Temperament,
    pub account: AccountId,
    pub pool: Pool,
    pub offer: Offer,
    pub repriced_at: u64,
    /// Last `core::Pool::is_open` seen, to log bust / reopen transitions.
    pub open: bool,
    buckets: [Bucket; BUCKETS],
    /// Time of the last settled bet (or of the dealer's creation).
    last_bet: u64,
    /// Entries ever logged; the next entry's seq.
    pub log_len: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LogKind {
    Reprice,
    Boost,
    Bust,
    Reopen,
    Invest,
    Divest,
}

impl LogKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::Reprice => "reprice",
            Self::Boost => "boost",
            Self::Bust => "bust",
            Self::Reopen => "reopen",
            Self::Invest => "invest",
            Self::Divest => "divest",
        }
    }
}

/// One line of a dealer's log, with the offer in force at that time.
// Plain borsh derives: core types carry no `BorshSchema` for the contract ABI.
#[derive(Clone, BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct LogEntry {
    pub seq: u64,
    pub t: u64,
    pub kind: LogKind,
    pub reason: Reason,
    pub rake_bp: u16,
    pub max_bet: u128,
    pub boost_until: u64,
    pub account_id: Option<AccountId>,
    /// Invest / divest: money in or out. Bust: what the pool needs to reopen.
    pub amount: u128,
}

pub fn temperament_traits(name: &str) -> Temperament {
    match name {
        "greedy" => GREEDY,
        "promoter" => PROMOTER,
        "cautious" => CAUTIOUS,
        _ => fail("temperament must be greedy, promoter or cautious"),
    }
}

fn parse_game(name: &str) -> Game {
    serde_json::from_value(Value::String(name.to_string()))
        .unwrap_or_else(|_| fail("game must be dice, roulette or blackjack"))
}

fn valid_id(id: &str) -> bool {
    (2..=MAX_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Signed amount for stats; real amounts are far below `i128::MAX`.
fn signed(amount: u128) -> i128 {
    i128::try_from(amount).unwrap_or(i128::MAX)
}

impl Dealer {
    fn bucket(&mut self, now: u64) -> &mut Bucket {
        let epoch = now / BUCKET_SECS;
        let bucket = &mut self.buckets[(epoch % BUCKETS as u64) as usize];
        if bucket.epoch != epoch {
            *bucket = Bucket {
                epoch,
                ..Bucket::default()
            };
        }
        bucket
    }

    /// The last hour, from the buckets still inside it.
    pub fn stats(&self, now: u64) -> Stats {
        let epoch = now / BUCKET_SECS;
        let mut stats = Stats {
            idle_secs: now.saturating_sub(self.last_bet),
            ..Stats::default()
        };
        for bucket in self
            .buckets
            .iter()
            .filter(|b| b.epoch + BUCKETS as u64 > epoch)
        {
            stats.bets_1h = stats.bets_1h.saturating_add(bucket.bets);
            stats.volume_1h = stats.volume_1h.saturating_add(bucket.volume);
            stats.player_net_1h = stats.player_net_1h.saturating_add(bucket.player_net);
            stats.inflow_1h = stats.inflow_1h.saturating_add(bucket.inflow);
        }
        stats
    }

    pub fn record_bet(&mut self, now: u64, wager: u128, payout: u128) {
        let bucket = self.bucket(now);
        bucket.bets = bucket.bets.saturating_add(1);
        bucket.volume = bucket.volume.saturating_add(wager);
        bucket.player_net = bucket
            .player_net
            .saturating_add(signed(payout) - signed(wager));
        self.last_bet = now;
    }

    pub fn record_flow(&mut self, now: u64, amount: i128) {
        let bucket = self.bucket(now);
        bucket.inflow = bucket.inflow.saturating_add(amount);
    }

    /// Biggest stake accepted now: the dealer's offer, never more than the free bankroll covers.
    pub fn max_bet(&self) -> u128 {
        self.offer
            .max_bet
            .min(self.pool.free() / worst_case_multiple(self.game))
    }

    pub fn is_open(&self) -> bool {
        self.pool.is_open(MIN_BET, self.game)
    }

    /// Free bankroll still missing to cover a minimum bet.
    pub fn needed_to_reopen(&self) -> u128 {
        MIN_BET
            .saturating_mul(worst_case_multiple(self.game))
            .saturating_sub(self.pool.free())
    }
}

#[near]
impl House {
    /// Owner only. The seed comes from the owner's in-contract balance and is minted as the
    /// owner's LP shares (design call 4: the house funds every dealer at launch).
    pub fn add_dealer(
        &mut self,
        id: String,
        name: String,
        game: String,
        temperament: String,
        dealer_account: AccountId,
        seed_amount: U128,
    ) {
        self.assert_owner();
        require!(valid_id(&id), "dealer id: 2-16 chars of a-z, 0-9, -");
        require!(
            !name.is_empty() && name.len() <= MAX_NAME_LEN,
            "dealer name: 1-32 bytes"
        );
        require!(!self.dealers.contains_key(&id), "dealer id already used");
        let game = parse_game(&game);
        let traits = temperament_traits(&temperament);
        let now = now();
        let owner = self.owner.clone();
        let mut dealer = Dealer {
            id: id.clone(),
            name,
            game,
            temperament,
            traits,
            account: dealer_account,
            pool: Pool::default(),
            offer: core_rules::reprice(game, &Pool::default(), &Stats::default(), &traits, now),
            repriced_at: now,
            open: false,
            buckets: [Bucket::default(); BUCKETS],
            last_bet: now,
            log_len: 0,
        };
        let mut minted = 0;
        if seed_amount.0 > 0 {
            self.debit(&owner, seed_amount.0);
            minted = dealer.pool.buy_shares(seed_amount.0);
            require!(minted > 0, "seed too small to buy a share");
            dealer.record_flow(now, signed(seed_amount.0));
            self.set_shares(&id, &owner, minted);
        }
        // Launch state, not a transition: no bust/reopen line. The offer is priced on the seeded
        // pool, like a first reprice.
        dealer.open = dealer.is_open();
        dealer.offer = core_rules::reprice(game, &dealer.pool, &dealer.stats(now), &traits, now);
        if minted > 0 {
            self.log(
                &mut dealer,
                LogKind::Invest,
                Some(owner.clone()),
                seed_amount.0,
            );
            mt::emit_mint(&owner, &id, minted);
        }
        self.dealers.insert(id.clone(), dealer);
        self.dealer_ids.push(id);
    }

    /// Only the dealer's own account may reprice its table; `core::reprice` keeps the offer in
    /// bounds whatever the inputs.
    /// Returns the new core `Offer`.
    pub fn reprice(&mut self, dealer_id: String) -> Value {
        let mut dealer = self.dealer(&dealer_id);
        require!(
            env::predecessor_account_id() == dealer.account,
            "only the dealer's account can reprice"
        );
        let now = now();
        let offer = core_rules::reprice(
            dealer.game,
            &dealer.pool,
            &dealer.stats(now),
            &dealer.traits,
            now,
        );
        let boost_starts = offer.boost_until > now && dealer.offer.boost_until <= now;
        let kind = if boost_starts {
            Some(LogKind::Boost)
        } else if offer.reason != dealer.offer.reason {
            Some(LogKind::Reprice)
        } else {
            None
        };
        dealer.offer = offer;
        dealer.repriced_at = now;
        if let Some(kind) = kind {
            self.log(&mut dealer, kind, None, 0);
        }
        self.dealers.insert(dealer_id, dealer);
        to_json(&offer)
    }

    /// Buys LP shares with the caller's in-contract balance. Returns the shares minted.
    pub fn invest(&mut self, dealer_id: String, amount: U128) -> U128 {
        let account = env::predecessor_account_id();
        self.debit(&account, amount.0);
        U128(self.invest_for(&account, &dealer_id, amount.0))
    }

    /// Sells LP shares at the sell price (free bankroll only) into the caller's balance.
    pub fn divest(&mut self, dealer_id: String, shares: U128) -> U128 {
        let account = env::predecessor_account_id();
        let held = self.shares_of(&dealer_id, &account);
        require!(shares.0 <= held, "not enough shares");
        let mut dealer = self.dealer(&dealer_id);
        let payout = dealer
            .pool
            .sell_shares(shares.0)
            .unwrap_or_else(|e| fail(&e.to_string()));
        self.set_shares(&dealer_id, &account, held - shares.0);
        dealer.record_flow(now(), -signed(payout));
        self.log(&mut dealer, LogKind::Divest, Some(account.clone()), payout);
        self.refresh_open(&mut dealer);
        self.dealers.insert(dealer_id.clone(), dealer);
        self.credit(&account, payout);
        mt::emit_burn(&account, &dealer_id, shares.0);
        U128(payout)
    }
}

impl House {
    pub(crate) fn dealer(&self, id: &str) -> Dealer {
        self.dealers
            .get(id)
            .cloned()
            .unwrap_or_else(|| fail("unknown dealer"))
    }

    /// Adds `amount` (already taken from the investor) to the pool and mints its shares.
    pub(crate) fn invest_for(
        &mut self,
        account: &AccountId,
        dealer_id: &str,
        amount: u128,
    ) -> u128 {
        require!(amount > 0, "amount must be positive");
        let mut dealer = self.dealer(dealer_id);
        let minted = dealer.pool.buy_shares(amount);
        require!(minted > 0, "amount too small to buy a share");
        let held = self.shares_of(dealer_id, account);
        self.set_shares(dealer_id, account, held + minted);
        dealer.record_flow(now(), signed(amount));
        self.log(&mut dealer, LogKind::Invest, Some(account.clone()), amount);
        self.refresh_open(&mut dealer);
        self.dealers.insert(dealer_id.to_string(), dealer);
        mt::emit_mint(account, dealer_id, minted);
        minted
    }

    /// Logs a bust or a reopen when the pool crossed the "covers a minimum bet" line.
    pub(crate) fn refresh_open(&mut self, dealer: &mut Dealer) {
        let open = dealer.is_open();
        if open == dealer.open {
            return;
        }
        dealer.open = open;
        if open {
            self.log(dealer, LogKind::Reopen, None, 0);
        } else {
            let needed = dealer.needed_to_reopen();
            self.log(dealer, LogKind::Bust, None, needed);
        }
    }

    pub(crate) fn log(
        &mut self,
        dealer: &mut Dealer,
        kind: LogKind,
        account_id: Option<AccountId>,
        amount: u128,
    ) {
        let seq = dealer.log_len;
        let entry = LogEntry {
            seq,
            t: now(),
            kind,
            reason: dealer.offer.reason,
            rake_bp: dealer.offer.rake_bp,
            max_bet: dealer.max_bet(),
            boost_until: dealer.offer.boost_until,
            account_id,
            amount,
        };
        self.history
            .insert((dealer.id.clone(), seq % HISTORY_PER_DEALER), entry);
        dealer.log_len += 1;
    }
}
