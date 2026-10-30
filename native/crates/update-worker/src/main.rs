//! CLI (one JSON line out):
//!   write-entry --esp DIR --release-id RID --kernel F --initrd F --initrd-hash H --init P [--cmdline S] [--title T]
//!   arm --esp DIR --release-id RID --known-good RID [--loader-state FILE] [--store DIR] [--need-store-bytes N] [--power-dir DIR]
//!   after-boot --facts JSON [--loader-state FILE] --boot-id ID
//!   commit --release-id RID [--loader-state FILE]      (sets default, reads it back)
//!   gc --esp DIR --keep RID[,RID...]
//!   clean --esp DIR
//!   verify-content --manifest FILE --path-info FILE
//!   health --state-dir DIR --schema-min N --schema-max N
use agentos_update_worker::{boot, content, health, preflight, trial};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn arg(a: &[String], n: &str) -> Option<String> {
    a.iter().position(|x| x == n).and_then(|i| a.get(i + 1).cloned())
}

fn loader(a: &[String]) -> Box<dyn boot::Loader> {
    match arg(a, "--loader-state") {
        Some(p) => Box::new(boot::FileLoader { path: PathBuf::from(p) }),
        None => Box::new(boot::Bootctl),
    }
}

fn run(a: &[String]) -> boot::UR<Value> {
    let r = |n: &str| arg(a, n).ok_or_else(|| boot::UErr("INVALID_REQUEST", format!("{n} is required")));
    match a.get(1).map(String::as_str).unwrap_or("") {
        "write-entry" => {
            let esp = boot::Esp { root: PathBuf::from(r("--esp")?) };
            let (rid, k, i, ih, init) = (r("--release-id")?, r("--kernel")?, r("--initrd")?, r("--initrd-hash")?, r("--init")?);
            let cmd = arg(a, "--cmdline").unwrap_or_default();
            let title = arg(a, "--title").unwrap_or_else(|| "AgentOS".into());
            esp.write_candidate(&boot::Candidate { release_id: &rid, title: &title, kernel: Path::new(&k), initrd: Path::new(&i), kernel_hash: None, initrd_hash: &ih, init: &init, cmdline: &cmd })
        }
        "arm" => {
            let esp = boot::Esp { root: PathBuf::from(r("--esp")?) };
            // V1-U06: space and power first; a failed precondition arms nothing and leaves the loader untouched.
            let need: u64 = arg(a, "--need-store-bytes").and_then(|x| x.parse().ok()).unwrap_or(0);
            let store = arg(a, "--store").unwrap_or_else(|| "/nix/store".into());
            let power = arg(a, "--power-dir").unwrap_or_else(|| "/sys/class/power_supply".into());
            preflight::check(&esp.root, Path::new(&store), need, Path::new(&power))?;
            let mut l = loader(a);
            boot::arm(&esp, l.as_mut(), &r("--release-id")?, &r("--known-good")?)
        }
        "after-boot" => {
            let f: Value = serde_json::from_str(&r("--facts")?).map_err(|e| boot::UErr("INVALID_REQUEST", e.to_string()))?;
            let facts = trial::Facts {
                state: f["state"].as_str().unwrap_or_default().into(),
                candidate: f["candidate"].as_str().unwrap_or_default().into(),
                known_good: f["knownGood"].as_str().unwrap_or_default().into(),
                trial_boot_id: f["trialBootId"].as_str().map(String::from),
                commit_intent: f["commitIntent"].as_bool().unwrap_or(false),
                failed_candidates: vec![],
            };
            let l = loader(a);
            let act = trial::after_boot(&facts, l.booted()?.as_deref(), l.default()?.as_deref(), &r("--boot-id")?);
            Ok(trial::action_json(&act))
        }
        "commit" => {
            let mut l = loader(a);
            let id = trial::entry(&r("--release-id")?);
            l.set_default(&id)?;
            if l.default()?.as_deref() != Some(id.as_str()) {
                return boot::uerr("NEEDS_ATTENTION", "default did not read back");
            }
            Ok(json!({ "default": id }))
        }
        "gc" => {
            let esp = boot::Esp { root: PathBuf::from(r("--esp")?) };
            let keep: Vec<String> = r("--keep")?.split(',').map(String::from).collect();
            esp.gc(&keep).map(|v| json!({ "removed": v }))
        }
        "clean" => boot::Esp { root: PathBuf::from(r("--esp")?) }.clean_partials().map(|v| json!({ "removed": v })),
        "verify-content" => {
            let m: Value = serde_json::from_str(&std::fs::read_to_string(r("--manifest")?).map_err(|e| boot::UErr("READ_FAILED", e.to_string()))?).map_err(|e| boot::UErr("INVALID_REQUEST", e.to_string()))?;
            let pi: Value = serde_json::from_str(&std::fs::read_to_string(r("--path-info")?).map_err(|e| boot::UErr("READ_FAILED", e.to_string()))?).map_err(|e| boot::UErr("INVALID_REQUEST", e.to_string()))?;
            let want: Vec<String> = m["closureContentHashes"].as_array().cloned().unwrap_or_default().iter().filter_map(|x| x.as_str().map(String::from)).collect();
            content::check(&pi, &want).map(|n| json!({ "paths": n })).map_err(|e| boot::UErr("UPDATE_CONTENT_MISMATCH", e))
        }
        "health" => {
            let lo = arg(a, "--schema-min").and_then(|x| x.parse().ok()).unwrap_or(5);
            let hi = arg(a, "--schema-max").and_then(|x| x.parse().ok()).unwrap_or(5);
            let sd = r("--state-dir")?;
            let mut f = |_t: u64| {
                let c = health::probe_system(&sd, (lo, hi));
                std::thread::sleep(std::time::Duration::from_secs(5));
                c
            };
            Ok(health::gate(&mut f, 5))
        }
        _ => boot::uerr("INVALID_REQUEST", "unknown command"),
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match run(&a) {
        Ok(v) => println!("{}", json!({ "ok": true, "result": v })),
        Err(e) => {
            println!("{}", json!({ "ok": false, "error": { "code": e.0, "message": e.1 } }));
            std::process::exit(1)
        }
    }
}
