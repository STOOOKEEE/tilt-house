//! Every finished poker hand's public record, kept for good in `SESSION_DATA_DIR/poker-hands.jsonl`
//! (docs/poker-api.md, "Hand archive"), so anyone can replay any poker session's rounds later.
//! A hand is written, and synced, once it is over and before its rounds go into the sessions:
//! a round then always has its history. A hand whose rounds are refused gets a `void` line
//! after it and is no longer served. Nothing about a hand is written before it ends.
//!
//! Only byte offsets are kept in memory; records are read back from the file on request.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};

use crate::poker::HandRecord;

const LOG_FILE: &str = "poker-hands.jsonl";

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Entry {
    Hand {
        table: String,
        hand: Box<HandRecord>,
    },
    /// The hand's rounds were refused: nobody's stack moved, the record does not count.
    Void { table: String, number: u64 },
}

struct Writer {
    file: File,
    len: u64,
}

pub struct HandLog {
    writer: Mutex<Writer>,
    reader: File,
    /// (table, hand number) → (offset, length) of its line.
    index: Mutex<BTreeMap<(String, u64), (u64, usize)>>,
    /// Highest hand number ever written per table, void ones included.
    last: Mutex<HashMap<String, u64>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl HandLog {
    /// Opens (creating if needed) the archive in `dir` and indexes it. A torn last line (crash
    /// mid-write, never followed by rounds) is dropped; a bad line elsewhere refuses to start.
    pub fn open(dir: &Path) -> anyhow::Result<Self> {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        let path = dir.join(LOG_FILE);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("open {}", path.display()))?;
        let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        let mut index = BTreeMap::new();
        let mut last: HashMap<String, u64> = HashMap::new();
        let mut offset = 0usize;
        for (i, line) in text.split_inclusive('\n').enumerate() {
            let entry = match serde_json::from_str::<Entry>(line.trim_end()) {
                Ok(entry) if line.ends_with('\n') => entry,
                Err(err) if offset + line.len() < text.len() => {
                    bail!("{} line {}: {err}", path.display(), i + 1)
                }
                _ => break,
            };
            match entry {
                Entry::Hand { table, hand } => {
                    let top = last.entry(table.clone()).or_default();
                    *top = (*top).max(hand.number);
                    index.insert((table, hand.number), (offset as u64, line.len()));
                }
                Entry::Void { table, number } => {
                    index.remove(&(table, number));
                }
            }
            offset += line.len();
        }
        if offset < text.len() {
            file.set_len(offset as u64)?;
        }
        Ok(Self {
            reader: file.try_clone()?,
            writer: Mutex::new(Writer {
                file,
                len: offset as u64,
            }),
            index: Mutex::new(index),
            last: Mutex::new(last),
        })
    }

    fn append(&self, entry: &Entry) -> anyhow::Result<(u64, usize)> {
        let mut line = serde_json::to_vec(entry)?;
        line.push(b'\n');
        let mut writer = lock(&self.writer);
        writer.file.write_all(&line)?;
        writer.file.sync_data()?;
        let offset = writer.len;
        writer.len += line.len() as u64;
        Ok((offset, line.len()))
    }

    /// Writes a finished hand, synced, before its rounds are recorded.
    pub fn record(&self, table: &str, hand: &HandRecord) -> anyhow::Result<()> {
        let entry = Entry::Hand {
            table: table.to_string(),
            hand: Box::new(hand.clone()),
        };
        let at = self.append(&entry)?;
        lock(&self.index).insert((table.to_string(), hand.number), at);
        let mut last = lock(&self.last);
        let top = last.entry(table.to_string()).or_default();
        *top = (*top).max(hand.number);
        Ok(())
    }

    /// Marks a written hand void (its rounds were refused).
    pub fn void(&self, table: &str, number: u64) -> anyhow::Result<()> {
        self.append(&Entry::Void {
            table: table.to_string(),
            number,
        })?;
        lock(&self.index).remove(&(table.to_string(), number));
        Ok(())
    }

