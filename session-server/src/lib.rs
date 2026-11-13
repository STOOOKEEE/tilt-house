//! Tilt House session server (docs/sessions.md): starts provably fair sessions, plays their
//! rounds off chain with `core_rules`, signs every state, settles and reveals on NEAR, and runs
//! the NPC gamblers (docs/tycoon.md).

pub mod app;
pub mod chain;
pub mod gamblers;
pub mod http;
pub mod keys;
pub mod limits;
pub mod near;
pub mod poker;
pub mod poker_hands;
pub mod rpc;
pub mod session;
pub mod store;
