//! Dealers: each one is a table (one game) backed by its own LP pool. NPC dealers and player
//! tables on autopilot are priced by `core_rules::reprice`; a player may also set its offer by
//! hand (`set_offer`, clamped by `core_rules::clamp_owner_offer`).

use core_rules::dealer_rules::{CAUTIOUS, GREEDY, PROMOTER};
use core_rules::floor::validate_table_name;
use core_rules::{
    can_set_temperament, clamp_owner_offer, keep_running_boost, validate_new_table,
    worst_case_multiple, Game, Offer, Pool, Reason, RivalOffer, Stats, Temperament, BP,
};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, require, AccountId};

use crate::views::to_json;
use crate::{
    emit, fail, mt, now, House, HouseExt, HISTORY_PER_DEALER, MAX_RETIRED_TABLES, MIN_BET,
};

/// Stats buckets: 6 × 10 min = the last hour (same as the simulator).
const BUCKET_SECS: u64 = 600;
const BUCKETS: usize = 6;
/// Ids starting with this are seat lease tokens.
pub const SEAT_TOKEN_PREFIX: &str = "seat-";
/// Dealer looks a player can pick (web/src/scene/looks.ts `LOOK_PRESETS`).
const LOOK_PRESETS: [&str; 4] = ["gold-visor", "top-hat", "beanie", "bare"];

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default)]
pub struct Bucket {
    epoch: u64,
    bets: u32,
    volume: u128,
    player_net: i128,
    inflow: i128,
    /// Sessions opened (gamblers who sat down).
    sessions: u32,
    /// Rent paid into the jackpot.
    rent: u128,
}

/// What the last hour adds to core `Stats` for the views.
#[derive(Clone, Copy, Default)]
pub struct HourExtra {
    pub gamblers: u32,
    pub rent: u128,
}

// Plain borsh derives: core types carry no `BorshSchema` for the contract ABI.
#[derive(Clone, BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Dealer {
    pub id: String,
    pub name: String,
    pub game: Game,
    pub look: Option<String>,
    /// NPC dealers are always on autopilot and bid rent through `rent_bid`.
    pub npc: bool,
    /// Holds the seat token; sets the offer, rent and temperament.
    pub controller: AccountId,
    /// On: the keeper reprices with `temperament`. Off: the controller's `set_offer` holds.
    pub autopilot: bool,
    pub temperament: String,
    pub traits: Temperament,
    pub temperament_changed_at: u64,
    pub pool: Pool,
    pub offer: Offer,
    pub repriced_at: u64,
    pub last_boost_at: u64,
    /// Last `core::Pool::is_open` seen, to log bust / reopen transitions.
    pub open: bool,
    /// Evicted dealers cannot bid before this time.
    pub cooldown_until: u64,
    pub open_sessions: u32,
    buckets: [Bucket; BUCKETS],
    /// Time of the last settled round (or of the dealer's creation).
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
    Opened,
    Seated,
    Evicted,
    Rent,
    Listed,
    Sold,
    Bought,
    Jackpot,
    Offer,
    Autopilot,
    Temperament,
    // v3, appended: older entries keep their borsh tags.
    Renamed,
    Retired,
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
            Self::Opened => "opened",
            Self::Seated => "seated",
            Self::Evicted => "evicted",
            Self::Rent => "rent",
            Self::Listed => "listed",
            Self::Sold => "sold",
            Self::Bought => "bought",
            Self::Jackpot => "jackpot",
            Self::Offer => "offer",
            Self::Autopilot => "autopilot",
            Self::Temperament => "temperament",
            Self::Renamed => "renamed",
            Self::Retired => "retired",
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
    /// Money involved (see `docs/contract-api.md`, history kinds).
    pub amount: u128,
    /// Eviction reason, seat token, temperament…
    pub detail: String,
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
        .unwrap_or_else(|_| fail("game must be dice, roulette, blackjack or poker"))
}

