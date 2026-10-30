//! V1-R04: real age export → read back → decrypt into an empty staging dir → verify data; wrong key and tampered
//! ciphertext are refused and leave no staging tree. Needs `age` and `age-keygen` on PATH (AGENTOS_AGE overrides).
use std::path::PathBuf;
use std::process::Command;

fn have_age() -> bool {
    Command::new(std::env::var("AGENTOS_AGE").unwrap_or("age".into())).arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

fn keygen(p: &PathBuf) -> String {
    let o = Command::new("age-keygen").arg("-o").arg(p).output().unwrap();
    assert!(o.status.success());
    let s = String::from_utf8_lossy(&o.stderr).to_string();
    s.split_whitespace().last().unwrap().to_string()
}

#[test]
fn age_export_import_roundtrip() {
    if !have_age() {
        if std::env::var("AGENTOS_REQUIRE_AGE").is_ok() {
            panic!("age is required");
        }
        eprintln!("SKIP: age not on PATH");
        return;
    }
    let t = std::env::temp_dir().join(format!("aoage-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&t);
    std::fs::create_dir_all(t.join("data")).unwrap();
    let os = rusqlite::Connection::open(t.join("data/os.sqlite")).unwrap();
    os.execute_batch("CREATE TABLE meta (id INTEGER PRIMARY KEY, store_uuid TEXT, schema_version INTEGER); INSERT INTO meta VALUES (1, '33333333-3333-4333-8333-333333333333', 5); CREATE TABLE records (b TEXT); INSERT INTO records VALUES ('繁體 简体');").unwrap();
    drop(os);
    let ag = rusqlite::Connection::open(t.join("data/agent.sqlite")).unwrap();
    ag.execute_batch("CREATE TABLE docs (v TEXT); INSERT INTO docs VALUES ('{\"storeUUID\":\"33333333-3333-4333-8333-333333333333\"}');").unwrap();
    drop(ag);
    use agentos_recovery_worker::{cold, export};
    cold::checkpoint(&t.join("data"), &t.join("set"), &cold::CheckpointInput { set_id: "s", workspace_id: "w", barrier_id: "b", machine_install_id: "m", release_id: "r", incarnation: 1, member_version: 1, broker_checkpoint_seq: 0, unknown_effects: serde_json::json!([]) }).unwrap();
    let rec = keygen(&t.join("id.key"));
    let wrong = keygen(&t.join("wrong.key"));
    let _ = wrong;
    let r = export::export(&t.join("set"), &rec, &t.join("out.age")).unwrap();
    let sidecar = std::fs::read_to_string(t.join("out.age.sha256")).unwrap();
    assert!(sidecar.starts_with(r["ciphertextSha256"].as_str().unwrap()));
    // the ciphertext does not contain the plaintext
    let ct = std::fs::read(t.join("out.age")).unwrap();
    assert!(!ct.windows(6).any(|w| w == "繁體".as_bytes()));
    // decrypt into an empty test "disk"
    export::import(&t.join("out.age"), &t.join("id.key"), &t.join("restore-disk"), 1 << 30).unwrap();
    let b: String = rusqlite::Connection::open(t.join("restore-disk/data/os.sqlite")).unwrap().query_row("SELECT b FROM records", [], |r| r.get(0)).unwrap();
    assert_eq!(b, "繁體 简体");
    // wrong key
    let e = export::import(&t.join("out.age"), &t.join("wrong.key"), &t.join("w2"), 1 << 30).unwrap_err();
    assert_eq!(e.0, "DECRYPT_FAILED");
    assert!(!t.join("w2").exists());
    // tampered ciphertext
    let mut c = ct.clone();
    let i = c.len() - 20;
    c[i] ^= 0x40;
    std::fs::write(t.join("bad.age"), &c).unwrap();
    assert!(export::import(&t.join("bad.age"), &t.join("id.key"), &t.join("w3"), 1 << 30).is_err());
    assert!(!t.join("w3").exists());
    // a symlink export target is refused
    std::os::unix::fs::symlink("/etc/passwd", t.join("link.age")).unwrap();
    assert_eq!(export::export(&t.join("set"), &rec, &t.join("link.age")).unwrap_err().0, "TARGET_UNSUPPORTED");
}
