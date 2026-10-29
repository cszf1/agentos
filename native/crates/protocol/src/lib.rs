//! Versioned types, limits and strict parsing shared by every native AgentOS component (spec §6 native/crates/protocol).
pub mod canonical;
pub mod dto;
pub mod frame;
pub mod fsutil;
pub mod params;
pub mod peer;
pub mod rtnl;
#[cfg(feature = "dbus")]
pub mod sysd;
pub mod worker;

pub use canonical::{canonical_json, domain_hash, sha256_hex};

/// Current unix time in milliseconds.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Random lowercase hex id from the kernel CSPRNG.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    let mut filled = 0;
    while filled < bytes {
        let n = unsafe { libc::getrandom(buf[filled..].as_mut_ptr() as *mut libc::c_void, bytes - filled, 0) };
        if n > 0 {
            filled += n as usize;
        }
    }
    hex::encode(buf)
}

/// Current kernel boot id (falls back to "unknown" when the file is not readable).
pub fn boot_id() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id").map(|s| s.trim().to_string()).unwrap_or_else(|_| "unknown".into())
}
