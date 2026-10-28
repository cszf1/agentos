//! Canonical JSON identical to `canonicalJson` in packages/contracts (keys sorted by UTF-16 code units, JS string
//! escaping, integers only). Every hash that crosses the host/broker boundary is computed with this function on both
//! sides; fixtures/v0.3/protocol checks the two implementations against the same vectors.
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, PartialEq, Eq)]
pub struct CanonicalError(pub String);

pub fn canonical_json(v: &Value) -> Result<String, CanonicalError> {
    let mut out = String::new();
    write_value(v, &mut out)?;
    Ok(out)
}

fn write_value(v: &Value, out: &mut String) -> Result<(), CanonicalError> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i.unsigned_abs() > 9_007_199_254_740_991 {
                    return Err(CanonicalError("integer outside the safe range".into()));
                }
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                if u > 9_007_199_254_740_991 {
                    return Err(CanonicalError("integer outside the safe range".into()));
                }
                out.push_str(&u.to_string());
            } else {
                return Err(CanonicalError("non-integer numbers are not allowed in protocol values".into()));
            }
        }
        Value::String(s) => write_string(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(x, out)?;
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(k, out);
                out.push(':');
                write_value(&m[*k], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

pub fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `sha256:<hex>` of a domain-separated canonical value (same as the TS `domainHash`).
pub fn domain_hash(domain: &str, v: &Value) -> Result<String, CanonicalError> {
    let c = canonical_json(v)?;
    Ok(format!("sha256:{}", sha256_hex(format!("{domain}\n{c}").as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_and_escapes_like_js() {
        let v = json!({"b": 1, "a": [true, null, "x\"\n\u{1}"], "é": {"z": -3, "y": "ü"}});
        assert_eq!(canonical_json(&v).unwrap(), "{\"a\":[true,null,\"x\\\"\\n\\u0001\"],\"b\":1,\"é\":{\"y\":\"ü\",\"z\":-3}}");
    }

    #[test]
    fn rejects_floats_and_unsafe_integers() {
        assert!(canonical_json(&json!({"a": 1.5})).is_err());
        assert!(canonical_json(&json!(9_007_199_254_740_992u64)).is_err());
    }

    #[test]
    fn utf16_key_order() {
        // U+FF5E (BMP, high) sorts after U+1F600 (astral; surrogate 0xD83D) in UTF-16, before it in UTF-8.
        let v = json!({"\u{ff5e}": 1, "\u{1f600}": 2});
        assert_eq!(canonical_json(&v).unwrap(), "{\"\u{1f600}\":2,\"\u{ff5e}\":1}");
    }
}
