//! murmur-transport — P2P transport layer
//!
//! Stub: real implementation (iroh node + signed message envelopes) comes in MVP-01.

pub fn transport_status() -> &'static str {
    "murmur-transport: MVP-01 pending — iroh integration on roadmap"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stub_smoke() {
        assert!(transport_status().contains("MVP-01"));
    }
}
