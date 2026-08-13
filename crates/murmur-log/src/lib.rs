//! murmur-log — Append-only local log with Merkle anchoring
//!
//! Stub: full implementation in MVP-01.

pub fn log_status() -> &'static str {
    "murmur-log: MVP-01 pending — append-only log + Merkle chain on roadmap"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stub_smoke() {
        assert!(log_status().contains("MVP-01"));
    }
}
