//! Encrypted off-machine export (spec §23.3): the set is streamed as an AgentOS archive into the fixed `age` binary
//! (standard X25519 recipient format), written to a temp file next to the target, fsynced, read back and hashed,
//! then renamed into place with a `.sha256` sidecar. Only the recipient (public) key is given to this process; the
//! identity (private) key is never stored next to the ciphertext. Import decrypts with an identity the user supplies
//! and unpacks into an empty staging directory with the strict unpacker; a wrong key or a tampered ciphertext makes
//! age fail (authenticated encryption) and nothing is unpacked.
use crate::archive::{self, sha256_hex};
use crate::cold::{fsync_dir, CErr, CR};
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

fn age_bin() -> String {
    std::env::var("AGENTOS_AGE").unwrap_or_else(|_| "age".into())
}

pub fn export(set: &Path, recipient: &str, out: &Path) -> CR<Value> {
    crate::cold::verify_set(set)?;
    if !recipient.starts_with("age1") || recipient.len() > 128 || !recipient.bytes().all(|c| c.is_ascii_alphanumeric()) {
        return Err(CErr("INVALID_REQUEST", "recipient must be an age X25519 public key".into()));
    }
    if let Ok(md) = std::fs::symlink_metadata(out) {
        if md.file_type().is_symlink() || !md.is_file() {
            return Err(CErr("TARGET_UNSUPPORTED", "export target is a link or not a regular file".into()));
        }
        return Err(CErr("TARGET_EXISTS", "export target exists".into()));
    }
    let tmp = out.with_extension("partial");
    let _ = std::fs::remove_file(&tmp);
    let mut ch = Command::new(age_bin()).args(["-r", recipient, "-o"]).arg(&tmp).stdin(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| CErr("AGE_UNAVAILABLE", e.to_string()))?;
    let summary = {
        let mut sin = ch.stdin.take().unwrap();
        archive::write_tree(set, &mut sin).map_err(|e| CErr(e.0, e.1))?
    };
    let st = ch.wait_with_output().map_err(|e| CErr("AGE_FAILED", e.to_string()))?;
    if !st.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(CErr("AGE_FAILED", String::from_utf8_lossy(&st.stderr).into_owned()));
    }
    std::fs::File::open(&tmp).and_then(|f| f.sync_all()).map_err(|e| CErr("WRITE_FAILED", e.to_string()))?;
    // Read back what is on disk (not what we think we wrote).
    let mut b = vec![];
    std::fs::File::open(&tmp).and_then(|mut f| f.read_to_end(&mut b)).map_err(|e| CErr("READ_FAILED", e.to_string()))?;
    let h = sha256_hex(&b);
    std::fs::rename(&tmp, out).map_err(|e| CErr("WRITE_FAILED", e.to_string()))?;
    std::fs::write(out.with_extension("age.sha256"), format!("{h}  {}\n", out.file_name().unwrap().to_string_lossy())).map_err(|e| CErr("WRITE_FAILED", e.to_string()))?;
    fsync_dir(out.parent().unwrap_or(Path::new("/")));
    Ok(json!({ "ciphertextSha256": h, "entries": summary["count"], "headersDigest": summary["headersDigest"] }))
}

pub fn import(file: &Path, identity: &Path, staging: &Path, max_bytes: u64) -> CR<Value> {
    std::fs::create_dir_all(staging).map_err(|e| CErr("STAGING", e.to_string()))?;
    let mut ch = Command::new(age_bin()).args(["-d", "-i"]).arg(identity).arg(file).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| CErr("AGE_UNAVAILABLE", e.to_string()))?;
    let mut so = ch.stdout.take().unwrap();
    let r = archive::unpack(&mut so, staging, max_bytes);
    drop(so);
    let st = ch.wait_with_output().map_err(|e| CErr("AGE_FAILED", e.to_string()))?;
    if !st.status.success() {
        let _ = std::fs::remove_dir_all(staging);
        return Err(CErr("DECRYPT_FAILED", String::from_utf8_lossy(&st.stderr).trim().to_string()));
    }
    match r {
        Ok(v) => {
            crate::cold::verify_set(staging).map_err(|e| {
                let _ = std::fs::remove_dir_all(staging);
                e
            })?;
            Ok(v)
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(staging);
            Err(CErr(e.0, e.1))
        }
    }
}
