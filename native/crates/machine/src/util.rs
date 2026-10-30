use agentos_protocol::canonical::{canonical_json, domain_hash};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).expect("kernel random source");
    b
}

/// Canonical lowercase RFC 4122 v4 UUID.
pub fn uuid() -> String {
    let mut b = random_bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        let dash = matches!(i, 8 | 13 | 18 | 23);
        if dash != (*c == b'-') {
            return false;
        }
        if !dash && !(c.is_ascii_digit() || (b'a'..=b'f').contains(c)) {
            return false;
        }
    }
    true
}

/// 256-bit opaque session identifier (spec §6.1), hex encoded.
pub fn session_id() -> String {
    hex::encode(random_bytes::<32>())
}

pub fn hash(domain: &str, v: &Value) -> String {
    domain_hash(domain, v).expect("canonical value")
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{}", agentos_protocol::canonical::sha256_hex(bytes))
}

pub fn canon(v: &Value) -> String {
    canonical_json(v).expect("canonical value")
}

pub fn boot_id() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id").map(|s| s.trim().to_string()).unwrap_or_default()
}

/// Test-only crash point (V1-W03 VM check): honoured only when the service runs with AGENTOS_TEST_FAULTS=1, which only
/// test VM configurations set. When /run/agentos-test/machine-fault names this point, the file is consumed and the
/// process SIGKILLs itself — the effect of the step is done, its receipt is not written.
pub fn test_fault(point: &str) {
    if std::env::var("AGENTOS_TEST_FAULTS").ok().as_deref() != Some("1") {
        return;
    }
    let f = "/run/agentos-test/machine-fault";
    if std::fs::read_to_string(f).map(|s| s.trim() == point).unwrap_or(false) {
        let _ = std::fs::remove_file(f);
        unsafe {
            libc::kill(libc::getpid(), libc::SIGKILL);
        }
    }
}
