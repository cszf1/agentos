//! Content verification of a release closure (spec §20.1, V1-U04): every store path of the base closure must be
//! present and its NAR hash must be in the signed manifest's `closureContentHashes`, and the set must match exactly.
//! Nix `require-sigs` stays on (checked separately); this proves the closure is the one the manifest approved.
use serde_json::Value;

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim_end_matches('=');
    let mut out = vec![];
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = B64.iter().position(|&x| x == c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// `sha256-<base64>` (SRI) or `sha256:<hex>` → `sha256:<hex>`.
pub fn norm_nar(h: &str) -> Option<String> {
    if let Some(b) = h.strip_prefix("sha256-") {
        let d = b64_decode(b)?;
        return (d.len() == 32).then(|| format!("sha256:{}", hex::encode(d)));
    }
    if h.starts_with("sha256:") && h.len() == 71 {
        return Some(h.to_string());
    }
    None
}

/// Compare `nix path-info --json --recursive` output with the manifest list.
pub fn check(path_info: &Value, manifest_hashes: &[String]) -> Result<usize, String> {
    let mut got: Vec<String> = vec![];
    let items: Vec<(String, Value)> = match path_info {
        Value::Object(m) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Value::Array(a) => a.iter().map(|v| (v["path"].as_str().unwrap_or_default().to_string(), v.clone())).collect(),
        _ => return Err("path-info output".into()),
    };
    for (p, v) in items {
        if v.is_null() || v.get("valid") == Some(&Value::Bool(false)) {
            return Err(format!("{p} is missing from the store"));
        }
        let h = v["narHash"].as_str().and_then(norm_nar).ok_or_else(|| format!("{p}: no narHash"))?;
        got.push(h);
    }
    got.sort();
    got.dedup();
    let mut want = manifest_hashes.to_vec();
    want.sort();
    for h in &got {
        if want.binary_search(h).is_err() {
            return Err(format!("store content {h} is not approved by the manifest"));
        }
    }
    if got.len() != want.len() {
        return Err(format!("closure has {} paths, manifest lists {}", got.len(), want.len()));
    }
    Ok(got.len())
}

/// `nix.conf` must keep `require-sigs = true` (absent means the default true).
pub fn require_sigs_on(nix_conf: &str) -> bool {
    !nix_conf.lines().map(|l| l.split('#').next().unwrap_or("").trim().replace(' ', "")).any(|l| l == "require-sigs=false")
}
