use agentos_update_worker::{boot::*, content, health, trial::*};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;

const GOOD: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAND: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INIT: &str = "/nix/store/00000000000000000000000000000000-nixos-system/init";

fn tmp(n: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("aouw-{n}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn assets(t: &Path, tag: &str) -> (PathBuf, PathBuf, String) {
    let k = t.join(format!("k-{tag}"));
    let i = t.join(format!("i-{tag}"));
    std::fs::write(&k, format!("kernel {tag}").repeat(1000)).unwrap();
    std::fs::write(&i, format!("initrd {tag}").repeat(1000)).unwrap();
    let h = sha_file(&i).unwrap();
    (k, i, h)
}

fn write(esp: &Esp, t: &Path, rid: &str) {
    let (k, i, h) = assets(t, rid);
    esp.write_candidate(&Candidate { release_id: rid, title: "AgentOS", kernel: &k, initrd: &i, kernel_hash: None, initrd_hash: &h, init: INIT, cmdline: "quiet" }).unwrap();
}

#[test]
fn candidate_is_written_complete_and_hash_checked() {
    let t = tmp("w");
    let esp = Esp { root: t.join("esp") };
    write(&esp, &t, GOOD);
    assert!(esp.entry_complete(GOOD));
    let conf = std::fs::read_to_string(t.join(format!("esp/loader/entries/agentos-{GOOD}.conf"))).unwrap();
    assert!(conf.contains(&format!("agentos.release={GOOD}")) && conf.contains(INIT));
    let (k, i, _) = assets(&t, "x");
    let e = esp.write_candidate(&Candidate { release_id: CAND, title: "t", kernel: &k, initrd: &i, kernel_hash: None, initrd_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000", init: INIT, cmdline: "" }).unwrap_err();
    assert_eq!(e.0, "UPDATE_CONTENT_MISMATCH");
    assert!(!esp.entry_complete(CAND));
    // re-entry of a complete candidate does not rewrite and still verifies
    write(&esp, &t, GOOD);
}

#[test]
fn power_cut_at_every_publish_point_leaves_old_or_complete() {
    for fp in ["boot.after_copy_linux", "boot.after_copy_initrd", "boot.before_dir_publish", "boot.before_entry", "boot.after_entry"] {
        let t = tmp(fp);
        let esp = Esp { root: t.join("esp") };
        write(&esp, &t, GOOD);
        // a foreign entry the controller must never touch
        std::fs::write(t.join("esp/loader/entries/windows.conf"), "title Windows\n").unwrap();
        let (k, i, h) = assets(&t, CAND);
        let o = Command::new(env!("CARGO_BIN_EXE_agentos-update-worker"))
            .args(["write-entry", "--esp"]).arg(t.join("esp")).args(["--release-id", CAND, "--kernel"]).arg(&k).arg("--initrd").arg(&i).args(["--initrd-hash", &h, "--init", INIT])
            .env("AGENTOS_FAULT_POINT", fp).output().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(o.status.signal(), Some(9), "{fp}");
        assert!(esp.entry_complete(GOOD), "{fp}: known-good intact");
        assert!(t.join("esp/loader/entries/windows.conf").exists());
        let entry = t.join(format!("esp/loader/entries/agentos-{CAND}.conf"));
        if entry.exists() {
            assert!(esp.entry_complete(CAND), "{fp}: an entry exists only when complete");
        }
        esp.clean_partials().unwrap();
        // the step is re-entrant by releaseId
        let o = Command::new(env!("CARGO_BIN_EXE_agentos-update-worker"))
            .args(["write-entry", "--esp"]).arg(t.join("esp")).args(["--release-id", CAND, "--kernel"]).arg(&k).arg("--initrd").arg(&i).args(["--initrd-hash", &h, "--init", INIT])
            .output().unwrap();
        assert!(o.status.success(), "{fp}: {}", String::from_utf8_lossy(&o.stdout));
        assert!(esp.entry_complete(CAND));
    }
}

#[test]
fn one_shot_trial_bad_candidate_returns_to_known_good_without_loop() {
    let t = tmp("o");
    let esp = Esp { root: t.join("esp") };
    write(&esp, &t, GOOD);
    write(&esp, &t, CAND);
    let mut l = FileLoader { path: t.join("loader.json") };
    l.set_default(&entry(GOOD)).unwrap();
    let r = arm(&esp, &mut l, CAND, GOOD).unwrap();
    assert_eq!(r["oneshot"], entry(CAND));
    assert_eq!(l.default().unwrap().as_deref(), Some(entry(GOOD).as_str()), "default stays known-good");
    // firmware boots the candidate once
    assert_eq!(l.boot().unwrap(), entry(CAND));
    let mut f = Facts { state: "armed".into(), candidate: CAND.into(), known_good: GOOD.into(), trial_boot_id: None, commit_intent: false, failed_candidates: vec![] };
    assert_eq!(after_boot(&f, l.booted().unwrap().as_deref(), l.default().unwrap().as_deref(), "boot-1"), Action::EnterValidating { boot_id: "boot-1".into() });
    f.state = "validating".into();
    f.trial_boot_id = Some("boot-1".into());
    // candidate hangs → reset: the one-shot was consumed, firmware boots the default
    assert_eq!(l.boot().unwrap(), entry(GOOD));
    let a = after_boot(&f, l.booted().unwrap().as_deref(), l.default().unwrap().as_deref(), "boot-2");
    assert!(matches!(a, Action::RolledBack { .. }), "{a:?}");
    f.failed_candidates.push(CAND.into());
    assert!(may_arm(&f, CAND).is_err(), "never retried automatically");
    // and every further boot stays on known-good
    assert_eq!(l.boot().unwrap(), entry(GOOD));
    // an armed candidate that never booted (firmware fell back) is rolled back too
    let g = Facts { state: "armed".into(), ..f.clone() };
    assert!(matches!(after_boot(&g, Some(&entry(GOOD)), Some(&entry(GOOD)), "b3"), Action::RolledBack { .. }));
    // arming refuses when the known-good entry is gone
    std::fs::remove_file(t.join(format!("esp/loader/entries/agentos-{GOOD}.conf"))).unwrap();
    assert_eq!(arm(&esp, &mut l, CAND, GOOD).unwrap_err().0, "NEEDS_ATTENTION");
}

#[test]
fn commit_window_reconciles_from_loader_facts() {
    let base = Facts { state: "validating".into(), candidate: CAND.into(), known_good: GOOD.into(), trial_boot_id: Some("b1".into()), commit_intent: false, failed_candidates: vec![] };
    let c = entry(CAND);
    let g = entry(GOOD);
    // crash before commit intent, same boot → keep validating
    assert_eq!(after_boot(&base, Some(&c), Some(&g), "b1"), Action::None);
    // crash after commit intent, before default write → resume writing the default
    let ci = Facts { commit_intent: true, ..base.clone() };
    assert_eq!(after_boot(&ci, Some(&c), Some(&g), "b1"), Action::ResumeCommitSetDefault);
    // crash after default write, before committed was recorded → finish (no second migration)
    assert_eq!(after_boot(&ci, Some(&c), Some(&c), "b2"), Action::FinishCommit);
    // power cut after commit intent: firmware boots the new default → finish
    assert_eq!(after_boot(&ci, Some(&c), Some(&c), "b3"), Action::FinishCommit);
    // unknown entry → stop
    assert!(matches!(after_boot(&base, Some("other.conf"), Some(&g), "b1"), Action::NeedsAttention { .. }));
    // committed: nothing more
    assert_eq!(after_boot(&Facts { state: "committed".into(), ..base }, Some(&c), Some(&c), "b9"), Action::None);
}

fn green() -> Vec<health::Check> {
    health::REQUIRED.iter().map(|n| health::Check { name: n, ok: true, detail: String::new() }).collect()
}

#[test]
fn health_gate_rejects_false_ready_ssh_only_no_frame_and_incompatible_stopped_workspace() {
    let r = health::gate(&mut |_| green(), 5);
    assert_eq!(r["healthy"], true);
    assert_eq!(r["at"], 60);
    // flapping: green 0..55, red at 55, green again from 60 → stable 60..120
    let r = health::gate(&mut |t| { let mut c = green(); if t == 55 { c[0].ok = false; } c }, 5);
    assert_eq!(r["stableFrom"], 60);
    // flapping every 50 s never reaches 60 s stable within 180 s
    let r = health::gate(&mut |t| { let mut c = green(); if t % 50 == 45 { c[3].ok = false; } c }, 5);
    assert_eq!(r["healthy"], false);
    // "ssh only": machine up, greeter / Shell not producing frames
    let r = health::gate(&mut |_| green().into_iter().filter(|c| c.name != "greeter_frame" && c.name != "shell_canvas").collect(), 5);
    assert_eq!(r["healthy"], false);
    assert!(r["failing"].to_string().contains("not run"));
    // Qt renders no frame
    let r = health::gate(&mut |_| { let mut c = green(); c[4] = health::Check { name: "shell_canvas", ok: false, detail: "blank frame".into() }; c }, 5);
    assert_eq!(r["healthy"], false);
    // a STOPPED workspace with an incompatible schema fails the gate
    let w = health::workspaces_compatible(&[json!({ "workspaceId": "a", "state": "running", "schemaVersion": 5 }), json!({ "workspaceId": "b", "state": "stopped", "schemaVersion": 6 })], (5, 5));
    assert!(!w.ok && w.detail.contains("stopped"));
    // an unreadable store (schema unknown) is not compatible; a workspace whose Host never created a store has no data
    assert!(!health::workspaces_compatible(&[json!({ "workspaceId": "c", "state": "stopped", "schemaVersion": null, "initialized": true })], (5, 5)).ok);
    assert!(health::workspaces_compatible(&[json!({ "workspaceId": "d", "state": "stopped", "schemaVersion": null, "initialized": false })], (5, 5)).ok);
    let r = health::gate(&mut |_| { let mut c = green(); c[5] = w.clone(); c }, 5);
    assert_eq!(r["healthy"], false);
}

#[test]
fn gc_keeps_current_known_good_recovery_and_foreign_entries() {
    let t = tmp("gc");
    let esp = Esp { root: t.join("esp") };
    let old = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let rec = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    for r in [GOOD, CAND, old, rec] {
        write(&esp, &t, r);
    }
    std::fs::write(t.join("esp/loader/entries/nixos-generation-7.conf"), "x").unwrap();
    std::fs::write(t.join("esp/loader/entries/windows.conf"), "x").unwrap();
    let removed = esp.gc(&[GOOD.into(), CAND.into(), rec.into()]).unwrap();
    assert_eq!(removed, vec![old.to_string()]);
    for r in [GOOD, CAND, rec] {
        assert!(esp.entry_complete(r));
    }
    assert!(!esp.entry_complete(old));
    assert!(t.join("esp/loader/entries/nixos-generation-7.conf").exists() && t.join("esp/loader/entries/windows.conf").exists());
}

#[test]
fn closure_content_must_match_the_signed_list_exactly() {
    let h1 = "sha256:".to_string() + &"1".repeat(64);
    let h2 = "sha256:".to_string() + &"2".repeat(64);
    let pi = json!({ "/nix/store/a": { "narHash": h1 }, "/nix/store/b": { "narHash": h2 } });
    assert_eq!(content::check(&pi, &[h1.clone(), h2.clone()]).unwrap(), 2);
    assert!(content::check(&pi, &[h1.clone()]).unwrap_err().contains("not approved"));
    assert!(content::check(&json!({ "/nix/store/a": { "narHash": h1 } }), &[h1.clone(), h2.clone()]).unwrap_err().contains("manifest lists"));
    assert!(content::check(&json!({ "/nix/store/a": null }), &[h1.clone()]).unwrap_err().contains("missing"));
    // SRI form from `nix path-info --json`
    let sri = "sha256-1B2M2Y8AsgTpgAmY7PhCfg8wQ/W5k0j3j2z1+o3zv7s=";
    assert!(content::norm_nar(sri).is_some());
    assert!(content::require_sigs_on("substituters = x\n"));
    assert!(!content::require_sigs_on("require-sigs = false\n"));
}

#[test]
fn u06_preflight_refuses_low_space_and_low_battery_and_arms_nothing() {
    use agentos_update_worker::preflight;
    let t = tmp("u06");
    let esp = Esp { root: t.join("esp") };
    std::fs::create_dir_all(&esp.root).unwrap();
    write(&esp, &t, GOOD);
    write(&esp, &t, CAND);
    let state = t.join("loader.json");
    // power: a battery at 20 % discharging, no mains → refused; charging or mains online → allowed
    let pw = t.join("power");
    std::fs::create_dir_all(pw.join("BAT0")).unwrap();
    std::fs::write(pw.join("BAT0/type"), "Battery\n").unwrap();
    std::fs::write(pw.join("BAT0/capacity"), "20\n").unwrap();
    std::fs::write(pw.join("BAT0/status"), "Discharging\n").unwrap();
    let e = preflight::check(&esp.root, &t, 0, &pw).unwrap_err();
    assert_eq!(e.0, "UPDATE_PRECONDITION");
    std::fs::write(pw.join("BAT0/status"), "Charging\n").unwrap();
    assert!(preflight::check(&esp.root, &t, 0, &pw).is_ok());
    std::fs::write(pw.join("BAT0/status"), "Discharging\n").unwrap();
    std::fs::create_dir_all(pw.join("AC")).unwrap();
    std::fs::write(pw.join("AC/type"), "Mains\n").unwrap();
    std::fs::write(pw.join("AC/online"), "1\n").unwrap();
    assert!(preflight::check(&esp.root, &t, 0, &pw).is_ok());
    // no power supply at all (desktop/VM) → allowed
    assert!(preflight::check(&esp.root, &t, 0, &t.join("none")).is_ok());
    // space: a store need larger than the filesystem → refused
    let e = preflight::check(&esp.root, &t, u64::MAX / 2, &pw).unwrap_err();
    assert_eq!(e.0, "UPDATE_PRECONDITION");
    // the CLI arm path refuses before touching the loader: no one-shot is written
    std::fs::write(pw.join("AC/online"), "0\n").unwrap();
    let bin = env!("CARGO_BIN_EXE_agentos-update-worker");
    let out = Command::new(bin)
        .args(["arm", "--esp", esp.root.to_str().unwrap(), "--release-id", CAND, "--known-good", GOOD, "--loader-state", state.to_str().unwrap(), "--store", t.to_str().unwrap(), "--power-dir", pw.to_str().unwrap()])
        .output()
        .unwrap();
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("UPDATE_PRECONDITION"), "{s}");
    let ls = std::fs::read_to_string(&state).unwrap_or_default();
    assert!(!ls.contains("oneshot") || !ls.contains(CAND), "loader state changed: {ls}");
    assert!(esp.entry_complete(GOOD) && esp.entry_complete(CAND), "existing entries untouched");
}
