//! Machine administrator flows without root (spec §12.2, §30; decision 80). A machine administrator runs
//! `agentosctl admin <command>` in their own local login session. The client binds a native-rpc session at the
//! gateway, plans a fixed `admin.*` machine action (params only, no secret), and confirms it with the administrator's
//! password: the gateway authenticates it through PAM (`agentos-admin-auth`), machined issues the one-time 60 s ticket
//! bound to the planHash, and the confirmation commits ticket use + intent + receipt in one machine transaction.
//! Only then does machined start the fixed root helper: the same `agentosctl` subcommand root would run, with argv
//! built here from validated params, as a transient systemd unit (outside machined's own sandbox, so machined is
//! never blocked while the helper calls back into it). The operation stays `reconciling` until the helper's exit
//! code is read back; it is never re-run under a new operationId. Root stays locked and administrators get no sudo.
use crate::err::{MErr, R};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const DIR: &str = "/var/lib/agentos-machine/admin-ops";
pub const SNAPSHOTS: &str = "/var/lib/agentos-snapshots";

pub const KINDS: &[&str] = &["admin.backup", "admin.backup.export", "admin.backup.abandon", "admin.restore", "admin.importSet", "admin.clone", "admin.importV04", "admin.update"];

fn bad(m: &str) -> MErr {
    MErr::new("INVALID_REQUEST", m.to_string())
}

fn s<'a>(p: &'a Value, k: &str) -> R<&'a str> {
    p.get(k).and_then(|v| v.as_str()).filter(|v| !v.is_empty()).ok_or_else(|| bad(&format!("{k} is required")))
}

fn opt<'a>(p: &'a Value, k: &str) -> Option<&'a str> {
    p.get(k).and_then(|v| v.as_str()).filter(|v| !v.is_empty())
}

fn flag(p: &Value, k: &str) -> bool {
    p.get(k).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// A set name under the root-only snapshot directory (sets hold plaintext workspace data: never in a home).
fn set_name(p: &Value, k: &str) -> R<String> {
    let n = s(p, k)?;
    if n.len() > 64 || n.starts_with('.') || !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err(bad(&format!("{k}: a set name is 1..64 of [A-Za-z0-9._-] (sets live in {SNAPSHOTS})")));
    }
    Ok(format!("{SNAPSHOTS}/{n}"))
}

fn login(p: &Value, k: &str) -> R<String> {
    let n = s(p, k)?;
    if !crate::dir::valid_login(n) {
        return Err(bad(&format!("{k}: bad login name")));
    }
    Ok(n.to_string())
}

/// Places an administrator may point a root helper at: their own home, removable media mounts, and (read-only
/// inputs) the Nix store. Symlinks are resolved first, so a link in the home cannot reach elsewhere.
fn allowed_roots(admin_login: &str, store: bool) -> Vec<PathBuf> {
    let mut v = vec![PathBuf::from(format!("/home/{admin_login}")), PathBuf::from("/media"), PathBuf::from("/mnt"), PathBuf::from("/run/media")];
    if store {
        v.push(PathBuf::from("/nix/store"));
    }
    v
}

fn under(p: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|r| p.starts_with(r) && p != r.as_path())
}

/// An existing input file or directory: absolute, canonical, inside an allowed root.
pub fn input_path(p: &Value, k: &str, admin_login: &str, store: bool) -> R<String> {
    let raw = s(p, k)?;
    if !raw.starts_with('/') {
        return Err(bad(&format!("{k}: an absolute path is required")));
    }
    let c = std::fs::canonicalize(raw).map_err(|e| bad(&format!("{k}: {raw}: {e}")))?;
    if !under(&c, &allowed_roots(admin_login, store)) {
        return Err(MErr::new("NOT_FOUND_OR_FORBIDDEN", format!("{k}: {raw} is outside the administrator's home, /media, /mnt{}", if store { " and /nix/store" } else { "" })));
    }
    Ok(c.to_string_lossy().into_owned())
}

/// An output directory (created by the helper): absolute, its existing parent canonical and inside an allowed root.
fn output_path(p: &Value, k: &str, admin_login: &str) -> R<String> {
    let raw = s(p, k)?;
    if !raw.starts_with('/') || raw.contains("/../") || raw.ends_with("/..") {
        return Err(bad(&format!("{k}: an absolute path without '..' is required")));
    }
    let path = Path::new(raw);
    let parent = path.parent().ok_or_else(|| bad(&format!("{k}: no parent")))?;
    let cp = std::fs::canonicalize(parent).map_err(|e| bad(&format!("{k}: {}: {e}", parent.display())))?;
    let full = cp.join(path.file_name().ok_or_else(|| bad(&format!("{k}: no name")))?);
    if !under(&full, &allowed_roots(admin_login, false)) {
        return Err(MErr::new("NOT_FOUND_OR_FORBIDDEN", format!("{k}: {raw} is outside the administrator's home, /media and /mnt")));
    }
    Ok(full.to_string_lossy().into_owned())
}

