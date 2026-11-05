//! Append-only JSONL log of session events in `SESSION_DATA_DIR/sessions.jsonl`. Nothing reaches
//! the player before it is on disk: session events (seed, open, settle, close) are synced as they
//! are written, and a round is synced (`durable`) before its state is signed. Otherwise an OS
//! crash could lose a round the player holds signed, and the server would then settle and close
//! at the older nonce, which makes that signed state useless on chain.
//!
//! Rounds use group commit: one fsync covers every round written while the previous one ran, so
//! concurrent sessions share the cost.
//!
//! The file holds server seeds and bearer tokens: keep the directory private.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context};
use core_rules::session::{hex32, BjSession, CompactRound, Hash32, SessionTicket};
use serde::{Deserialize, Serialize};

const LOG_FILE: &str = "sessions.jsonl";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Created {
        ticket: SessionTicket,
        #[serde(with = "hex32")]
        server_seed: Hash32,
        token: String,
        at: u64,
    },
    /// `open_session` confirmed on chain.
    Opened { session_id: String, at: u64 },
    /// A blackjack hand dealt or acted on, still live.
    Hand {
        session_id: String,
        hand: BjSession,
        at: u64,
    },
    Round {
        session_id: String,
        round: CompactRound,
        at: u64,
    },
    Settled {
        session_id: String,
        upto_nonce: u64,
        at: u64,
    },
    /// No more rounds; settle and reveal pending.
    Closing { session_id: String, at: u64 },
    /// Revealed on chain (or never opened there).
    Closed { session_id: String, at: u64 },
}

impl Event {
    pub fn session_id(&self) -> &str {
        match self {
            Self::Created { ticket, .. } => &ticket.session_id,
            Self::Opened { session_id, .. }
            | Self::Hand { session_id, .. }
            | Self::Round { session_id, .. }
            | Self::Settled { session_id, .. }
            | Self::Closing { session_id, .. }
            | Self::Closed { session_id, .. } => session_id,
        }
    }
}

pub struct Store {
    file: Mutex<File>,
    /// Same file, for fsyncs run off the async threads.
    sync_handle: Arc<File>,
    /// Events written so far / known to be on disk (sequence numbers, 1-based).
    written: AtomicU64,
    synced: AtomicU64,
    /// One fsync at a time; waiters queue here and usually find their event already covered.
    sync_lock: tokio::sync::Mutex<()>,
}

impl Store {
    /// Opens (creating if needed) the log and returns every event already in it.
    pub fn open(dir: &Path) -> anyhow::Result<(Self, Vec<Event>)> {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        let path = dir.join(LOG_FILE);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("open {}", path.display()))?;
        let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        let (events, good_len) = parse_events(&text).with_context(|| path.display().to_string())?;
        if good_len < text.len() {
            // Drop the torn tail so the next append does not land after it.
            file.set_len(good_len as u64)?;
        }
        // Whatever an earlier run left in the page cache is on disk before anything is served.
        file.sync_data()?;
        Ok((
            Self {
                sync_handle: Arc::new(file.try_clone()?),
                file: Mutex::new(file),
                written: AtomicU64::new(0),
                synced: AtomicU64::new(0),
                sync_lock: tokio::sync::Mutex::new(()),
            },
            events,
        ))
    }

    /// Writes an event; returns its sequence number for `durable`. Events other than rounds and
    /// hands are synced here already.
    pub fn append(&self, event: &Event) -> anyhow::Result<u64> {
        let mut line = serde_json::to_vec(event)?;
        line.push(b'\n');
        let mut file = self
            .file
            .lock()
            .map_err(|_| anyhow!("session log lock poisoned"))?;
        file.write_all(&line)?;
        let seq = self.written.fetch_add(1, Ordering::SeqCst) + 1;
        if !matches!(event, Event::Round { .. } | Event::Hand { .. }) {
            file.sync_data()?;
            self.synced.fetch_max(seq, Ordering::SeqCst);
        }
        Ok(seq)
    }

    /// Returns once event `seq` is on disk.
    pub async fn durable(&self, seq: u64) -> anyhow::Result<()> {
        if self.synced.load(Ordering::SeqCst) >= seq {
            return Ok(());
        }
        let _turn = self.sync_lock.lock().await;
        if self.synced.load(Ordering::SeqCst) >= seq {
            return Ok(());
        }
        // Everything written before this point is covered by the fsync below.
        let target = self.written.load(Ordering::SeqCst);
        let file = Arc::clone(&self.sync_handle);
        tokio::task::spawn_blocking(move || file.sync_data()).await??;
        self.synced.fetch_max(target, Ordering::SeqCst);
        Ok(())
    }
}

/// Returns the events and the byte length of the well-formed prefix. A torn last line (crash
/// mid-write, never acknowledged) is dropped; a bad line anywhere else means the log is corrupt,
/// and the server refuses to start rather than guess.
fn parse_events(text: &str) -> anyhow::Result<(Vec<Event>, usize)> {
    let mut events = Vec::new();
    let mut offset = 0;
    for (i, line) in text.split_inclusive('\n').enumerate() {
        let is_last = offset + line.len() == text.len();
        match serde_json::from_str::<Event>(line.trim_end()) {
            Ok(event) if line.ends_with('\n') => events.push(event),
            Err(err) if !is_last => bail!("line {}: {err}", i + 1),
            // Only the last line can be torn.
            _ => break,
        }
        offset += line.len();
    }
    Ok((events, offset))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opened(id: &str) -> Event {
        Event::Opened {
            session_id: id.into(),
            at: 1,
        }
    }

    #[test]
    fn appends_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let (store, events) = Store::open(dir.path()).unwrap();
        assert!(events.is_empty());
        store.append(&opened("a")).unwrap();
        store.append(&opened("b")).unwrap();
        drop(store);
        let (_, events) = Store::open(dir.path()).unwrap();
        assert_eq!(events, vec![opened("a"), opened("b")]);
    }

    #[test]
    fn skips_a_torn_last_line_but_not_a_corrupt_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOG_FILE);
        let good = serde_json::to_string(&opened("a")).unwrap();
        fs::write(&path, format!("{good}\n{{\"kind\":\"ope")).unwrap();
        let (store, events) = Store::open(dir.path()).unwrap();
        assert_eq!(events, vec![opened("a")]);
        store.append(&opened("b")).unwrap();
        drop(store);
        let (_, events) = Store::open(dir.path()).unwrap();
        assert_eq!(events, vec![opened("a"), opened("b")]);
        fs::write(&path, format!("garbage\n{good}\n")).unwrap();
        assert!(Store::open(dir.path()).is_err());
    }
}
