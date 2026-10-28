//! Provider capability inputs (spec §7, §13–§16). Each capability has a closed parameter shape; anything else —
//! shell text, unit files, nft rules, raw frames, byte code paths — is refused here before any provider sees it.
use serde_json::{Map, Value};

pub const FILE_LIST_PAGE: u64 = 200;
pub const FILE_READ_MAX: u64 = 256 * 1024;
pub const FILE_WRITE_MAX: usize = 128 * 1024;
pub const SERIAL_FRAME_MAX: usize = 256;
pub const SERIAL_RESPONSE_MAX: usize = 4096;
pub const PATH_MAX_LEN: usize = 1024;
pub const SEGMENT_MAX: usize = 255;

pub struct Cap {
    pub id: &'static str,
    pub write: bool,
    pub replay: &'static str,
    pub kinds: &'static [&'static str],
}

pub const CAPABILITIES: &[Cap] = &[
    Cap { id: "file.list", write: false, replay: "read-only", kinds: &["import-root", "managed-root"] },
    Cap { id: "file.stat", write: false, replay: "read-only", kinds: &["import-root", "managed-root"] },
    Cap { id: "file.read_text", write: false, replay: "read-only", kinds: &["import-root", "managed-root"] },
    Cap { id: "file.changes", write: false, replay: "read-only", kinds: &["import-root", "managed-root"] },
    Cap { id: "file.write_text_atomic", write: true, replay: "owned-atomic", kinds: &["managed-root"] },
    Cap { id: "service.describe", write: false, replay: "read-only", kinds: &["service"] },
    Cap { id: "service.metrics", write: false, replay: "read-only", kinds: &["service"] },
    Cap { id: "service.ensure_state", write: true, replay: "convergent", kinds: &["service"] },
    Cap { id: "service.set_limit", write: true, replay: "convergent", kinds: &["service"] },
    Cap { id: "network.snapshot", write: false, replay: "read-only", kinds: &["host-network", "lab-network"] },
    Cap { id: "network.policy_status", write: false, replay: "read-only", kinds: &["lab-network"] },
    Cap { id: "network.apply_profile", write: true, replay: "convergent", kinds: &["lab-network"] },
    Cap { id: "device.list", write: false, replay: "read-only", kinds: &["serial"] },
    Cap { id: "serial.status", write: false, replay: "read-only", kinds: &["serial"] },
    Cap { id: "serial.exchange", write: true, replay: "non-replayable", kinds: &["serial"] },
    Cap { id: "telemetry.summary", write: false, replay: "read-only", kinds: &["service", "telemetry"] },
    Cap { id: "telemetry.events", write: false, replay: "read-only", kinds: &["service", "telemetry"] },
];

pub fn capability(id: &str) -> Option<&'static Cap> {
    CAPABILITIES.iter().find(|c| c.id == id)
}

/// Spec §13.2: normalized relative path. "" means the root itself (list/stat only).
pub fn check_rel_path(p: &str, allow_root: bool) -> Result<Vec<String>, String> {
    if p.is_empty() {
        return if allow_root { Ok(vec![]) } else { Err("PATH_SCOPE_VIOLATION: a file path is required".into()) };
    }
    if p.len() > PATH_MAX_LEN {
        return Err("PATH_SCOPE_VIOLATION: path too long".into());
    }
    if p.contains('\0') || p.contains('\\') {
        return Err("PATH_SCOPE_VIOLATION: NUL or backslash in path".into());
    }
    if p.starts_with('/') {
        return Err("PATH_SCOPE_VIOLATION: absolute paths are not allowed".into());
    }
    let mut segs = Vec::new();
    for s in p.split('/') {
        if s.is_empty() {
            return Err("PATH_SCOPE_VIOLATION: empty path segment".into());
        }
        if s == "." || s == ".." {
            return Err("PATH_SCOPE_VIOLATION: dot segments are not allowed".into());
        }
        if s.len() > SEGMENT_MAX {
            return Err("PATH_SCOPE_VIOLATION: path segment too long".into());
        }
        if s.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
            return Err("PATH_SCOPE_VIOLATION: control characters in path".into());
        }
        segs.push(s.to_string());
    }
    if segs.len() > 16 {
        return Err("PATH_SCOPE_VIOLATION: path too deep".into());
    }
    Ok(segs)
}

fn obj(v: &Value) -> Result<&Map<String, Value>, String> {
    v.as_object().ok_or_else(|| "INVALID_SYSTEM_PLAN: params must be an object".to_string())
}

