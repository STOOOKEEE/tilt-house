//! `tilt-house-session-server [--no-chain]`
//!
//! Env: `SESSION_SERVER_ADDR` (default 127.0.0.1:8790), `SESSION_DATA_DIR` (event log and poker hand archive; default
//! `target/session-data` with `--no-chain`), `SESSION_SERVER_PRIVATE_KEY` (`ed25519:...`, the key
//! behind the contract's `SESSION_SERVER_PUBKEY`; a throwaway key with `--no-chain` if unset), and
//! on chain `HOUSE_CONTRACT`, `SESSION_SERVER_ACCOUNT`, `NEAR_RPC_URL` and `GAMBLER_KEYS_DIR`
//! (near-cli legacy keychain holding the NPC gamblers' keys, default `~/.near-credentials/testnet`;
//! `--no-chain` gamblers need no keys). `GAMBLER_ACCOUNT_SUFFIX` (default `.tilthouse.testnet`):
//! the NPC gamblers' accounts are `g-<name>` + this, e.g. `.tilthouse.near` on mainnet.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use tilt_house_session_server::app::App;
use tilt_house_session_server::chain::{Chain, NoChain};
use tilt_house_session_server::gamblers::{Clock, Gamblers, DEFAULT_ACCOUNT_SUFFIX};
use tilt_house_session_server::http::router;
use tilt_house_session_server::keys::{random_bytes, Signer};
use tilt_house_session_server::near::NearChain;
use tilt_house_session_server::poker::{Poker, PokerConfig};
use tilt_house_session_server::poker_hands::HandLog;
use tilt_house_session_server::store::Store;

const DEFAULT_ADDR: &str = "127.0.0.1:8790";
const DEFAULT_NO_CHAIN_DATA_DIR: &str = "target/session-data";
const TESTNET_RPC: &str = "https://test.rpc.fastnear.com";
const TICK: Duration = Duration::from_secs(1);

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn required(name: &str) -> anyhow::Result<String> {
    env(name).with_context(|| format!("missing env {name}"))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let no_chain = match std::env::args().nth(1).as_deref() {
        None => false,
        Some("--no-chain") => true,
        Some(other) => bail!("unknown argument {other}; usage: [--no-chain]"),
    };
    if no_chain {
        let signer = match env("SESSION_SERVER_PRIVATE_KEY") {
            Some(key) => Signer::from_near_secret(&key)?,
            None => {
                eprintln!("no SESSION_SERVER_PRIVATE_KEY: signing with a throwaway key");
                Signer::random()?
            }
        };
        let dir = env("SESSION_DATA_DIR").unwrap_or_else(|| DEFAULT_NO_CHAIN_DATA_DIR.into());
        return serve(signer, NoChain::default(), dir.into(), None).await;
    }
    let key = required("SESSION_SERVER_PRIVATE_KEY")?;
    let chain = NearChain::new(
        &env("NEAR_RPC_URL").unwrap_or_else(|| TESTNET_RPC.into()),
        &required("HOUSE_CONTRACT")?,
        &required("SESSION_SERVER_ACCOUNT")?,
        &key,
    )?;
    let signer = Signer::from_near_secret(&key)?;
    let keys_dir = match env("GAMBLER_KEYS_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(required("HOME")?).join(".near-credentials/testnet"),
    };
    serve(
        signer,
        chain,
        required("SESSION_DATA_DIR")?.into(),
        Some(&keys_dir),
    )
    .await
}

async fn serve<C: Chain>(
    signer: Signer,
    chain: C,
    data_dir: PathBuf,
    keys_dir: Option<&Path>,
) -> anyhow::Result<()> {
    let addr: SocketAddr = env("SESSION_SERVER_ADDR")
        .unwrap_or_else(|| DEFAULT_ADDR.into())
        .parse()
        .context("SESSION_SERVER_ADDR")?;
    let (store, events) = Store::open(&data_dir)?;
    let app = Arc::new(App::load(signer, chain, store, events)?);
    println!(
        "session server on {addr}, key {}, data {}",
        app.public_key(),
        data_dir.display()
    );
    let gamblers = Arc::new(Gamblers::new(
        Arc::clone(&app),
        Clock::system(),
        &data_dir,
        keys_dir,
        &env("GAMBLER_ACCOUNT_SUFFIX").unwrap_or_else(|| DEFAULT_ACCOUNT_SUFFIX.into()),
        random_bytes()?,
    )?);
    gamblers.start();
    let ticker = Arc::clone(&app);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(TICK);
        loop {
            interval.tick().await;
            ticker.tick().await;
        }
    });
    let poker = Arc::new(Poker::new(
        Arc::clone(&app),
        Arc::clone(&gamblers),
        HandLog::open(&data_dir)?,
        PokerConfig::default(),
    ));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        router(app, gamblers, poker).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