    /// Hand `number` of `table`, if archived.
    pub fn get(&self, table: &str, number: u64) -> anyhow::Result<Option<HandRecord>> {
        let Some(&(offset, len)) = lock(&self.index).get(&(table.to_string(), number)) else {
            return Ok(None);
        };
        let mut line = vec![0; len];
        self.reader.read_exact_at(&mut line, offset)?;
        match serde_json::from_slice::<Entry>(&line)? {
            Entry::Hand { hand, .. } if hand.number == number => Ok(Some(*hand)),
            _ => Err(anyhow!("poker hand archive index out of step")),
        }
    }

    /// The table's last written hand number (0 when none): numbering goes on after a restart,
    /// so `(table, hand)` names one hand for good.
    pub fn last_number(&self, table: &str) -> u64 {
        lock(&self.last).get(table).copied().unwrap_or(0)
    }

    /// Up to `limit` of the table's archived hand numbers below `before`, newest first.
    pub fn numbers(&self, table: &str, before: u64, limit: usize) -> Vec<u64> {
        let start = (table.to_string(), 0);
        let end = (table.to_string(), before);
        lock(&self.index)
            .range(start..end)
            .rev()
            .take(limit)
            .map(|((_, number), _)| *number)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use core_rules::poker::{Hand, HandStart, PokerAction, SeatStart};
    use core_rules::session::sha256;

    use super::*;
    use crate::poker::table_config;

    /// A real hand: heads-up, the small blind folds.
    fn hand(number: u64) -> HandRecord {
        let seed = [number as u8; 32];
        let seat = |seat: u8, player: &str| SeatStart {
            seat,
            player: player.into(),
            stack: 5_000_000,
            client_seed: format!("{player}-{number}"),
            rake_bp: 100,
        };
        let start = HandStart {
            table: "t".into(),
            hand: number,
            config: table_config(),
            button: 0,
            seats: vec![seat(0, "a.testnet"), seat(1, "b.testnet")],
            hand_seed_hash: sha256(&seed),
        };
        let mut played = Hand::new(start, seed).unwrap();
        played.act(0, PokerAction::Fold).unwrap();
        let history = played.history().unwrap();
        HandRecord {
            number,
            commitment: sha256(&seed),
            hand_seed: seed,
            history_hash: history.hash(),
            deck: Vec::new(),
            history,
            players: Vec::new(),
            result: played.result().unwrap().clone(),
            ended_at: 1,
        }
    }

    #[test]
    fn keeps_hands_drops_void_ones_and_numbers_on() {
        let dir = tempfile::tempdir().unwrap();
        let log = HandLog::open(dir.path()).unwrap();
        log.record("t", &hand(1)).unwrap();
        log.record("t", &hand(2)).unwrap();
        log.void("t", 2).unwrap();
        assert_eq!(log.get("t", 1).unwrap(), Some(hand(1)));
        assert_eq!(log.get("t", 2).unwrap(), None);
        assert_eq!(log.get("other", 1).unwrap(), None);
        drop(log);
        // A torn last line (crash mid-write) is dropped; the rest reloads.
        let path = dir.path().join(LOG_FILE);
        let mut text = fs::read_to_string(&path).unwrap();
        text.push_str("{\"kind\":\"hand\",\"tab");
        fs::write(&path, text).unwrap();
        let log = HandLog::open(dir.path()).unwrap();
        assert_eq!(log.get("t", 1).unwrap(), Some(hand(1)));
        assert_eq!(log.get("t", 2).unwrap(), None);
        // A void number is never dealt again.
        assert_eq!(log.last_number("t"), 2);
        log.record("t", &hand(3)).unwrap();
        assert_eq!(log.numbers("t", u64::MAX, 10), vec![3, 1]);
        assert_eq!(log.get("t", 3).unwrap(), Some(hand(3)));
    }
}