fn check_look(look: &str) {
    require!(
        LOOK_PRESETS.contains(&look),
        "look must be gold-visor, top-hat, beanie or bare"
    );
}

/// Signed amount for stats; real amounts are far below `i128::MAX`.
pub(crate) fn signed(amount: u128) -> i128 {
    i128::try_from(amount).unwrap_or(i128::MAX)
}

impl Dealer {
    fn new(
        id: String,
        name: String,
        game: Game,
        temperament: String,
        controller: AccountId,
        now: u64,
    ) -> Self {
        let traits = temperament_traits(&temperament);
        Self {
            id,
            name,
            game,
            look: None,
            npc: false,
            controller,
            autopilot: true,
            temperament,
            traits,
            temperament_changed_at: 0,
            pool: Pool::default(),
            offer: core_rules::reprice(
                game,
                &Pool::default(),
                &Stats::default(),
                &traits,
                &[],
                now,
            ),
            repriced_at: now,
            last_boost_at: 0,
            open: false,
            cooldown_until: 0,
            open_sessions: 0,
            buckets: [Bucket::default(); BUCKETS],
            last_bet: now,
            log_len: 0,
        }
    }

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

    fn live_buckets(&self, now: u64) -> impl Iterator<Item = &Bucket> {
        let epoch = now / BUCKET_SECS;
        self.buckets
            .iter()
            .filter(move |b| b.epoch + BUCKETS as u64 > epoch)
    }

    /// The last hour, from the buckets still inside it (`game_share_bp` is set by the caller).
    pub fn stats(&self, now: u64) -> Stats {
        let mut stats = Stats {
            idle_secs: now.saturating_sub(self.last_bet),
            ..Stats::default()
        };
        for bucket in self.live_buckets(now) {
            stats.bets_1h = stats.bets_1h.saturating_add(bucket.bets);
            stats.volume_1h = stats.volume_1h.saturating_add(bucket.volume);
            stats.player_net_1h = stats.player_net_1h.saturating_add(bucket.player_net);
            stats.inflow_1h = stats.inflow_1h.saturating_add(bucket.inflow);
        }
        stats
    }

    pub fn hour_extra(&self, now: u64) -> HourExtra {
        self.live_buckets(now)
            .fold(HourExtra::default(), |extra, bucket| HourExtra {
                gamblers: extra.gamblers.saturating_add(bucket.sessions),
                rent: extra.rent.saturating_add(bucket.rent),
            })
    }

    /// A batch of settled rounds.
    pub fn record_rounds(&mut self, now: u64, rounds: u32, wagered: u128, paid: u128) {
        let bucket = self.bucket(now);
        bucket.bets = bucket.bets.saturating_add(rounds);
        bucket.volume = bucket.volume.saturating_add(wagered);
        bucket.player_net = bucket
            .player_net
            .saturating_add(signed(paid) - signed(wagered));
        self.last_bet = now;
    }

    pub fn record_session(&mut self, now: u64) {
        let bucket = self.bucket(now);
        bucket.sessions = bucket.sessions.saturating_add(1);
    }

