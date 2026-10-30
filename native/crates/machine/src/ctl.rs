//! agentosctl (spec §30): operator entry that calls the same machined service the Shell uses; it never opens a
//! database, never skips a plan or confirmation, and prints only bounded, redacted facts.
//!   agentosctl status | doctor | workspace list | workspace status <id> | update status
//!   agentosctl firstboot --admin <login> [--workspace <name>]   (root, only while first boot is open; password on stdin)
//!   agentosctl backup --out <dir> [--pinned]                   (root: machine barrier, every workspace cold, one set)
//!   agentosctl restore --set <dir> [--restore-id <id>]         (root: same-machine restore journal, resumable)
//!   agentosctl recover --new-identity                          (root: accept a new install identity after loss)
use agentos_machine::server::Client;
use agentos_machine::util::uuid;
use serde_json::{json, Value};
use std::io::Read;

fn sock() -> String {
    std::env::var("AGENTOS_MACHINE_SOCKET").unwrap_or_else(|_| "/run/agentos/machine/machine.sock".into())
}

fn arg(a: &[String], name: &str) -> Option<String> {
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}

fn out(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

fn die(msg: &str) -> ! {
    eprintln!("agentosctl: {msg}");
    std::process::exit(1)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.get(1).map(|s| s.as_str()) == Some("recover") {
        recover(&a);
        return;
    }
    let mut c = match Client::connect(&sock()) {
        Ok(c) => c,
        Err(e) => {
            if let Ok(r) = std::fs::read_to_string("/var/lib/agentos-machine/recovery-required") {
                die(&format!("machine service is in recovery mode: {r}"));
            }
            die(&format!("machine service unreachable: {e}"))
        }
    };
    let call = |c: &mut Client, op: &str, args: Value| c.call(op, args).unwrap_or_else(|e| die(&e.to_string()));
    match (a.get(1).map(|s| s.as_str()), a.get(2).map(|s| s.as_str())) {
        (Some("status"), _) => out(&call(&mut c, "status", json!({}))),
        (Some("doctor"), _) => {
            let st = c.call("status", json!({}));
            let caps = c.call("machine.capabilities", json!({}));
            let ok = st.is_ok();
            out(&json!({ "machine": st.map_err(|e| e.to_string()), "capabilities": caps.map_err(|e| e.to_string()),
                "gatewaySocket": std::path::Path::new("/run/agentos/gateway.sock").exists(),
                "brokerSocket": std::path::Path::new("/run/agentos-broker/broker.sock").exists(),
                "restoreMarker": std::path::Path::new("/var/lib/agentos-machine/restore-in-progress").exists() }));
            if !ok {
                std::process::exit(1);
            }
        }
        (Some("workspace"), Some("list")) => {
            let users = call(&mut c, "users.list", json!({}));
            let mut rows = vec![];
            for u in users["users"].as_array().cloned().unwrap_or_default() {
                let p = json!({ "userId": u["userId"], "sessionEpoch": 1, "admin": true, "locked": false });
                if let Ok(v) = c.call("workspaces.list", json!({ "principal": p })) {
                    for w in v["workspaces"].as_array().cloned().unwrap_or_default() {
                        if w["role"] == "owner" {
                            rows.push(json!({ "workspaceId": w["workspaceId"], "displayName": w["displayName"], "state": w["state"], "owner": u["loginName"] }));
                        }
                    }
                }
            }
            out(&json!({ "workspaces": rows }));
        }
        (Some("workspace"), Some("status")) => {
            let id = a.get(3).unwrap_or_else(|| die("usage: agentosctl workspace status <workspaceId>"));
            let mut w = call(&mut c, "workspaces.row", json!({ "workspaceId": id }));
            if let Some(o) = w.as_object_mut() {
                o.remove("createId");
            }
            out(&w);
        }
        (Some("update"), Some("status")) => {
            let cur = call(&mut c, "updates.current", json!({}));
            let st = call(&mut c, "status", json!({}));
            let upd = match cur["updateId"].as_str() {
                Some(id) => call(&mut c, "updates.get", json!({ "updateId": id })),
                None => Value::Null,
            };
            out(&json!({ "currentReleaseId": st["meta"]["currentReleaseId"], "knownGoodReleaseId": st["meta"]["knownGoodReleaseId"], "acceptedReleaseSequence": st["meta"]["acceptedReleaseSequence"], "update": upd }));
        }
        (Some("firstboot"), _) => {
            if unsafe { libc::geteuid() } != 0 {
                die("firstboot must run as root on the local console");
            }
            let login = arg(&a, "--admin").unwrap_or_else(|| die("usage: agentosctl firstboot --admin <login> [--workspace <name>] (password on stdin)"));
            let wsname = arg(&a, "--workspace").unwrap_or_else(|| "我的工作区".into());
            let fb = std::fs::read_to_string("/var/lib/agentos-machine/first-boot-id").ok().map(|s| s.trim().to_string()).unwrap_or_else(|| {
                let id = uuid();
                let _ = agentos_machine::dir::write_private(std::path::Path::new("/var/lib/agentos-machine/first-boot-id"), id.as_bytes());
                id
            });
            let inst = call(&mut c, "install.ensure", json!({ "firstBootId": fb }));
            let st = call(&mut c, "status", json!({}));
            if st["meta"]["firstBootState"] != "open" {
                die("first boot is already closed on this machine");
            }
            let mut pw = String::new();
            std::io::stdin().read_to_string(&mut pw).unwrap_or_else(|_| die("password on stdin"));
            let pw = pw.trim_end_matches('\n').to_string();
            let pid = std::fs::read_to_string("/var/lib/agentos-machine/first-boot-admin").ok().map(|s| s.trim().to_string()).unwrap_or_else(|| {
                let id = uuid();
                let _ = agentos_machine::dir::write_private(std::path::Path::new("/var/lib/agentos-machine/first-boot-admin"), id.as_bytes());
                id
            });
            let u = call(&mut c, "users.provision", json!({ "provisioningId": pid, "loginName": login, "role": "admin" }));
            let r = call(&mut c, "secrets.put", json!({ "kind": "password", "value": pw }));
            call(&mut c, "users.setPassword", json!({ "userId": u["userId"], "secretRef": r["secretRef"] }));
            let cid = std::fs::read_to_string("/var/lib/agentos-machine/first-boot-workspace").ok().map(|s| s.trim().to_string()).unwrap_or_else(|| {
                let id = uuid();
                let _ = agentos_machine::dir::write_private(std::path::Path::new("/var/lib/agentos-machine/first-boot-workspace"), id.as_bytes());
                id
            });
            let w = call(&mut c, "workspaces.createFor", json!({ "createId": cid, "ownerUserId": u["userId"], "displayName": wsname }));
            call(&mut c, "install.closeFirstBoot", json!({}));
            out(&json!({ "machineInstallId": inst["machineInstallId"], "admin": u["loginName"], "workspaceId": w["workspaceId"], "firstBoot": "closed" }));
        }
        (Some("support-bundle"), _) => support_bundle(&mut c, &a),
        (Some("backup"), _) => backup(&mut c, &a),
        (Some("restore"), _) => restore(&mut c, &a),
        _ => die("usage: agentosctl status | doctor | workspace list | workspace status <id> | update status | firstboot --admin <login> | support-bundle --out <file>"),
    }
}

fn root_only(what: &str) {
    if unsafe { libc::geteuid() } != 0 {
        die(&format!("{what} must run as root"));
    }
}

fn recovery_worker() -> String {
    std::env::var("AGENTOS_RECOVERY_WORKER").unwrap_or_else(|_| "/run/current-system/sw/bin/agentos-recovery-worker".into())
}

/// Runs the fixed recovery worker and returns its last JSON line (`{"ok": ..}`).
fn rw(args: &[&str]) -> Value {
    let o = std::process::Command::new(recovery_worker()).args(args).output().unwrap_or_else(|e| die(&format!("recovery worker: {e}")));
    let text = String::from_utf8_lossy(&o.stdout);
    text.lines().rev().find_map(|l| serde_json::from_str::<Value>(l).ok()).unwrap_or_else(|| json!({ "ok": false, "error": "no result" }))
}

fn fault(point: &str) {
    if std::env::var("AGENTOS_FAULT_POINT").ok().as_deref() == Some(point) {
        eprintln!("agentosctl: fault injected at {point}");
        std::process::exit(9);
    }
}

fn sha256_hex(b: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(b))
}

