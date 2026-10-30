//! Coordinated cold checkpoint of one workspace and its restore (spec §23.1, §23.2, §24.1).
//!
//! Checkpoint: the Host must be stopped. The worker takes `host.lock` itself (flock, non-blocking) and holds it for
//! the whole copy, so no Host, admin tool or GC can start meanwhile. Both databases are copied with the SQLite online
//! backup API from a closed store (never a raw copy of a live `.sqlite` file), checked with `integrity_check`, their
//! pairing (os.sqlite `meta.store_uuid` present in agent.sqlite) verified, every other file hashed, and the
//! manifest is written LAST (temp + fsync + rename + fsync dir). A set directory without `manifest.json` with
//! `complete: true` is not a recoverable set.
//!
//! Restore: verify the set (every hash, pairing, schema), build the complete new tree in a staging generation next
//! to the live `data` (same filesystem), journal each step, then swap with `renameat2(RENAME_EXCHANGE)` so `data`
//! is always either the complete old tree or the complete new tree. The old tree stays as the failure candidate.
use crate::archive::{sha256_hex, valid_rel};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct CErr(pub &'static str, pub String);
impl std::fmt::Display for CErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.0, self.1)
    }
}
pub type CR<T> = Result<T, CErr>;
fn err<T>(c: &'static str, m: impl Into<String>) -> CR<T> {
    Err(CErr(c, m.into()))
}
fn io(c: &'static str) -> impl Fn(std::io::Error) -> CErr {
    move |e| CErr(c, e.to_string())
}

pub const DBS: [&str; 2] = ["os.sqlite", "agent.sqlite"];
const SKIP: [&str; 7] = ["os.sqlite", "agent.sqlite", "os.sqlite-wal", "os.sqlite-shm", "agent.sqlite-wal", "agent.sqlite-shm", "host.lock"];

/// Held `host.lock` (flock LOCK_EX). Dropping it releases the lock.
pub struct HostLock(File);
pub fn take_host_lock(data: &Path) -> CR<HostLock> {
    let f = std::fs::OpenOptions::new().read(true).write(true).create(true).open(data.join("host.lock")).map_err(io("LOCK"))?;
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return err("HOST_RUNNING", "host.lock is held: stop the workspace Host before a cold checkpoint");
    }
    Ok(HostLock(f))
}

pub fn fsync_dir(p: &Path) {
    if let Ok(f) = File::open(p) {
        let _ = f.sync_all();
    }
}

pub fn file_sha(p: &Path) -> CR<String> {
    let mut f = File::open(p).map_err(io("READ_FAILED"))?;
    let mut b = vec![];
    f.read_to_end(&mut b).map_err(io("READ_FAILED"))?;
    Ok(sha256_hex(&b))
}

fn sqlite_copy(src: &Path, dst: &Path) -> CR<()> {
    let s = Connection::open_with_flags(src, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| CErr("DB_UNREADABLE", format!("{}: {e}", src.display())))?;
    let mut d = Connection::open(dst).map_err(|e| CErr("WRITE_FAILED", e.to_string()))?;
    {
        let b = rusqlite::backup::Backup::new(&s, &mut d).map_err(|e| CErr("DB_UNREADABLE", e.to_string()))?;
        b.run_to_completion(256, std::time::Duration::from_millis(0), None).map_err(|e| CErr("DB_UNREADABLE", e.to_string()))?;
    }
    d.execute_batch("PRAGMA journal_mode=DELETE;").map_err(|e| CErr("WRITE_FAILED", e.to_string()))?;
    let ok: String = d.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(|e| CErr("DB_UNREADABLE", e.to_string()))?;
    if ok != "ok" {
        return err("DB_CORRUPT", format!("{}: integrity_check {ok}", src.display()));
    }
    drop(d);
    File::open(dst).and_then(|f| f.sync_all()).map_err(io("WRITE_FAILED"))?;
    Ok(())
}