    pub fn record_rent(&mut self, now: u64, paid: u128) {
        let bucket = self.bucket(now);
        bucket.rent = bucket.rent.saturating_add(paid);
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
    #[allow(clippy::too_many_arguments)] // the JSON args of the call
    /// Owner only: an NPC dealer, off the floor. The seed comes from the owner's in-contract
    /// balance and is minted as the owner's LP shares (the house funds the launch dealers).
    pub fn add_dealer(
        &mut self,
        id: String,
        name: String,
        game: String,
        temperament: String,
        look: Option<String>,
        dealer_account: AccountId,
        seed_amount: U128,
    ) {
        self.assert_owner();
        if let Some(look) = &look {
            check_look(look);
        }
        self.check_new_id(
            &id,
            &name,
            seed_amount.0.max(core_rules::floor::MIN_TABLE_SEED),
        );
        let dealer = Dealer {
            npc: true,
            look,
            ..Dealer::new(
                id,
                name,
                parse_game(&game),
                temperament,
                dealer_account,
                now(),
            )
        };
        let owner = self.owner.clone();
        self.create_dealer(dealer, &owner, seed_amount.0);
    }

    /// Any player: opens a table from their balance (floor.md rule 4). The caller becomes its
    /// controller and founding LP; the table starts off the floor, on autopilot.
    pub fn open_table(
        &mut self,
        id: String,
        name: String,
        game: String,
        temperament: String,
        look: String,
        seed_amount: U128,
    ) {
        self.assert_not_npc();
        check_look(&look);
        self.check_new_id(&id, &name, seed_amount.0);
        let account = env::predecessor_account_id();
        let dealer = Dealer {
            look: Some(look),
            ..Dealer::new(
                id,
                name,
                parse_game(&game),
                temperament,
                account.clone(),
                now(),
            )
        };
        self.create_dealer(dealer, &account, seed_amount.0);
    }

    /// The controller sets the offer by hand; autopilot goes off. Returns the core `Offer`.
    pub fn set_offer(
        &mut self,
        dealer_id: String,
        rake_bp: u16,
        max_bet: U128,
        boost_secs: u64,
    ) -> Value {
        let mut dealer = self.controlled_dealer(&dealer_id);
        let now = now();
        self.settle_rent(&mut dealer, now);
        let asked = clamp_owner_offer(
            dealer.game,
            &dealer.pool,
            rake_bp,
            max_bet.0,
            boost_secs,
            dealer.last_boost_at,
            now,
        );
        let offer = keep_running_boost(asked, &dealer.offer, now);
        // Only a boost started now spends the hour's boost; a kept one was counted when it began.
        if offer.boost_until > now && offer.boost_until != dealer.offer.boost_until {
            dealer.last_boost_at = now;
        }
        dealer.offer = offer;
        dealer.repriced_at = now;
        dealer.autopilot = false;
        self.log(&mut dealer, LogKind::Offer, None, 0, String::new());
        emit_offer(&dealer);
        self.save_dealer(dealer);
        to_json(&offer)
    }

    /// `null`: manual pricing (the current offer stays). A temperament: autopilot with it.
    pub fn set_autopilot(&mut self, dealer_id: String, temperament: Option<String>) {
        let mut dealer = self.controlled_dealer(&dealer_id);
        require!(!dealer.npc, "NPC dealers are always on autopilot");
        let now = now();
        self.settle_rent(&mut dealer, now);
        if let Some(temperament) = temperament {
            if temperament != dealer.temperament {
                change_temperament(&mut dealer, temperament, now);
            }
            dealer.autopilot = true;
            self.apply_reprice(&mut dealer, now);
        } else {
            dealer.autopilot = false;
        }
        let detail = if dealer.autopilot {
            dealer.temperament.clone()
        } else {
            "manual".to_string()
        };
        self.log(&mut dealer, LogKind::Autopilot, None, 0, detail);
        self.save_dealer(dealer);
    }

    /// At most once an hour (`core::can_set_temperament`).
    pub fn set_temperament(&mut self, dealer_id: String, temperament: String) {
        let mut dealer = self.controlled_dealer(&dealer_id);
        require!(!dealer.npc, "NPC dealers keep their temperament");
        let now = now();
        change_temperament(&mut dealer, temperament, now);
        let detail = dealer.temperament.clone();
        self.log(&mut dealer, LogKind::Temperament, None, 0, detail);
        self.save_dealer(dealer);
    }

    /// The keeper or the controller reprices a table on autopilot; `core::reprice` keeps the
    /// offer in bounds whatever the inputs. Returns the new core `Offer`.
    pub fn reprice(&mut self, dealer_id: String) -> Value {
        let mut dealer = self.active_dealer(&dealer_id);
        self.assert_keeper_or_controller(&dealer);
        require!(dealer.autopilot, "the table is on manual pricing");
        let now = now();
        self.settle_rent(&mut dealer, now);
        self.apply_reprice(&mut dealer, now);
        let offer = dealer.offer;
        self.save_dealer(dealer);
        to_json(&offer)
    }

    /// Buys LP shares with the caller's in-contract balance. Returns the shares minted.
    pub fn invest(&mut self, dealer_id: String, amount: U128) -> U128 {
        self.assert_not_npc();
        let account = env::predecessor_account_id();
        self.debit(&account, amount.0);
        U128(self.invest_for(&account, &dealer_id, amount.0))
    }

    /// Sells LP shares at the sell price (free bankroll only) into the caller's balance.
    pub fn divest(&mut self, dealer_id: String, shares: U128) -> U128 {
        self.assert_not_npc();
        let account = env::predecessor_account_id();
        let held = self.shares_of(&dealer_id, &account);
        require!(shares.0 <= held, "not enough shares");
        let mut dealer = self.dealer(&dealer_id);
        let now = now();
        self.settle_rent(&mut dealer, now);
        let payout = dealer
            .pool
            .sell_shares(shares.0)
            .unwrap_or_else(|e| fail(&e.to_string()));
        self.set_shares(&dealer_id, &account, held - shares.0);
        dealer.record_flow(now, -signed(payout));
        self.log(
            &mut dealer,
            LogKind::Divest,
            Some(account.clone()),
            payout,
            String::new(),
        );
        self.save_dealer(dealer);
        self.credit(&account, payout);
        mt::emit_burn(&account, &dealer_id, shares.0);
        U128(payout)
    }

    /// The controller renames its table (same rules as an `open_table` name).
    pub fn set_table_name(&mut self, dealer_id: String, name: String) {
        let mut dealer = self.controlled_dealer(&dealer_id);
        validate_table_name(&name).unwrap_or_else(|e| fail(&e.to_string()));
        dealer.name = name.clone();
        self.log(&mut dealer, LogKind::Renamed, None, 0, name.clone());
        emit(
            "table_renamed",
            json!({ "dealer_id": dealer.id, "name": name }),
        );
        self.save_dealer(dealer);
    }

    /// The controller retires an off-floor table nobody else holds shares in: its own shares
    /// are paid out (the whole bankroll, nothing is reserved), the table leaves the lobby and
    /// the `MAX_DEALERS` count for good (`get_retired` still shows it). A bankroll left with no
    /// shares at all belongs to nobody and goes to the jackpot. Returns what the controller got.
    pub fn retire_table(&mut self, dealer_id: String) -> U128 {
        let mut dealer = self.controlled_dealer(&dealer_id);
        require!(
            self.floor.seat_of(&dealer_id).is_none(),
            "the table is on the floor"
        );
        require!(
            dealer.open_sessions == 0 && dealer.pool.reserved == 0 && dealer.pool.open_stakes == 0,
            "the table still has sessions to settle or reveal"
        );
        let controller = dealer.controller.clone();
        let held = self.shares_of(&dealer_id, &controller);
        require!(
            held == dealer.pool.shares,
            "other LPs still hold shares: they must divest first"
        );
        require!(
            self.retired_ids.len() < MAX_RETIRED_TABLES,
            "no room left for retired tables"
        );
        let now = now();
        let bankroll = dealer.pool.bankroll;
        dealer.pool.bankroll = 0;
        dealer.pool.shares = 0;
        dealer.open = false;
        dealer.record_flow(now, -signed(bankroll));
        let paid = if held > 0 {
            self.set_shares(&dealer_id, &controller, 0);
            self.credit(&controller, bankroll);
            mt::emit_burn(&controller, &dealer_id, held);
            bankroll
        } else {
            self.floor.jackpot = self
                .floor
                .jackpot
                .checked_add(bankroll)
                .unwrap_or_else(|| fail("jackpot overflow"));
            0
        };
        self.log(
            &mut dealer,
            LogKind::Retired,
            Some(controller.clone()),
            paid,
            String::new(),
        );
        emit(
            "table_retired",
            json!({
                "dealer_id": dealer_id,
                "controller": controller,
                "paid": paid.to_string(),
                "to_jackpot": (bankroll - paid).to_string(),
            }),
        );
        // Inserted directly: emptying the pool here is not a bust.
        self.dealers.insert(dealer_id.clone(), dealer);
        self.dealer_ids.retain(|id| *id != dealer_id);
        self.retired_ids.push(dealer_id);
        U128(paid)
    }
}

fn change_temperament(dealer: &mut Dealer, temperament: String, now: u64) {
    require!(
        can_set_temperament(dealer.temperament_changed_at, now),
        "the temperament can change once an hour"
    );
    dealer.traits = temperament_traits(&temperament);
    dealer.temperament = temperament;
    dealer.temperament_changed_at = now;
}

fn emit_offer(dealer: &Dealer) {
    emit(
        "offer",
        json!({
            "dealer_id": dealer.id,
            "rake_bp": dealer.offer.rake_bp,
            "max_bet": dealer.offer.max_bet.to_string(),
            "boost_until": dealer.offer.boost_until,
            "reason": dealer.offer.reason.code(),
        }),
    );
}

impl House {
    pub(crate) fn dealer(&self, id: &str) -> Dealer {
        self.dealers
            .get(id)
            .cloned()
            .unwrap_or_else(|| fail("unknown dealer"))
    }