/// Machine cold backup (spec §24, V1-R01/R02): one barrier freezes the machine (no workspace may start, no Host may
/// join), every running workspace is stopped with its pair, each tree is checkpointed by the recovery worker, and the
/// set is completed once with a manifest over all parts. Workspaces that were running are started again afterwards.
fn backup(c: &mut Client, a: &[String]) {
    root_only("backup");
    if a.get(2).map(|s| s.as_str()) == Some("abandon") {
        // A backup that died under its barrier (power cut, kill): abandon its building set and release the barrier.
        let b = c.call("barrier.get", json!({})).unwrap_or(Value::Null);
        if b.is_null() {
            return out(&json!({ "ok": true, "abandoned": null }));
        }
        if b["ownerKind"] != "checkpoint" {
            die(&format!("the machine barrier is held by {}, not by a backup", b["ownerKind"]));
        }
        let set_id = b["ownerId"].as_str().unwrap_or_default().to_string();
        let _ = c.call("checkpoints.abandon", json!({ "setId": set_id }));
        let _ = c.call("barrier.release", json!({ "barrierId": b["barrierId"] }));
        return out(&json!({ "ok": true, "abandoned": set_id }));
    }
    let out_dir = arg(a, "--out").unwrap_or_else(|| die("usage: agentosctl backup --out <dir> [--pinned]"));
    let pinned = a.iter().any(|x| x == "--pinned");
    let set_id = uuid();
    let call = |c: &mut Client, op: &str, args: Value| c.call(op, args);
    let st = call(c, "status", json!({})).unwrap_or_else(|e| die(&e.to_string()));
    let mid = st["meta"]["machineInstallId"].as_str().unwrap_or_default().to_string();
    let barrier = call(c, "barrier.hold", json!({ "ownerKind": "checkpoint", "ownerId": set_id, "scope": { "kind": "machine" } })).unwrap_or_else(|e| die(&e.to_string()));
    let barrier = barrier["barrierId"].as_str().unwrap_or_default().to_string();
    let wss: Vec<Value> = call(c, "workspaces.all", json!({})).map(|v| v["workspaces"].as_array().cloned().unwrap_or_default()).unwrap_or_default();
    let wss: Vec<Value> = wss.into_iter().filter(|w| w["state"] != "archived").collect();
    let was_running: Vec<String> = wss.iter().filter(|w| matches!(w["state"].as_str(), Some("running" | "starting"))).map(|w| w["workspaceId"].as_str().unwrap_or_default().to_string()).collect();
    let fail = |c: &mut Client, msg: String, begun: bool| bail(c, &set_id, &barrier, msg, begun);
    for w in &wss {
        let id = w["workspaceId"].as_str().unwrap_or_default();
        match call(c, "workspaces.rootStop", json!({ "workspaceId": id })) {
            Ok(r) if r["state"] == "stopped" => {}
            Ok(r) => fail(c, format!("workspace {id} did not stop cleanly ({})", r["state"]), false),
            Err(e) => fail(c, format!("workspace {id}: {e}"), false),
        }
    }
    if let Err(e) = call(c, "checkpoints.begin", json!({ "setId": set_id, "scope": "machine", "barrierId": barrier })) {
        fail(c, e.to_string(), false);
    }
    let _ = std::fs::create_dir_all(format!("{out_dir}/ws"));
    let mut parts = vec![];
    for w in &wss {
        let id = w["workspaceId"].as_str().unwrap_or_default();
        let dest = format!("{out_dir}/ws/{id}");
        let data = format!("/var/lib/agentos/workspaces/{id}/data");
        let r = rw(&["checkpoint", "--data", &data, "--out", &dest, "--set-id", &set_id, "--workspace-id", id, "--barrier-id", &barrier, "--machine-install-id", &mid]);
        if r["ok"] != true {
            fail(c, format!("checkpoint of {id} failed: {}", r["error"]), true);
        }
        fault("backup.after_first_workspace");
        let members = call(c, "workspaces.memberSnapshot", json!({ "workspaceId": id })).unwrap_or(Value::Null);
        parts.push(json!({ "workspaceId": id, "storeUUID": w["storeUUID"], "executionUid": w["executionUid"], "workspaceIncarnation": w["workspaceIncarnation"], "members": members["members"], "checkpoint": r["result"] }));
    }
    let manifest = json!({ "formatVersion": 1, "kind": "agentos-machine-set", "setId": set_id, "machineInstallId": mid, "barrierId": barrier,
        "machineControlEpoch": st["meta"]["machineControlEpoch"], "workspaces": parts });
    let bytes = serde_json::to_vec(&manifest).unwrap_or_default();
    let mh = format!("sha256:{}", sha256_hex(&bytes));
    if std::fs::write(format!("{out_dir}/machine-set.json"), &bytes).is_err() {
        fail(c, "cannot write machine-set.json".into(), true);
    }
    if let Err(e) = call(c, "checkpoints.complete", json!({ "setId": set_id, "manifestHash": mh, "pinned": pinned })) {
        fail(c, e.to_string(), true);
    }
    let _ = call(c, "barrier.release", json!({ "barrierId": barrier }));
    let mut restarted = vec![];
    for id in &was_running {
        if call(c, "workspaces.rootStart", json!({ "workspaceId": id })).is_ok() {
            restarted.push(id.clone());
        }
    }
    out(&json!({ "ok": true, "setId": set_id, "manifestHash": mh, "workspaces": wss.len(), "restarted": restarted }));
}