/// Facts read from a copied pair: storeUUID, schema version, and whether agent.sqlite carries the same storeUUID.
pub fn pair_facts(dir: &Path) -> CR<(String, i64)> {
    let os = Connection::open_with_flags(dir.join("os.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| CErr("DB_UNREADABLE", e.to_string()))?;
    let (su, sv): (String, i64) = os
        .query_row("SELECT store_uuid, schema_version FROM meta WHERE id = 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| CErr("DB_UNREADABLE", format!("os.sqlite meta: {e}")))?;
    let ag = Connection::open_with_flags(dir.join("agent.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| CErr("DB_UNREADABLE", e.to_string()))?;
    // The Pi workspace marker lives in a document row; search every text cell for the storeUUID value.
    let tables: Vec<String> = {
        let mut st = ag.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").map_err(|e| CErr("DB_UNREADABLE", e.to_string()))?;
        let v = st.query_map([], |r| r.get::<_, String>(0)).map_err(|e| CErr("DB_UNREADABLE", e.to_string()))?.filter_map(|x| x.ok()).collect();
        v
    };
    let needle = format!("\"storeUUID\":\"{su}\"");
    let mut found = false;
    for t in tables {
        let cols: Vec<String> = {
            let mut st = ag.prepare(&format!("SELECT name FROM pragma_table_info('{}')", t.replace('\'', "''"))).map_err(|e| CErr("DB_UNREADABLE", e.to_string()))?;
            let v = st.query_map([], |r| r.get::<_, String>(0)).map_err(|e| CErr("DB_UNREADABLE", e.to_string()))?.filter_map(|x| x.ok()).collect();
            v
        };
        for c in cols {
            let q = format!("SELECT COUNT(*) FROM \"{}\" WHERE CAST(\"{}\" AS TEXT) LIKE ?1", t.replace('"', "\"\""), c.replace('"', "\"\""));
            let n: i64 = ag.query_row(&q, [format!("%{}%", needle.replace(':', ":"))], |r| r.get(0)).unwrap_or(0);
            let n2: i64 = ag.query_row(&q, [format!("%{su}%")], |r| r.get(0)).unwrap_or(0);
            if n > 0 || n2 > 0 {
                found = true;
                break;
            }
        }
        if found {
            break;
        }
    }
    if !found {
        return err("PAIR_MISMATCH", "agent.sqlite does not carry this workspace's storeUUID");
    }
    Ok((su, sv))
}

fn copy_tree(src: &Path, dst: &Path, rel: &str, files: &mut serde_json::Map<String, Value>) -> CR<()> {
    let dir = if rel.is_empty() { src.to_path_buf() } else { src.join(rel) };
    let mut names: Vec<String> = std::fs::read_dir(&dir).map_err(io("READ_FAILED"))?.filter_map(|d| d.ok().map(|d| d.file_name().to_string_lossy().into_owned())).collect();
    names.sort();
    for n in names {
        if rel.is_empty() && (SKIP.contains(&n.as_str()) || n == "backups" || n.ends_with(".restoring")) {
            continue;
        }
        let r = if rel.is_empty() { n.clone() } else { format!("{rel}/{n}") };
        if !valid_rel(&r) {
            return err("PATH_INVALID", r);
        }
        let md = std::fs::symlink_metadata(src.join(&r)).map_err(io("READ_FAILED"))?;
        let ft = md.file_type();
        if ft.is_socket() || ft.is_fifo() {
            continue; // runtime sockets are not data
        }
        if ft.is_symlink() || ft.is_block_device() || ft.is_char_device() {
            return err("ENTRY_UNSUPPORTED", format!("{r}: links and devices are not part of a workspace set"));
        }
        if ft.is_dir() {
            std::fs::create_dir(dst.join(&r)).map_err(io("WRITE_FAILED"))?;
            std::fs::set_permissions(dst.join(&r), std::fs::Permissions::from_mode(0o700)).map_err(io("WRITE_FAILED"))?;
            copy_tree(src, dst, &r, files)?;
        } else {
            std::fs::copy(src.join(&r), dst.join(&r)).map_err(io("WRITE_FAILED"))?;
            File::open(dst.join(&r)).and_then(|f| f.sync_all()).map_err(io("WRITE_FAILED"))?;
            files.insert(format!("data/{r}"), json!(file_sha(&dst.join(&r))?));
        }
    }
    fsync_dir(&dst.join(rel));
    Ok(())
}

pub struct CheckpointInput<'a> {
    pub set_id: &'a str,
    pub workspace_id: &'a str,
    pub barrier_id: &'a str,
    pub machine_install_id: &'a str,
    pub release_id: &'a str,
    pub incarnation: i64,
    pub member_version: i64,
    pub broker_checkpoint_seq: i64,
    pub unknown_effects: Value,
}

/// Fault points for crash tests: `AGENTOS_FAULT_POINT=ckpt.before_manifest` kills the process after all files
/// are written but before the manifest exists (spec V1-R03: no recoverable set may result).
fn fault(p: &str) {
    if std::env::var("AGENTOS_FAULT_POINT").as_deref() == Ok(p) {
        unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
    }
}

pub fn checkpoint(data: &Path, out: &Path, i: &CheckpointInput) -> CR<Value> {
    if out.exists() {
        return err("SET_EXISTS", format!("{} already exists", out.display()));
    }
    let _lock = take_host_lock(data)?;
    let tmp = out.with_extension("partial");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(tmp.join("data")).map_err(io("WRITE_FAILED"))?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o700)).map_err(io("WRITE_FAILED"))?;
    let mut files = serde_json::Map::new();
    for db in DBS {
        if !data.join(db).exists() {
            return err("DB_MISSING", format!("{db} is missing"));
        }
        sqlite_copy(&data.join(db), &tmp.join("data").join(db))?;
        files.insert(format!("data/{db}"), json!(file_sha(&tmp.join("data").join(db))?));
    }
    let (store_uuid, schema) = pair_facts(&tmp.join("data"))?;
    copy_tree(data, &tmp.join("data"), "", &mut files)?;
    let pair_digest = sha256_hex(format!("{}\n{}\n{}", store_uuid, files["data/os.sqlite"].as_str().unwrap(), files["data/agent.sqlite"].as_str().unwrap()).as_bytes());
    fault("ckpt.before_manifest");
    let manifest = json!({
        "formatVersion": 1, "setId": i.set_id, "kind": "workspace", "sourceMachineInstallId": i.machine_install_id, "barrierId": i.barrier_id,
        "createdAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64, "releaseId": i.release_id,
        "workspaces": [{ "workspaceId": i.workspace_id, "storeUUID": store_uuid, "schemaVersion": schema, "workspaceIncarnation": i.incarnation,
            "memberVersion": i.member_version, "pairDigest": pair_digest }],
        "brokerCheckpointSequence": i.broker_checkpoint_seq, "unknownEffects": i.unknown_effects, "encryption": null, "files": files, "complete": true,
    });
    let mb = agentos_protocol::canonical::canonical_json(&manifest).map_err(|_| CErr("INTERNAL", "manifest".into()))?;
    let mut f = File::create(tmp.join("manifest.json.tmp")).map_err(io("WRITE_FAILED"))?;
    f.write_all(mb.as_bytes()).map_err(io("WRITE_FAILED"))?;
    f.sync_all().map_err(io("WRITE_FAILED"))?;
    std::fs::rename(tmp.join("manifest.json.tmp"), tmp.join("manifest.json")).map_err(io("WRITE_FAILED"))?;
    fsync_dir(&tmp);
    fault("ckpt.before_publish");
    std::fs::rename(&tmp, out).map_err(io("WRITE_FAILED"))?;
    fsync_dir(out.parent().unwrap_or(Path::new("/")));
    Ok(json!({ "setId": i.set_id, "manifestHash": format!("sha256:{}", sha256_hex(mb.as_bytes())), "storeUUID": store_uuid, "files": manifest["files"].as_object().map(|m| m.len()) }))
}

/// Verify a set directory: complete manifest, every listed file present with its hash, no unlisted file, pairing.
pub fn verify_set(set: &Path) -> CR<Value> {
    let mb = std::fs::read(set.join("manifest.json")).map_err(|_| CErr("SET_INCOMPLETE", "manifest.json is missing: not a recoverable set".into()))?;
    let m: Value = std::str::from_utf8(&mb).ok().and_then(|t| agentos_protocol::v1_json::parse_strict_json(t).ok()).ok_or_else(|| CErr("SET_TAMPERED", "manifest is not strict JSON".into()))?;
    if m["complete"] != json!(true) || m["formatVersion"] != json!(1) {
        return err("SET_INCOMPLETE", "manifest is not complete");
    }
    let files = m["files"].as_object().ok_or_else(|| CErr("SET_TAMPERED", "files".into()))?;
    let mut seen = 0usize;
    fn walk(base: &Path, rel: &str, out: &mut Vec<String>) -> CR<()> {
        for d in std::fs::read_dir(base.join(rel)).map_err(io("READ_FAILED"))? {
            let d = d.map_err(io("READ_FAILED"))?;
            let n = d.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() { n } else { format!("{rel}/{n}") };
            let ft = std::fs::symlink_metadata(base.join(&r)).map_err(io("READ_FAILED"))?.file_type();
            if ft.is_symlink() || !(ft.is_dir() || ft.is_file()) {
                return err("SET_TAMPERED", format!("{r}: unexpected entry type"));
            }
            if ft.is_dir() {
                walk(base, &r, out)?;
            } else {
                out.push(r);
            }
        }
        Ok(())
    }
    let mut present = vec![];
    walk(set, "", &mut present)?;
    for p in &present {
        if p == "manifest.json" {
            continue;
        }
        let want = files.get(p).and_then(|v| v.as_str()).ok_or_else(|| CErr("SET_TAMPERED", format!("{p} is not in the manifest")))?;
        if file_sha(&set.join(p))? != want {
            return err("SET_TAMPERED", format!("{p} does not match the manifest"));
        }
        seen += 1;
    }
    if seen != files.len() {
        return err("SET_INCOMPLETE", "a file listed in the manifest is missing");
    }
    let (su, sv) = pair_facts(&set.join("data"))?;
    let w = &m["workspaces"][0];
    if w["storeUUID"] != json!(su) || w["schemaVersion"] != json!(sv) {
        return err("PAIR_MISMATCH", "databases do not match the manifest");
    }
    Ok(json!({ "manifestHash": format!("sha256:{}", sha256_hex(&mb)), "storeUUID": su, "schemaVersion": sv, "workspaceId": w["workspaceId"] }))
}

fn chown_tree(p: &Path, uid: u32, gid: u32) -> CR<()> {
    let md = std::fs::symlink_metadata(p).map_err(io("WRITE_FAILED"))?;
    if md.file_type().is_symlink() {
        return err("ENTRY_UNSUPPORTED", format!("{}: link", p.display()));
    }
    std::os::unix::fs::lchown(p, Some(uid), Some(gid)).map_err(io("WRITE_FAILED"))?;
    if md.is_dir() {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).map_err(io("WRITE_FAILED"))?;
        for d in std::fs::read_dir(p).map_err(io("READ_FAILED"))? {
            chown_tree(&d.map_err(io("READ_FAILED"))?.path(), uid, gid)?;
        }
    } else {
        let mode = md.permissions().mode() & 0o700;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(if mode & 0o100 != 0 { 0o700 } else { 0o600 })).map_err(io("WRITE_FAILED"))?;
    }
    Ok(())
}