    /// The dealer, refused once retired (a retired table takes no money and no seat).
    pub(crate) fn active_dealer(&self, id: &str) -> Dealer {
        let dealer = self.dealer(id);
        require!(!self.is_retired(id), "the table is retired");
        dealer
    }

    pub(crate) fn is_retired(&self, id: &str) -> bool {
        self.retired_ids.iter().any(|retired| retired == id)
    }

    /// Saves a dealer, logging a bust or a reopen when its pool crossed the "covers a minimum
    /// bet" line since the last save.
    pub(crate) fn save_dealer(&mut self, mut dealer: Dealer) {
        let open = dealer.is_open();
        if open != dealer.open {
            dealer.open = open;
            if open {
                self.log(&mut dealer, LogKind::Reopen, None, 0, String::new());
            } else {
                let needed = dealer.needed_to_reopen();
                self.log(&mut dealer, LogKind::Bust, None, needed, String::new());
            }
        }
        self.dealers.insert(dealer.id.clone(), dealer);
    }

    /// The active dealer, if the caller controls it.
    pub(crate) fn controlled_dealer(&self, id: &str) -> Dealer {
        let dealer = self.active_dealer(id);
        require!(
            env::predecessor_account_id() == dealer.controller,
            "only the table's controller can do this"
        );
        dealer
    }