fn bail(c: &mut Client, set_id: &str, barrier: &str, msg: String, begun: bool) -> ! {
    if begun {
        let _ = c.call("checkpoints.abandon", json!({ "setId": set_id }));
    }
    let _ = c.call("barrier.release", json!({ "barrierId": barrier }));
    die(&msg)
}

/// Same-machine restore (spec §24.1): verified → quiescing (control epoch raised, every session must rebind) →
/// staging → replacing (each workspace tree swapped by the recovery worker, cursor per workspace) → reconciling
/// (incarnation raised, backup members checked against the CURRENT directory: nobody revoked or disabled since comes
/// back) → complete. Interrupted at any point the machine stays restore-in-progress; `--restore-id` resumes.
fn restore(c: &mut Client, a: &[String]) {
    root_only("restore");
    let dir = arg(a, "--set").unwrap_or_else(|| die("usage: agentosctl restore --set <dir> [--restore-id <id>]"));
    let bytes = std::fs::read(format!("{dir}/machine-set.json")).unwrap_or_else(|_| die("not a machine set (machine-set.json missing)"));
    let set: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| die("machine-set.json is not JSON"));
    let set_id = set["setId"].as_str().unwrap_or_default().to_string();
    let rid = arg(a, "--restore-id").unwrap_or_else(uuid);
    let call = |c: &mut Client, op: &str, args: Value| c.call(op, args).unwrap_or_else(|e| die(&format!("{op}: {e}")));
    let cp = call(c, "checkpoints.get", json!({ "setId": set_id }));
    if cp["manifestHash"].as_str() != Some(&format!("sha256:{}", sha256_hex(&bytes))) {
        die("machine-set.json does not match the completed checkpoint record");
    }
    let mut job = call(c, "restores.plan", json!({ "restoreId": rid, "setId": set_id, "mode": "same-machine" }));
    let state = |j: &Value| j["state"].as_str().unwrap_or_default().to_string();
    let parts = set["workspaces"].as_array().cloned().unwrap_or_default();
    if state(&job) == "planned" {
        for p in &parts {
            let id = p["workspaceId"].as_str().unwrap_or_default();
            let v = rw(&["verify", "--set", &format!("{dir}/ws/{id}")]);
            if v["ok"] != true {
                call(c, "restores.advance", json!({ "restoreId": rid, "to": "abandoned" }));
                die(&format!("set part {id} failed verification: {}", v["error"]));
            }
        }
        job = call(c, "restores.advance", json!({ "restoreId": rid, "to": "verified" }));
    }
    if state(&job) == "verified" {
        job = call(c, "restores.advance", json!({ "restoreId": rid, "to": "quiescing" }));
    }
    if state(&job) == "quiescing" {
        for w in call(c, "workspaces.all", json!({}))["workspaces"].as_array().cloned().unwrap_or_default() {
            let _ = c.call("workspaces.rootStop", json!({ "workspaceId": w["workspaceId"] }));
        }
        job = call(c, "restores.advance", json!({ "restoreId": rid, "to": "staging" }));
    }
    if state(&job) == "staging" {
        job = call(c, "restores.advance", json!({ "restoreId": rid, "to": "replacing" }));
    }
    if state(&job) == "replacing" || state(&job) == "recovery_required" {
        if state(&job) == "recovery_required" {
            call(c, "restores.advance", json!({ "restoreId": rid, "to": "replacing" }));
        }
        for p in &parts {
            let id = p["workspaceId"].as_str().unwrap_or_default();
            let row = call(c, "workspaces.row", json!({ "workspaceId": id }));
            let uid = row["executionUid"].as_i64().unwrap_or(-1).to_string();
            let v = rw(&["restore", "--set", &format!("{dir}/ws/{id}"), "--ws-root", &format!("/var/lib/agentos/workspaces/{id}"), "--restore-id", &rid, "--uid", &uid, "--gid", &uid]);
            if v["ok"] != true {
                call(c, "restores.advance", json!({ "restoreId": rid, "to": "recovery_required" }));
                die(&format!("restore of {id} failed: {}; machine stays restore-in-progress (resume with --restore-id {rid})", v["error"]));
            }
            call(c, "restores.advance", json!({ "restoreId": rid, "to": "replacing", "cursor": id }));
            fault("restore.after_first_workspace");
        }
        job = call(c, "restores.advance", json!({ "restoreId": rid, "to": "reconciling" }));
    }
    let mut report = vec![];
    if state(&job) == "reconciling" {
        for p in &parts {
            let id = p["workspaceId"].as_str().unwrap_or_default();
            let inc = call(c, "restores.bumpIncarnation", json!({ "workspaceId": id, "restoreId": rid }));
            let m = call(c, "restores.reconcileMembers", json!({ "workspaceId": id, "members": p["members"] }));
            report.push(json!({ "workspaceId": id, "workspaceIncarnation": inc["workspaceIncarnation"], "members": m }));
        }
        job = call(c, "restores.advance", json!({ "restoreId": rid, "to": "complete" }));
    }
    out(&json!({ "ok": state(&job) == "complete", "restoreId": rid, "state": state(&job), "newControlEpoch": job["newControlEpoch"], "workspaces": report }));
}