/// Journal steps of one restore (each written with fsync before the step's effect).
pub fn journal(ws_root: &Path, restore_id: &str, step: &str) -> CR<()> {
    let p = ws_root.join(format!("restore-{restore_id}.journal"));
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p).map_err(io("WRITE_FAILED"))?;
    writeln!(f, "{step}").map_err(io("WRITE_FAILED"))?;
    f.sync_all().map_err(io("WRITE_FAILED"))?;
    Ok(())
}

pub fn journal_steps(ws_root: &Path, restore_id: &str) -> Vec<String> {
    std::fs::read_to_string(ws_root.join(format!("restore-{restore_id}.journal"))).unwrap_or_default().lines().map(String::from).collect()
}

fn exchange(a: &Path, b: &Path) -> CR<()> {
    let ca = CString::new(a.as_os_str().as_encoded_bytes()).unwrap();
    let cb = CString::new(b.as_os_str().as_encoded_bytes()).unwrap();
    let r = unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, ca.as_ptr(), libc::AT_FDCWD, cb.as_ptr(), 2u32 /* RENAME_EXCHANGE */) };
    if r != 0 {
        return err("WRITE_FAILED", format!("renameat2 exchange: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

/// Restore `set` into `<ws_root>/data` for execution uid/gid. Re-entrant by restoreId: a crash before the swap
/// leaves `data` untouched (staging is rebuilt); a crash after the swap is detected from the journal and the
/// swapped tree is kept (the swap is the single publish point). Returns the path of the kept previous tree.
pub fn restore(set: &Path, ws_root: &Path, restore_id: &str, uid: u32, gid: u32) -> CR<Value> {
    if !restore_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') || restore_id.is_empty() {
        return err("INVALID_REQUEST", "restoreId");
    }
    let data = ws_root.join("data");
    let staged = ws_root.join(format!("data.restore-{restore_id}"));
    let steps = journal_steps(ws_root, restore_id);
    if steps.iter().any(|s| s == "swapped") {
        return Ok(json!({ "restoreId": restore_id, "state": "replaced", "previous": staged.to_string_lossy(), "resumed": true }));
    }
    let v = verify_set(set)?;
    journal(ws_root, restore_id, "verified")?;
    let _ = std::fs::remove_dir_all(&staged);
    std::fs::create_dir(&staged).map_err(io("WRITE_FAILED"))?;
    let mut files = serde_json::Map::new();
    copy_tree(&set.join("data"), &staged, "", &mut files)?;
    for db in DBS {
        std::fs::copy(set.join("data").join(db), staged.join(db)).map_err(io("WRITE_FAILED"))?;
        File::open(staged.join(db)).and_then(|f| f.sync_all()).map_err(io("WRITE_FAILED"))?;
    }
    chown_tree(&staged, uid, gid)?;
    fsync_dir(&staged);
    journal(ws_root, restore_id, "staged")?;
    fault("restore.before_swap");
    let _lock = if data.exists() { Some(take_host_lock(&data)?) } else { None };
    if !data.exists() {
        std::fs::create_dir(&data).map_err(io("WRITE_FAILED"))?;
    }
    exchange(&staged, &data)?;
    fsync_dir(ws_root);
    journal(ws_root, restore_id, "swapped")?;
    fault("restore.after_swap");
    Ok(json!({ "restoreId": restore_id, "state": "replaced", "previous": staged.to_string_lossy(), "storeUUID": v["storeUUID"], "manifestHash": v["manifestHash"] }))
}

pub fn path_buf(s: &str) -> PathBuf {
    PathBuf::from(s)
}
