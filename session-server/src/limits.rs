//! Token-bucket rate limits keyed by session or IP. Floats are fine here: tokens are not money.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Mutex;
use std::time::Instant;

/// Above this many tracked keys, full buckets are dropped (they carry no state worth keeping).
const PRUNE_ABOVE: usize = 10_000;

pub struct RateLimiter<K> {
    per_sec: f64,
    burst: f64,
    buckets: Mutex<HashMap<K, Bucket>>,
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

impl<K: Eq + Hash + Clone> RateLimiter<K> {
    pub fn new(per_sec: f64, burst: f64) -> Self {
        Self {
            per_sec,
            burst,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Takes one token for `key`; `false` means over the limit.
    pub fn allow(&self, key: &K) -> bool {
        self.allow_at(key, Instant::now())
    }

    fn allow_at(&self, key: &K, now: Instant) -> bool {
        let Ok(mut buckets) = self.buckets.lock() else {
            // A poisoned lock means a panic elsewhere: refuse rather than run unlimited.
            return false;
        };
        if buckets.len() > PRUNE_ABOVE {
            let (per_sec, burst) = (self.per_sec, self.burst);
            buckets.retain(|_, b| b.refilled(now, per_sec, burst) < burst);
        }
        let bucket = buckets.entry(key.clone()).or_insert(Bucket {
            tokens: self.burst,
            at: now,
        });
        bucket.tokens = bucket.refilled(now, self.per_sec, self.burst);
        bucket.at = now;
        if bucket.tokens < 1.0 {
            return false;
        }
        bucket.tokens -= 1.0;
        true
    }
}

impl Bucket {
    fn refilled(&self, now: Instant, per_sec: f64, burst: f64) -> f64 {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        (self.tokens + elapsed * per_sec).min(burst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn allows_the_burst_then_refills() {
        let limiter = RateLimiter::new(20.0, 20.0);
        let start = Instant::now();
        assert!((0..20).all(|_| limiter.allow_at(&"s", start)));
        assert!(!limiter.allow_at(&"s", start));
        assert!(limiter.allow_at(&"other", start));
        assert!(limiter.allow_at(&"s", start + Duration::from_millis(50)));
        assert!(!limiter.allow_at(&"s", start + Duration::from_millis(50)));
    }
}