/// After the machine directory was lost (V1-R11): accept a new installation identity. machined moves every remnant
/// (old secret, first-boot files, broker log) into a root-only lost-<time>/ directory as evidence and starts empty.
fn recover(a: &[String]) {
    root_only("recover");
    if !a.iter().any(|x| x == "--new-identity") {
        die("usage: agentosctl recover --new-identity");
    }
    let req = std::path::Path::new("/var/lib/agentos-machine/recovery-required");
    if !req.exists() {
        die("the machine is not in recovery mode");
    }
    agentos_machine::dir::write_private(std::path::Path::new("/var/lib/agentos-machine/recovery-accepted"), b"new-identity").unwrap_or_else(|e| die(&e.to_string()));
    let ok = std::process::Command::new("systemctl").args(["restart", "agentos-machine.service"]).status().map(|s| s.success()).unwrap_or(false);
    out(&json!({ "ok": ok, "accepted": "new-identity" }));
}

/// Words whose line may carry a secret value; such a line is kept only as a marker (spec §27.3).
const SECRET_WORDS: &[&str] = &["password", "passphrase", "passwd", "psk", "secret", "token", "cookie", "authorization", "api_key", "apikey", "private"];

pub fn redact_line(l: &str) -> String {
    let low = l.to_ascii_lowercase();
    match SECRET_WORDS.iter().find(|w| low.contains(*w)) {
        Some(w) => format!("[redacted line: mentions {w}]"),
        None => l.chars().take(400).collect(),
    }
}

