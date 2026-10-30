//! Real SIGKILL at the publish points (V1-R03): a checkpoint killed before its manifest leaves no recoverable set;
//! a restore killed before the swap leaves the live tree untouched; killed after the swap, re-entry keeps the new tree.
use std::path::{Path, PathBuf};
use std::process::Command;

fn tmp(n: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("aorwf-{n}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn ws(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let os = rusqlite::Connection::open(dir.join("os.sqlite")).unwrap();
    os.execute_batch("CREATE TABLE meta (id INTEGER PRIMARY KEY, store_uuid TEXT, schema_version INTEGER); INSERT INTO meta VALUES (1, '33333333-3333-4333-8333-333333333333', 5); CREATE TABLE records (id TEXT);").unwrap();
    let ag = rusqlite::Connection::open(dir.join("agent.sqlite")).unwrap();
    ag.execute_batch("CREATE TABLE docs (v TEXT); INSERT INTO docs VALUES ('{\"storeUUID\":\"33333333-3333-4333-8333-333333333333\"}');").unwrap();
}

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_agentos-recovery-worker"))
}

fn ck(t: &Path, fault: Option<&str>) -> std::process::Output {
    let mut c = bin();
    c.args(["checkpoint", "--data"]).arg(t.join("data")).arg("--out").arg(t.join("set"));
    c.args(["--set-id", "s", "--workspace-id", "w", "--barrier-id", "b", "--machine-install-id", "m"]);
    if let Some(f) = fault {
        c.env("AGENTOS_FAULT_POINT", f);
    }
    c.output().unwrap()
}

#[test]
fn killed_checkpoint_is_not_recoverable_and_retry_works() {
    for f in ["ckpt.before_manifest", "ckpt.before_publish"] {
        let t = tmp(f);
        ws(&t.join("data"));
        let o = ck(&t, Some(f));
        assert!(!o.status.success());
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(o.status.signal(), Some(9), "{f}");
        assert!(!t.join("set").exists(), "{f}: no published set");
        let v = bin().args(["verify", "--set"]).arg(t.join("set.partial")).output().unwrap();
        if f == "ckpt.before_manifest" {
            assert!(String::from_utf8_lossy(&v.stdout).contains("SET_INCOMPLETE"), "{f}");
        }
        let o = ck(&t, None);
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
        assert!(bin().args(["verify", "--set"]).arg(t.join("set")).status().unwrap().success());
    }
}

#[test]
fn killed_restore_never_leaves_a_mixed_tree() {
    for f in ["restore.before_swap", "restore.after_swap"] {
        let t = tmp(f);
        ws(&t.join("data"));
        assert!(ck(&t, None).status.success());
        let w = t.join("ws");
        ws(&w.join("data"));
        rusqlite::Connection::open(w.join("data/os.sqlite")).unwrap().execute("INSERT INTO records VALUES ('new')", []).unwrap();
        let uid = unsafe { libc::getuid() }.to_string();
        let run = |fault: Option<&str>| {
            let mut c = bin();
            c.args(["restore", "--set"]).arg(t.join("set")).arg("--ws-root").arg(&w).args(["--restore-id", "dddd", "--uid", &uid, "--gid", &uid]);
            if let Some(x) = fault {
                c.env("AGENTOS_FAULT_POINT", x);
            }
            c.output().unwrap()
        };
        assert!(!run(Some(f)).status.success());
        let n: i64 = rusqlite::Connection::open(w.join("data/os.sqlite")).unwrap().query_row("SELECT COUNT(*) FROM records", [], |r| r.get(0)).unwrap();
        assert_eq!(n, if f == "restore.before_swap" { 1 } else { 0 }, "{f}: whole old or whole new");
        let o = run(None);
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
        let n: i64 = rusqlite::Connection::open(w.join("data/os.sqlite")).unwrap().query_row("SELECT COUNT(*) FROM records", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "{f}: re-entry ends with the restored tree");
    }
}
