//! Privacy helpers for relay logging (v160y23).
//!
//! Full npub in stdout/journal enables correlation; we log a truncated form.

/// Redact npub for tracing: `npub1abc…xyz9` (first 8 + last 4).
pub fn redact_npub(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 16 {
        return "npub?".to_string();
    }
    let head: String = chars.iter().take(8).collect();
    let tail: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{head}…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_long_npub() {
        let npub = "npub1abcdefghijklmnopqrstuvwxyz0123456789";
        let r = redact_npub(npub);
        assert!(r.starts_with("npub1abc"));
        assert!(r.ends_with("6789"));
        assert!(r.contains('…'));
    }

    #[test]
    fn redact_short() {
        assert_eq!(redact_npub("short"), "npub?");
    }
}