/// Support bundle (spec §27.3, V1-O08): machine-level facts that locate a problem (release, boot, schema/protocol,
/// identity digest, registry sequence, executors, permits, barriers/restore, boot default) plus redacted service
/// logs. No workspace content (records, prompts), no secret value, no full machine identity. Root only, 0600.
fn support_bundle(c: &mut Client, a: &[String]) {
    root_only("support-bundle");
    let out_path = arg(a, "--out").unwrap_or_else(|| die("usage: agentosctl support-bundle --out <file>"));
    let st = c.call("status", json!({})).unwrap_or_else(|e| json!({ "error": e.to_string() }));
    let wss = c.call("workspaces.all", json!({})).unwrap_or(Value::Null);
    let upd = c.call("updates.current", json!({})).unwrap_or(Value::Null);
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap_or_default().trim().to_string();
    let mid = st["meta"]["machineInstallId"].as_str().unwrap_or_default().to_string();
    let mut st2 = st.clone();
    if let Some(m) = st2.get_mut("meta").and_then(|m| m.as_object_mut()) {
        m.remove("machineInstallId");
        m.remove("firstBootId");
    }
    let workspaces: Vec<Value> = wss["workspaces"].as_array().cloned().unwrap_or_default().into_iter().map(|w| {
        json!({ "workspaceId": w["workspaceId"], "state": w["state"], "executionUid": w["executionUid"], "instanceEpoch": w["instanceEpoch"],
                "workspaceIncarnation": w["workspaceIncarnation"], "runWhenLoggedOut": w["runWhenLoggedOut"] })
    }).collect();
    let journal = std::process::Command::new("journalctl")
        .args(["-u", "agentos-machine", "-u", "agentos-session-gateway", "-u", "agentos-broker", "-u", "agentos-desktop-session", "-n", "800", "-o", "short-iso", "--no-pager"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(redact_line).collect::<Vec<_>>())
        .unwrap_or_default();
    let release = std::fs::read_to_string("/etc/agentos/release.json").ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
    let bundle = json!({
        "kind": "agentos.support-bundle.v1",
        "createdAt": agentos_machine::util::now_ms(),
        "release": release,
        "bootId": boot,
        "machineIdentityDigest": format!("sha256:{}", &sha256_hex(mid.as_bytes())[..16]),
        "machine": st2,
        "workspaces": workspaces,
        "update": upd,
        "bootDefault": std::fs::read_to_string("/boot/loader/loader.conf").ok().and_then(|t| t.lines().find(|l| l.starts_with("default")).map(|l| l.to_string())),
        "restoreInProgress": std::path::Path::new("/var/lib/agentos-machine/restore-in-progress").exists(),
        "logs": journal,
        "redaction": "lines naming password/passphrase/psk/secret/token/cookie/authorization/api key/private are replaced by a marker; no workspace content is collected",
    });
    let bytes = serde_json::to_vec_pretty(&bundle).unwrap();
    agentos_machine::dir::write_private(std::path::Path::new(&out_path), &bytes).unwrap_or_else(|e| die(&format!("write {out_path}: {e}")));
    out(&json!({ "ok": true, "path": out_path, "bytes": bytes.len(), "logLines": bundle["logs"].as_array().map(|x| x.len()) }));
}

#[cfg(test)]
mod tests {
    use super::redact_line;

    #[test]
    fn o08_support_bundle_lines_naming_secrets_are_replaced() {
        assert_eq!(redact_line("wifi psk=hunter2"), "[redacted line: mentions psk]");
        assert_eq!(redact_line("Authorization: Bearer abc"), "[redacted line: mentions authorization]");
        assert_eq!(redact_line("set Password for alice"), "[redacted line: mentions password]");
        assert_eq!(redact_line("machined ready"), "machined ready");
        assert_eq!(redact_line(&"x".repeat(1000)).len(), 400);
    }
}