fn uuid_arg(p: &Value, k: &str) -> R<String> {
    let v = s(p, k)?;
    if !crate::util::is_uuid(v) {
        return Err(bad(&format!("{k} must be a uuid")));
    }
    Ok(v.to_string())
}

/// The fixed agentosctl argv of one admin action, built from validated params. Also the plan's impact summary.
pub fn argv(kind: &str, p: &Value, admin_login: &str) -> R<Vec<String>> {
    let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    if !p.is_object() {
        return Err(bad("params must be an object"));
    }
    Ok(match kind {
        "admin.backup" => {
            let mut a = v(&["backup", "--out"]);
            a.push(set_name(p, "name")?);
            if flag(p, "pinned") {
                a.push("--pinned".into());
            }
            if flag(p, "includeArchived") {
                a.push("--include-archived".into());
            }
            a
        }
        "admin.backup.export" => {
            let r = s(p, "recipient")?;
            if !r.starts_with("age1") || r.len() > 100 || !r.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
                return Err(bad("recipient must be an age1… public key"));
            }
            let mut a = v(&["backup", "export", "--set"]);
            a.push(set_name(p, "set")?);
            a.extend(["--recipient".to_string(), r.to_string(), "--out".to_string(), output_path(p, "out", admin_login)?]);
            a
        }
        "admin.backup.abandon" => v(&["backup", "abandon"]),
        "admin.restore" => match opt(p, "restoreId") {
            Some(_) => {
                let mut a = v(&["restore", "--set"]);
                a.push(set_name(p, "set")?);
                a.extend(["--restore-id".to_string(), uuid_arg(p, "restoreId")?]);
                a
            }
            None => {
                let mut a = v(&["restore", "--set"]);
                a.push(set_name(p, "set")?);
                a
            }
        },
        "admin.importSet" => {
            let mut a = v(&["import-set", "--in"]);
            a.push(input_path(p, "in", admin_login, false)?);
            a.extend(["--identity".to_string(), input_path(p, "identity", admin_login, false)?, "--out".to_string(), set_name(p, "name")?]);
            a
        }
        "admin.clone" => {
            let mut a = v(&["clone", "--set"]);
            a.push(set_name(p, "set")?);
            a.extend(["--owner".to_string(), login(p, "owner")?]);
            a
        }
        "admin.importV04" => {
            let mut a = v(&["import-v04", "--backup"]);
            a.push(input_path(p, "backup", admin_login, false)?);
            a.extend(["--owner".to_string(), login(p, "owner")?]);
            if let Some(n) = opt(p, "name") {
                if n.chars().count() > 80 || n.chars().any(|c| c.is_control()) {
                    return Err(bad("name: at most 80 printable characters"));
                }
                a.extend(["--name".to_string(), n.to_string()]);
            }
            a
        }
        "admin.update" => match s(p, "step")? {
            "trust-key" => {
                let id = s(p, "keyId")?;
                let pk = s(p, "publicKey")?;
                if id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') || pk.len() != 64 || !pk.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(bad("keyId [A-Za-z0-9._-]{1,64}, publicKey 64 hex digits"));
                }
                v(&["update", "trust-key", "--key-id", id, "--public-key", pk])
            }
            "verify" => {
                let mut a = v(&["update", "verify", "--manifest"]);
                a.push(input_path(p, "manifest", admin_login, true)?);
                a.extend(["--signature".to_string(), input_path(p, "signature", admin_login, true)?]);
                if flag(p, "trustedTime") {
                    a.push("--trusted-time".into());
                }
                if opt(p, "images").is_some() || opt(p, "sbom").is_some() {
                    a.extend(["--images".to_string(), input_path(p, "images", admin_login, true)?, "--sbom".to_string(), input_path(p, "sbom", admin_login, true)?]);
                }
                if flag(p, "open") {
                    a.push("--open".into());
                }
                a
            }
            "fetch" => {
                let from = s(p, "from")?;
                let ok_from = match from.strip_prefix("file://") {
                    Some(path) => {
                        let c = std::fs::canonicalize(path).map_err(|e| bad(&format!("from: {path}: {e}")))?;
                        under(&c, &allowed_roots(admin_login, false))
                    }
                    None => from.starts_with("https://") && from.len() < 300 && !from.chars().any(|c| c.is_whitespace() || c.is_control()),
                };
                if !ok_from {
                    return Err(MErr::new("NOT_FOUND_OR_FORBIDDEN", "from: an https:// release cache or a file:// cache in the administrator's home or on removable media"));
                }
                let cl = s(p, "closure")?;
                if !cl.starts_with("/nix/store/") || cl.contains("..") || cl.chars().any(|c| c.is_whitespace()) {
                    return Err(bad("closure must be a store path"));
                }
                v(&["update", "fetch", "--update-id", &uuid_arg(p, "updateId")?, "--from", from, "--closure", cl])
            }
            "adopt-base" => {
                let mut a = v(&["update", "adopt-base", "--manifest"]);
                a.push(input_path(p, "manifest", admin_login, true)?);
                a.extend(["--signature".to_string(), input_path(p, "signature", admin_login, true)?]);
                if flag(p, "trustedTime") {
                    a.push("--trusted-time".into());
                }
                a
            }
            "activate" => v(&["update", "activate", "--update-id", &uuid_arg(p, "updateId")?]),
            "commit" => v(&["update", "commit", "--update-id", &uuid_arg(p, "updateId")?]),
            "reconcile" => v(&["update", "reconcile"]),
            _ => return Err(bad("step: trust-key, adopt-base, verify, fetch, activate, commit or reconcile")),
        },
        _ => return Err(bad("unknown admin action")),
    })
}

