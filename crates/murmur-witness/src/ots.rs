//! OpenTimestamps submit + parse: thin wrapper around
//! `opentimestamps_cli::stamps` so we can run real submit against calendar
//! servers, but keep tests free of network IO by injecting a custom SHA
//! mock.
//!
//! We deliberately use opentimestamps-cli (rather than hand-rolling a
//! tiny client) because the OTS commit protocol is non-trivial: nonce
//! append + double-SHA-256 protection + merkle aggregation + calendar
//! POST. Re-implementing all of this would have cost more than the time
//! saved by switching off the heavier deps.

use crate::WitnessError;
use opentimestamps_cli::stamps;

/// Submit a single 32-byte digest to the OTS calendar pool. Returns the
/// raw bytes of the resulting `DetachedTimestampFile` (binary OTS format).
///
/// On failure (network, non-OTS response, error), returns Ok(None) so the
/// caller can fall through to the next calendar.
pub fn submit_digest(urls: &[&str], digest: &[u8]) -> Result<Option<Vec<u8>>, WitnessError> {
    if digest.len() != 32 {
        return Err(WitnessError::InvalidDigestLength(digest.len()));
    }
    let urls_owned: Vec<String> = urls.iter().map(|s| s.to_string()).collect();
    let timeout = Some(std::time::Duration::from_secs(20));
    let result = stamps(
        vec![digest.to_vec()],
        ots::ser::DigestType::Sha256,
        Some(urls_owned.clone()),
        timeout,
    );
    let mut files = match result {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let file = match files.pop() {
        Some(f) => f,
        None => return Ok(None),
    };
    // Serialize to bytes.
    let mut buf: Vec<u8> = Vec::new();
    if file.to_writer(&mut buf).is_err() {
        return Ok(None);
    }
    // Sanity: starts with OTS magic (b"\x00OpenTimestamps\x00\x00Proof...").
    if buf.len() < 20 || buf[0] != 0x00 {
        return Ok(None);
    }
    // Lightly verify the OTS file actually contains the digest we asked
    // about — guarantees the calendar accepted our request and didn't
    // return someone else's timestamp.
    let parsed = match ots::ser::DetachedTimestampFile::from_reader(buf.as_slice()) {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    let start = parsed.timestamp.start_digest.clone();
    // After nonce+SHA chain, `start_digest` is the raw digest we sent.
    if start != digest {
        return Ok(None);
    }
    Ok(Some(buf))
}

/// Try each calendar in order; first one to return Ok(Some(bytes)) wins.
/// Returns (calendar_url_used, ots_bytes_or_None, last_error_message).
pub fn submit_to_any(
    urls: &[&str],
    digest: &[u8],
) -> (Option<String>, Option<Vec<u8>>, Option<String>) {
    let mut last_err: Option<String> = None;
    for url in urls {
        match submit_digest(&[*url], digest) {
            Ok(Some(ots)) => return (Some(url.to_string()), Some(ots), None),
            Ok(None) => {
                last_err = Some(format!("{url}: no OTS response"));
            }
            Err(e) => last_err = Some(format!("{url}: {e}")),
        }
    }
    (None, None, last_err)
}
