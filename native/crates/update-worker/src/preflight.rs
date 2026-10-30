//! Preconditions before a candidate is armed (spec §21.1, V1-U06): enough free space where the trial and its
//! rollback need it, and enough power. When any fails the candidate is not armed and nothing on the ESP or in the
//! loader changes, so the running system and its boot entries stay as they are.
use crate::boot::{uerr, UR};
use serde_json::{json, Value};
use std::path::Path;

pub const MIN_ESP_FREE: u64 = 16 * 1024 * 1024;
pub const MIN_STORE_FREE: u64 = 256 * 1024 * 1024;
pub const MIN_BATTERY_PERCENT: u64 = 40;

pub fn free_bytes(p: &Path) -> UR<u64> {
    let c = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()).map_err(|_| crate::boot::UErr("INVALID_REQUEST", "path".into()))?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return uerr("READ_FAILED", format!("statvfs {}: {}", p.display(), std::io::Error::last_os_error()));
    }
    Ok(s.f_bavail as u64 * s.f_frsize as u64)
}

/// Power from a sysfs power_supply directory: mains online → ok; otherwise every battery must be ≥ the minimum
/// or charging. No supply at all (desktop, VM) → ok.
pub fn power_ok(dir: &Path) -> (bool, Value) {
    let rd = |p: &Path, f: &str| std::fs::read_to_string(p.join(f)).map(|s| s.trim().to_string()).unwrap_or_default();
    let mut mains = false;
    let mut low = vec![];
    let mut seen = vec![];
    if let Ok(it) = std::fs::read_dir(dir) {
        for e in it.flatten() {
            let p = e.path();
            let ty = rd(&p, "type");
            seen.push(json!({ "name": e.file_name().to_string_lossy(), "type": ty }));
            if ty == "Mains" && rd(&p, "online") == "1" {
                mains = true;
            }
            if ty == "Battery" {
                let cap: u64 = rd(&p, "capacity").parse().unwrap_or(0);
                let st = rd(&p, "status");
                if cap < MIN_BATTERY_PERCENT && st != "Charging" && st != "Full" {
                    low.push(json!({ "name": e.file_name().to_string_lossy(), "capacity": cap, "status": st }));
                }
            }
        }
    }
    (mains || low.is_empty(), json!({ "mains": mains, "lowBatteries": low, "supplies": seen }))
}

pub fn check(esp: &Path, store: &Path, need_store: u64, power_dir: &Path) -> UR<Value> {
    let ef = free_bytes(esp)?;
    if ef < MIN_ESP_FREE {
        return uerr("UPDATE_PRECONDITION", format!("ESP has {ef} bytes free, needs {MIN_ESP_FREE}; not armed"));
    }
    let sf = free_bytes(store)?;
    let need = need_store.max(MIN_STORE_FREE);
    if sf < need {
        return uerr("UPDATE_PRECONDITION", format!("store has {sf} bytes free, needs {need}; not armed"));
    }
    let (ok, p) = power_ok(power_dir);
    if !ok {
        return uerr("UPDATE_PRECONDITION", format!("battery below {MIN_BATTERY_PERCENT}% and not charging; not armed: {p}"));
    }
    Ok(json!({ "espFree": ef, "storeFree": sf, "power": p }))
}