fn unit(op: &str) -> String {
    format!("agentos-admin-op-{}", &op.replace('-', "")[..12])
}

/// Start the fixed root helper for a confirmed operation (never twice: the unit name is the operation's).
pub fn start(op: &str, argv: &[String], chown_to: Option<u32>) -> R<Value> {
    std::fs::create_dir_all(DIR).map_err(|e| MErr::new("SYSTEM_FAILED", format!("{DIR}: {e}")))?;
    let out = format!("{DIR}/{op}.out");
    let rc = format!("{DIR}/{op}.rc");
    let ctl = std::env::var("AGENTOS_CTL").unwrap_or_else(|_| "/run/current-system/sw/bin/agentosctl".into());
    let chown = match chown_to {
        Some(uid) => format!("; for d in \"$AGENTOS_ADMIN_OUT\"; do [ -n \"$d\" ] && [ -e \"$d\" ] && chown -R {uid}:{uid} \"$d\"; done"),
        None => String::new(),
    };
    // export writes into the administrator's own directory: hand the (age-encrypted) result to them
    let out_dir = argv.iter().position(|a| a == "--out").and_then(|i| argv.get(i + 1)).filter(|d| d.starts_with("/home/")).cloned().unwrap_or_default();
    let script = format!("\"$0\" \"$@\" > {out} 2>&1; r=$?{chown}; echo $r > {rc}.tmp && mv {rc}.tmp {rc}");
    let st = std::process::Command::new("systemd-run")
        .args(["--quiet", "--collect", "--service-type=exec", "--unit", &unit(op), "--description", "AgentOS administrator action", "--setenv", &format!("AGENTOS_ADMIN_OUT={out_dir}"), "--setenv", "AGENTOS_ADMIN_OPERATION=1"])
        .args(["/bin/sh", "-c", &script, &ctl])
        .args(argv)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| MErr::new("SYSTEM_FAILED", format!("systemd-run: {e}")))?;
    if !st.status.success() {
        // the unit did not start: nothing ran
        return Err(MErr::new("FAILED_NO_EFFECT", format!("the administrator helper did not start: {}", String::from_utf8_lossy(&st.stderr).trim())));
    }
    Ok(json!({ "helper": unit(op), "argv": argv, "state": "running" }))
}

/// The helper's outcome, once it exited: exit code and its (bounded) output.
pub fn finished(op: &str) -> Option<Value> {
    let rc = std::fs::read_to_string(format!("{DIR}/{op}.rc")).ok()?;
    let rc: i32 = rc.trim().parse().ok()?;
    let out = std::fs::read(format!("{DIR}/{op}.out")).unwrap_or_default();
    let text = String::from_utf8_lossy(&out);
    let tail: String = text.chars().rev().take(16000).collect::<Vec<_>>().into_iter().rev().collect();
    let json_out = text.find('{').and_then(|i| serde_json::from_str::<Value>(&text[i..]).ok());
    Some(json!({ "exitCode": rc, "output": json_out.unwrap_or(Value::Null), "log": tail }))
}

/// Whether the helper unit of an operation still exists (running, or not yet collected).
pub fn helper_alive(op: &str) -> bool {
    std::process::Command::new("systemctl").args(["is-active", "--quiet", &unit(op)]).status().map(|s| s.success()).unwrap_or(false)
}