fn only(m: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    for k in m.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(format!("INVALID_SYSTEM_PLAN: unknown parameter \"{k}\""));
        }
    }
    Ok(())
}

fn int(m: &Map<String, Value>, k: &str) -> Result<Option<u64>, String> {
    match m.get(k) {
        None => Ok(None),
        Some(Value::Number(n)) => n.as_u64().filter(|x| *x <= crate::dto::MAX_SAFE).map(Some).ok_or_else(|| format!("INVALID_SYSTEM_PLAN: {k} must be a non-negative integer")),
        Some(_) => Err(format!("INVALID_SYSTEM_PLAN: {k} must be a non-negative integer")),
    }
}

fn string<'a>(m: &'a Map<String, Value>, k: &str) -> Result<Option<&'a str>, String> {
    match m.get(k) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(format!("INVALID_SYSTEM_PLAN: {k} must be a string")),
    }
}

fn hash(m: &Map<String, Value>, k: &str) -> Result<Option<String>, String> {
    match string(m, k)? {
        None => Ok(None),
        Some(s) if crate::dto::hash_ok(s) => Ok(Some(s.to_string())),
        Some(_) => Err(format!("INVALID_SYSTEM_PLAN: {k} must be sha256:<hex>")),
    }
}

/// Validate and normalize capability parameters. Returns the normalized object.
pub fn check_params(cap: &str, v: &Value) -> Result<Value, String> {
    let m = obj(v)?;
    let mut out = Map::new();
    match cap {
        "file.list" => {
            only(m, &["path", "cursor", "limit"])?;
            let p = string(m, "path")?.unwrap_or("");
            check_rel_path(p, true)?;
            out.insert("path".into(), Value::String(p.into()));
            let limit = int(m, "limit")?.unwrap_or(FILE_LIST_PAGE);
            if limit == 0 || limit > FILE_LIST_PAGE {
                return Err("INVALID_SYSTEM_PLAN: limit must be 1..200".into());
            }
            out.insert("limit".into(), limit.into());
            if let Some(c) = string(m, "cursor")? {
                if c.len() > 512 {
                    return Err("INVALID_SYSTEM_PLAN: cursor too long".into());
                }
                out.insert("cursor".into(), Value::String(c.into()));
            }
        }
        "file.stat" => {
            only(m, &["path"])?;
            let p = string(m, "path")?.unwrap_or("");
            check_rel_path(p, true)?;
            out.insert("path".into(), Value::String(p.into()));
        }
        "file.read_text" => {
            only(m, &["path", "maxBytes"])?;
            let p = string(m, "path")?.ok_or("INVALID_SYSTEM_PLAN: path is required")?;
            check_rel_path(p, false)?;
            let mb = int(m, "maxBytes")?.unwrap_or(FILE_READ_MAX);
            if mb == 0 || mb > FILE_READ_MAX {
                return Err("INVALID_SYSTEM_PLAN: maxBytes must be 1..262144".into());
            }
            out.insert("path".into(), Value::String(p.into()));
            out.insert("maxBytes".into(), mb.into());
        }
        "file.changes" => {
            only(m, &["sinceSeq"])?;
            out.insert("sinceSeq".into(), int(m, "sinceSeq")?.unwrap_or(0).into());
        }
        "file.write_text_atomic" => {
            only(m, &["path", "content", "expectedVersion", "expectedAbsent"])?;
            let p = string(m, "path")?.ok_or("INVALID_SYSTEM_PLAN: path is required")?;
            check_rel_path(p, false)?;
            let c = string(m, "content")?.ok_or("INVALID_SYSTEM_PLAN: content is required")?;
            if c.len() > FILE_WRITE_MAX {
                return Err("LIMIT_EXCEEDED: content exceeds 131072 bytes".into());
            }
            let ev = hash(m, "expectedVersion")?;
            let ea = match m.get("expectedAbsent") {
                None => false,
                Some(Value::Bool(true)) => true,
                Some(_) => return Err("INVALID_SYSTEM_PLAN: expectedAbsent must be true when present".into()),
            };
            if ev.is_some() == ea {
                return Err("INVALID_SYSTEM_PLAN: give exactly one of expectedVersion or expectedAbsent".into());
            }
            out.insert("path".into(), Value::String(p.into()));
            out.insert("content".into(), Value::String(c.into()));
            if let Some(h) = ev {
                out.insert("expectedVersion".into(), Value::String(h));
            } else {
                out.insert("expectedAbsent".into(), Value::Bool(true));
            }
        }
        "service.describe" | "service.metrics" | "network.snapshot" | "network.policy_status" | "device.list" | "serial.status" | "telemetry.summary" => {
            only(m, &[])?;
        }
        "telemetry.events" => {
            only(m, &["sinceSeq", "limit"])?;
            out.insert("sinceSeq".into(), int(m, "sinceSeq")?.unwrap_or(0).into());
            let l = int(m, "limit")?.unwrap_or(100);
            if l == 0 || l > 500 {
                return Err("INVALID_SYSTEM_PLAN: limit must be 1..500".into());
            }
            out.insert("limit".into(), l.into());
        }
        "service.ensure_state" => {
            only(m, &["state"])?;
            match string(m, "state")? {
                Some(s @ ("running" | "stopped")) => {
                    out.insert("state".into(), Value::String(s.into()));
                }
                _ => return Err("INVALID_SYSTEM_PLAN: state must be running or stopped".into()),
            }
        }
        "service.set_limit" => {
            only(m, &["property", "value"])?;
            let p = string(m, "property")?.ok_or("INVALID_SYSTEM_PLAN: property is required")?;
            if p != "CPUQuotaPerSecUSec" && p != "MemoryMax" {
                return Err("INVALID_SYSTEM_PLAN: property must be CPUQuotaPerSecUSec or MemoryMax".into());
            }
            let val = int(m, "value")?.ok_or("INVALID_SYSTEM_PLAN: value must be an integer")?;
            out.insert("property".into(), Value::String(p.into()));
            out.insert("value".into(), val.into());
        }
        "network.apply_profile" => {
            only(m, &["profileId"])?;
            match string(m, "profileId")? {
                Some(s @ ("local-allow" | "local-deny")) => {
                    out.insert("profileId".into(), Value::String(s.into()));
                }
                _ => return Err("NETWORK_SCOPE_DENIED: profileId must be one of the installed profiles".into()),
            }
        }
        "serial.exchange" => {
            only(m, &["command", "count", "text"])?;
            match string(m, "command")? {
                Some("SAMPLE") => {
                    if m.contains_key("text") {
                        return Err("INVALID_SYSTEM_PLAN: SAMPLE takes count only".into());
                    }
                    let c = int(m, "count")?.unwrap_or(1);
                    if c == 0 || c > 8 {
                        return Err("INVALID_SYSTEM_PLAN: count must be 1..8".into());
                    }
                    out.insert("command".into(), "SAMPLE".into());
                    out.insert("count".into(), c.into());
                }
                Some("ECHO") => {
                    if m.contains_key("count") {
                        return Err("INVALID_SYSTEM_PLAN: ECHO takes text only".into());
                    }
                    let t = string(m, "text")?.ok_or("INVALID_SYSTEM_PLAN: text is required")?;
                    if t.is_empty() || t.len() > 64 || !t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b' ' || b == b'_' || b == b'-') {
                        return Err("INVALID_SYSTEM_PLAN: text must be 1..64 of [A-Za-z0-9 _-]".into());
                    }
                    out.insert("command".into(), "ECHO".into());
                    out.insert("text".into(), Value::String(t.into()));
                }
                _ => return Err("INVALID_SYSTEM_PLAN: command must be SAMPLE or ECHO".into()),
            }
        }
        _ => return Err("CAPABILITY_VERSION_UNSUPPORTED: unknown capability".into()),
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn paths() {
        for bad in ["/etc/passwd", "a/../b", "./a", "a//b", "a\\b", "a\0b", ""] {
            assert!(check_rel_path(bad, false).is_err(), "{bad}");
        }
        assert_eq!(check_rel_path("a/b.txt", false).unwrap(), vec!["a", "b.txt"]);
    }
    #[test]
    fn refuses_raw_inputs() {
        assert!(check_params("service.ensure_state", &json!({"state": "restart"})).is_err());
        assert!(check_params("service.set_limit", &json!({"property": "ExecStart", "value": 1})).is_err());
        assert!(check_params("network.apply_profile", &json!({"profileId": "local-allow", "rules": "flush ruleset"})).is_err());
        assert!(check_params("serial.exchange", &json!({"command": "RAW", "text": "\u{1}"})).is_err());
        assert!(check_params("file.write_text_atomic", &json!({"path": "a", "content": "x"})).is_err());
        assert!(check_params("file.write_text_atomic", &json!({"path": "a", "content": "x", "expectedAbsent": true})).is_ok());
    }
}