    pub(crate) fn assert_keeper_or_controller(&self, dealer: &Dealer) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.keeper || caller == dealer.controller,
            "only the keeper or the table's controller can do this"
        );
    }

    fn check_new_id(&self, id: &str, name: &str, seed_amount: u128) {
        validate_new_table(id, name, seed_amount, self.dealer_ids.len())
            .unwrap_or_else(|e| fail(&e.to_string()));
        require!(
            !id.starts_with(SEAT_TOKEN_PREFIX),
            "table id cannot start with seat-"
        );
        require!(!self.dealers.contains_key(id), "dealer id already used");
    }

    /// Seeds the new dealer from `founder`'s balance (founding LP shares) and prices it.
    fn create_dealer(&mut self, mut dealer: Dealer, founder: &AccountId, seed: u128) {
        let now = now();
        let id = dealer.id.clone();
        let mut minted = 0;
        if seed > 0 {
            self.debit(founder, seed);
            minted = dealer.pool.buy_shares(seed);
            require!(minted > 0, "seed too small to buy a share");
            dealer.record_flow(now, signed(seed));
            self.set_shares(&id, founder, minted);
        }
        // Launch state, not a transition: no bust/reopen line.
        dealer.open = dealer.is_open();
        dealer.offer = core_rules::reprice(
            dealer.game,
            &dealer.pool,
            &dealer.stats(now),
            &dealer.traits,
            &[],
            now,
        );
        let controller = dealer.controller.clone();
        self.log(
            &mut dealer,
            LogKind::Opened,
            Some(controller.clone()),
            seed,
            String::new(),
        );
        if minted > 0 {
            mt::emit_mint(founder, &id, minted);
        }
        emit(
            "opened",
            json!({
                "dealer_id": id,
                "controller": controller,
                "game": to_json(&dealer.game),
                "seed_amount": seed.to_string(),
            }),
        );
        self.dealers.insert(id.clone(), dealer);
        self.dealer_ids.push(id);
    }

    /// Other seated dealers of the same game, as players see them now.
    fn rivals(&self, dealer: &Dealer, now: u64) -> Vec<RivalOffer> {
        self.seated_same_game(dealer)
            .map(|rival| RivalOffer::new(rival.game, &rival.offer, now))
            .collect()
    }

    fn seated_same_game<'a>(&'a self, dealer: &'a Dealer) -> impl Iterator<Item = &'a Dealer> {
        self.floor
            .seated()
            .filter(move |seat| seat.dealer_id != dealer.id)
            .filter_map(|seat| self.dealers.get(&seat.dealer_id))
            .filter(move |rival| rival.game == dealer.game)
    }

    /// The last hour with this table's share of its game's bets at the seated tables
    /// (10 000 when nobody bet anywhere: no share was lost).
    pub(crate) fn full_stats(&self, dealer: &Dealer, now: u64) -> Stats {
        let mut stats = dealer.stats(now);
        let rivals_bets: u128 = self
            .seated_same_game(dealer)
            .map(|rival| u128::from(rival.stats(now).bets_1h))
            .sum();
        let own = u128::from(stats.bets_1h);
        let total = own + rivals_bets;
        stats.game_share_bp = (own * BP)
            .checked_div(total)
            .and_then(|share| u16::try_from(share).ok())
            .unwrap_or(BP as u16);
        stats
    }

    fn apply_reprice(&mut self, dealer: &mut Dealer, now: u64) {
        let offer = core_rules::reprice(
            dealer.game,
            &dealer.pool,
            &self.full_stats(dealer, now),
            &dealer.traits,
            &self.rivals(dealer, now),
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
        if boost_starts {
            dealer.last_boost_at = now;
        }
        dealer.offer = offer;
        dealer.repriced_at = now;
        if let Some(kind) = kind {
            self.log(dealer, kind, None, 0, String::new());
            emit_offer(dealer);
        }
    }

    /// Adds `amount` (already taken from the investor) to the pool and mints its shares.
    pub(crate) fn invest_for(
        &mut self,
        account: &AccountId,
        dealer_id: &str,
        amount: u128,
    ) -> u128 {
        require!(amount > 0, "amount must be positive");
        let mut dealer = self.active_dealer(dealer_id);
        let now = now();
        self.settle_rent(&mut dealer, now);
        let minted = dealer.pool.buy_shares(amount);
        require!(minted > 0, "amount too small to buy a share");
        let held = self.shares_of(dealer_id, account);
        self.set_shares(dealer_id, account, held + minted);
        dealer.record_flow(now, signed(amount));
        self.log(
            &mut dealer,
            LogKind::Invest,
            Some(account.clone()),
            amount,
            String::new(),
        );
        self.save_dealer(dealer);
        mt::emit_mint(account, dealer_id, minted);
        minted
    }

    pub(crate) fn log(
        &mut self,
        dealer: &mut Dealer,
        kind: LogKind,
        account_id: Option<AccountId>,
        amount: u128,
        detail: String,
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
            detail,
        };
        self.history
            .insert((dealer.id.clone(), seq % HISTORY_PER_DEALER), entry);
        dealer.log_len += 1;
    }
}
