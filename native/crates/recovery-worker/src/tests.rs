use crate::archive::{self, raw_frame};
use crate::cold::{self, CheckpointInput};
use rusqlite::Connection;
use serde_json::json;
use std::path::{Path, PathBuf};

pub fn tmp(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("aorw-{}-{}-{}", name, std::process::id(), crate::archive::sha256_hex(format!("{:?}", std::time::Instant::now()).as_bytes())[..8].to_string()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

pub fn make_ws(dir: &Path, store: &str) {
    std::fs::create_dir_all(dir.join("artifacts/abc")).unwrap();
    std::fs::write(dir.join("artifacts/abc/manifest.json"), b"{\"a\":1}").unwrap();
    let os = Connection::open(dir.join("os.sqlite")).unwrap();
    os.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE meta (id INTEGER PRIMARY KEY, store_uuid TEXT, schema_version INTEGER); CREATE TABLE records (id TEXT, body TEXT);").unwrap();
    os.execute("INSERT INTO meta VALUES (1, ?1, 5)", [store]).unwrap();
    os.execute("INSERT INTO records VALUES ('r1', '买牛奶')", []).unwrap();
    let ag = Connection::open(dir.join("agent.sqlite")).unwrap();
    ag.execute_batch("CREATE TABLE docs (k TEXT, v TEXT);").unwrap();
    ag.execute("INSERT INTO docs VALUES ('agentos.workspace', ?1)", [format!("{{\"storeUUID\":\"{store}\"}}")]).unwrap();
}

fn input<'a>() -> CheckpointInput<'a> {
    CheckpointInput { set_id: "11111111-1111-4111-8111-111111111111", workspace_id: "22222222-2222-4222-8222-222222222222", barrier_id: "b", machine_install_id: "m", release_id: "r", incarnation: 1, member_version: 1, broker_checkpoint_seq: 0, unknown_effects: json!([]) }
}

#[test]
fn checkpoint_roundtrip_is_paired_and_verified() {
    let t = tmp("ck");
    make_ws(&t.join("data"), "33333333-3333-4333-8333-333333333333");
    let r = cold::checkpoint(&t.join("data"), &t.join("set"), &input()).unwrap();
    assert_eq!(r["storeUUID"], "33333333-3333-4333-8333-333333333333");
    let v = cold::verify_set(&t.join("set")).unwrap();
    assert_eq!(v["schemaVersion"], 5);
    // records readable from the copy
    let c = Connection::open(t.join("set/data/os.sqlite")).unwrap();
    let body: String = c.query_row("SELECT body FROM records", [], |r| r.get(0)).unwrap();
    assert_eq!(body, "买牛奶");
    assert!(!t.join("set.partial").exists());
}

#[test]
fn checkpoint_refuses_a_running_host() {
    let t = tmp("lk");
    make_ws(&t.join("data"), "33333333-3333-4333-8333-333333333333");
    let _held = cold::take_host_lock(&t.join("data")).unwrap();
    // a second open file description cannot take the lock
    let e = cold::checkpoint(&t.join("data"), &t.join("set"), &input()).unwrap_err();
    assert_eq!(e.0, "HOST_RUNNING");
}

#[test]
fn tampered_missing_and_unpaired_sets_are_rejected() {
    let t = tmp("tm");
    make_ws(&t.join("data"), "33333333-3333-4333-8333-333333333333");
    cold::checkpoint(&t.join("data"), &t.join("set"), &input()).unwrap();
    std::fs::write(t.join("set/data/artifacts/abc/manifest.json"), b"{\"a\":2}").unwrap();
    assert_eq!(cold::verify_set(&t.join("set")).unwrap_err().0, "SET_TAMPERED");
    std::fs::write(t.join("set/data/artifacts/abc/manifest.json"), b"{\"a\":1}").unwrap();
    cold::verify_set(&t.join("set")).unwrap();
    std::fs::write(t.join("set/data/extra"), b"x").unwrap();
    assert_eq!(cold::verify_set(&t.join("set")).unwrap_err().0, "SET_TAMPERED");
    std::fs::remove_file(t.join("set/data/extra")).unwrap();
    std::fs::remove_file(t.join("set/data/artifacts/abc/manifest.json")).unwrap();
    assert_eq!(cold::verify_set(&t.join("set")).unwrap_err().0, "SET_INCOMPLETE");
    std::fs::remove_file(t.join("set/manifest.json")).unwrap();
    assert_eq!(cold::verify_set(&t.join("set")).unwrap_err().0, "SET_INCOMPLETE");
    // agent.sqlite of another workspace
    let u = tmp("pm");
    make_ws(&u.join("data"), "33333333-3333-4333-8333-333333333333");
    let ag = Connection::open(u.join("data/agent.sqlite")).unwrap();
    ag.execute("UPDATE docs SET v = '{\"storeUUID\":\"44444444-4444-4444-8444-444444444444\"}'", []).unwrap();
    drop(ag);
    assert_eq!(cold::checkpoint(&u.join("data"), &u.join("set"), &input()).unwrap_err().0, "PAIR_MISMATCH");
}

#[test]
fn checkpoint_refuses_links_and_devices() {
    let t = tmp("ln");
    make_ws(&t.join("data"), "33333333-3333-4333-8333-333333333333");
    std::os::unix::fs::symlink("/etc/passwd", t.join("data/artifacts/evil")).unwrap();
    assert_eq!(cold::checkpoint(&t.join("data"), &t.join("set"), &input()).unwrap_err().0, "ENTRY_UNSUPPORTED");
}

#[test]
fn archive_roundtrip() {
    let t = tmp("ar");
    make_ws(&t.join("data"), "33333333-3333-4333-8333-333333333333");
    cold::checkpoint(&t.join("data"), &t.join("set"), &input()).unwrap();
    let mut buf = vec![];
    let s = archive::write_tree(&t.join("set"), &mut buf).unwrap();
    std::fs::create_dir(t.join("st")).unwrap();
    let u = archive::unpack(&mut buf.as_slice(), &t.join("st"), 1 << 30).unwrap();
    assert_eq!(s["count"], u["count"]);
    cold::verify_set(&t.join("st")).unwrap();
}

fn hostile(entries: &[(serde_json::Value, &[u8])], trailer: bool) -> Vec<u8> {
    let mut w = archive::MAGIC.to_vec();
    let mut hd = sha2::Sha256::default();
    use sha2::Digest;
    for (h, b) in entries {
        let c = agentos_protocol::canonical::canonical_json(h).unwrap();
        hd.update(c.as_bytes());
        raw_frame(&mut w, h, b);
    }
    if trailer {
        raw_frame(&mut w, &json!({ "end": true, "count": entries.len(), "headersDigest": hex::encode(hd.finalize()) }), b"");
    }
    w
}

#[test]
fn archive_rejects_escapes_links_devices_uid_and_tamper() {
    let body = b"pwned";
    let h = archive::sha256_hex(body);
    let f = |p: &str| (json!({ "path": p, "kind": "file", "size": 5, "sha256": h, "exec": false }), &body[..]);
    for (case, entries, code) in [
        ("dotdot", vec![f("../escape")], "ARCHIVE_PATH_INVALID"),
        ("abs", vec![f("/tmp/escape")], "ARCHIVE_PATH_INVALID"),
        ("inner", vec![f("a/../../escape")], "ARCHIVE_PATH_INVALID"),
        ("symlink", vec![(json!({ "path": "l", "kind": "symlink", "target": "/etc" }), &b""[..])], "ARCHIVE_ENTRY_UNSUPPORTED"),
        ("hardlink", vec![(json!({ "path": "l", "kind": "hardlink", "target": "/etc/shadow" }), &b""[..])], "ARCHIVE_ENTRY_UNSUPPORTED"),
        ("device", vec![(json!({ "path": "d", "kind": "chardev", "major": 1, "minor": 3 }), &b""[..])], "ARCHIVE_ENTRY_UNSUPPORTED"),
        ("uid", vec![(json!({ "path": "x", "kind": "file", "size": 5, "sha256": h, "exec": false, "uid": 0 }), &body[..])], "ARCHIVE_ENTRY_UNSUPPORTED"),
        ("dup", vec![f("x"), f("x")], "ARCHIVE_PATH_INVALID"),
        ("nodir", vec![f("missing/x")], "ARCHIVE_PATH_INVALID"),
    ] {
        let t = tmp(case);
        let st = t.join("st");
        std::fs::create_dir(&st).unwrap();
        let a = hostile(&entries, true);
        let e = archive::unpack(&mut a.as_slice(), &st, 1 << 20).unwrap_err();
        assert_eq!(e.0, code, "{case}: {e}");
        assert!(!t.join("escape").exists() && !Path::new("/tmp/escape").exists(), "{case}");
    }
    // tampered body, truncated stream, missing trailer, data after trailer, wrong trailer count
    let t = tmp("tamper");
    let st = t.join("st");
    std::fs::create_dir(&st).unwrap();
    let mut a = hostile(&[f("x")], true);
    let i = a.len() - 80;
    a[i] ^= 1;
    assert!(archive::unpack(&mut a.as_slice(), &st, 1 << 20).is_err());
    for (n, a) in [("trunc", hostile(&[f("x")], true)[..30].to_vec()), ("notrailer", hostile(&[f("x")], false)), ("after", { let mut v = hostile(&[f("x")], true); v.push(0); v })] {
        let t = tmp(n);
        std::fs::create_dir(t.join("st")).unwrap();
        assert!(archive::unpack(&mut a.as_slice(), &t.join("st"), 1 << 20).is_err(), "{n}");
    }
    // a symlink already present in staging is never followed (staging must be empty, and openat2 refuses links)
    let t = tmp("prelink");
    std::fs::create_dir(t.join("st")).unwrap();
    let a = hostile(&[f("x")], true);
    std::os::unix::fs::symlink("/tmp", t.join("st/x")).unwrap();
    assert_eq!(archive::unpack(&mut a.as_slice(), &t.join("st"), 1 << 20).unwrap_err().0, "STAGING");
    // size limit
    let t = tmp("limit");
    std::fs::create_dir(t.join("st")).unwrap();
    assert_eq!(archive::unpack(&mut hostile(&[f("x")], true).as_slice(), &t.join("st"), 4).unwrap_err().0, "ARCHIVE_LIMIT");
}

#[test]
fn restore_swaps_atomically_keeps_previous_and_resumes() {
    let t = tmp("rs");
    make_ws(&t.join("src"), "33333333-3333-4333-8333-333333333333");
    cold::checkpoint(&t.join("src"), &t.join("set"), &input()).unwrap();
    // live workspace has newer data
    let ws = t.join("ws");
    make_ws(&ws.join("data"), "33333333-3333-4333-8333-333333333333");
    Connection::open(ws.join("data/os.sqlite")).unwrap().execute("INSERT INTO records VALUES ('r2', 'after checkpoint')", []).unwrap();
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    let r = cold::restore(&t.join("set"), &ws, "aaaa-1", uid, gid).unwrap();
    let n: i64 = Connection::open(ws.join("data/os.sqlite")).unwrap().query_row("SELECT COUNT(*) FROM records", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    // the next Host start reconciles the restored database against the disk (V1-R09)
    let mk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(ws.join("data/restore-reconcile-pending")).unwrap()).unwrap();
    assert_eq!(mk["restoreId"], "aaaa-1");
    let prev = std::path::PathBuf::from(r["previous"].as_str().unwrap());
    let n: i64 = Connection::open(prev.join("os.sqlite")).unwrap().query_row("SELECT COUNT(*) FROM records", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2, "previous tree kept as failure candidate");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(ws.join("data/os.sqlite")).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(ws.join("data")).unwrap().permissions().mode() & 0o777, 0o700);
    // re-entry after the swap does not swap back
    let again = cold::restore(&t.join("set"), &ws, "aaaa-1", uid, gid).unwrap();
    assert_eq!(again["resumed"], true);
    let n: i64 = Connection::open(ws.join("data/os.sqlite")).unwrap().query_row("SELECT COUNT(*) FROM records", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
}

#[test]
fn restore_refuses_a_running_host_and_a_bad_set() {
    let t = tmp("rr");
    make_ws(&t.join("src"), "33333333-3333-4333-8333-333333333333");
    cold::checkpoint(&t.join("src"), &t.join("set"), &input()).unwrap();
    let ws = t.join("ws");
    make_ws(&ws.join("data"), "33333333-3333-4333-8333-333333333333");
    let _h = cold::take_host_lock(&ws.join("data")).unwrap();
    let uid = unsafe { libc::getuid() };
    assert_eq!(cold::restore(&t.join("set"), &ws, "bbbb", uid, uid).unwrap_err().0, "HOST_RUNNING");
    std::fs::write(t.join("set/data/os.sqlite"), b"garbage").unwrap();
    assert_eq!(cold::restore(&t.join("set"), &ws, "cccc", uid, uid).unwrap_err().0, "SET_TAMPERED");
}
