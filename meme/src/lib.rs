//! $TILT, the Tilt House memecoin (NEP-141 + NEP-145 + NEP-148), **testnet**. The mechanic lives
//! here, not in a backend (docs/tilt.md):
//!
//! - **House on tilt.** Once per UTC day the USD floor reports the humans' net result against the
//!   house and their wagers (`report_day`, floor only). Humans ahead: TILT is minted to them pro
//!   rata to their wagers (per-player and per-day caps) and the streak grows. House ahead: a fixed
//!   share of the treasury burns and the streak resets.
//! - **Tilt Hour.** Holders burn TILT (`burn_for_tilt_hour`); enough TILT from enough distinct
//!   accounts within one window makes this contract call `floor.start_tilt_hour()`.
//! - **Supply.** Treasury and house allocation are minted at `new`; the welcome pool is minted one
//!   claim at a time (`claim_welcome_for`, welcome operator only). No other mint path exists.
//!
//! Every parameter is fixed at `new` (`get_params`) and there is no owner: no method can change
//! them. Every mint, burn, streak change and Tilt Hour is a NEP-297 event and an entry of an
//! on-chain ring buffer (`get_log`).

pub mod rules;

#[cfg(feature = "contract")]
mod contract;
#[cfg(feature = "contract")]
pub use contract::*;
