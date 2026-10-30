//! agentosctl (spec §30): operator entry that calls the same machined service the Shell uses; it never opens a
//! database, never skips a plan or confirmation, and prints only bounded, redacted facts.
//!   agentosctl status | doctor | workspace list | workspace status <id> | update status
//!   agentosctl firstboot --admin <login> [--workspace <name>]   (root, only while first boot is open; password on stdin)
//!   agentosctl backup --out <dir> [--pinned] [--include-archived] (root: machine barrier, every workspace cold, one set)
//!   agentosctl backup export --set <dir> --recipient <age1…> --out <dir>  (root: age copy off the machine, read back)
//!   agentosctl restore --set <dir> [--restore-id <id>]         (root: same-machine restore journal, resumable)
//!   agentosctl recover --new-identity                          (root: accept a new install identity after loss)
//!   agentosctl clone --set <dir> --owner <login>               (root: a machine set from ANOTHER machine becomes new
//!                                                               workspaces here; history kept as evidence, no authority)
//!   agentosctl update digest --manifest <file>                 (the digest a release key signs)
//!   agentosctl update trust-key --key-id <id> --public-key <hex> (root: add a release verification key, audited)
//!   agentosctl update verify --manifest <file> --signature <file> [--trusted-time] [--images <index.json>]
//!                                                              (root: signature, key, fields, sequence, expiry, closure
//!                                                               content in the store, OCI image IDs; nothing registered)
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
        (Some("update"), Some("digest")) => {
            let m = read_json(&arg(&a, "--manifest").unwrap_or_else(|| die("usage: agentosctl update digest --manifest <file>")));
            out(&json!({ "manifestHash": agentos_machine::release::manifest_hash(&m) }));
        }
        (Some("update"), Some("trust-key")) => {
            root_only("update trust-key");
            let id = arg(&a, "--key-id").unwrap_or_else(|| die("usage: agentosctl update trust-key --key-id <id> --public-key <hex>"));
            let pk = arg(&a, "--public-key").unwrap_or_else(|| die("usage: agentosctl update trust-key --key-id <id> --public-key <hex>"));
            call(&mut c, "releases.addKey", json!({ "keyId": id, "publicKey": pk }));
            out(&json!({ "ok": true, "keyId": id }));
        }
        (Some("update"), Some("verify")) => {
            root_only("update verify");
            update_verify(&mut c, &a);
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
        (Some("clone"), _) => clone(&mut c, &a),
        _ => die("usage: agentosctl status | doctor | workspace list | workspace status <id> | update status | firstboot --admin <login> | support-bundle --out <file>"),
    }
}

fn read_json(path: &str) -> Value {
    let t = std::fs::read_to_string(path).unwrap_or_else(|e| die(&format!("UPDATE_SIGNATURE_INVALID: release file {path} missing or unreadable: {e}")));
    serde_json::from_str(&t).unwrap_or_else(|_| die(&format!("UPDATE_SIGNATURE_INVALID: {path} is not JSON")))
}

fn update_worker() -> String {
    std::env::var("AGENTOS_UPDATE_WORKER").unwrap_or_else(|_| "/run/current-system/sw/bin/agentos-update-worker".into())
}

/// Release verification (spec §20, V1-U04): every part must hold or nothing is accepted. The machined verifier
/// checks the strict manifest schema, the trusted key, the signature over the manifest digest, the sequence
/// high-water mark and expiry; the store must hold exactly the closure the manifest lists (NAR hashes, nothing
/// more or less); the OCI index shipped with the release must carry exactly the signed image IDs. Missing files are
/// a refusal, never a skip. Nothing is registered here.
fn update_verify(c: &mut Client, a: &[String]) {
    let usage = "usage: agentosctl update verify --manifest <file> --signature <file> [--trusted-time] [--images <index.json>]";
    let mpath = arg(a, "--manifest").unwrap_or_else(|| die(usage));
    let spath = arg(a, "--signature").unwrap_or_else(|| die(usage));
    let m = read_json(&mpath);
    let sig = std::fs::read_to_string(&spath).unwrap_or_else(|e| die(&format!("UPDATE_SIGNATURE_INVALID: signature file {spath} missing: {e}")));
    let trusted = a.iter().any(|x| x == "--trusted-time");
    let v = c.call("releases.verify", json!({ "manifest": m, "signature": sig.trim(), "trustedTime": trusted })).unwrap_or_else(|e| die(&e.to_string()));
    let closure = m["baseClosurePath"].as_str().unwrap_or_default();
    if !closure.starts_with("/nix/store/") || !std::path::Path::new(closure).exists() {
        die(&format!("UPDATE_CONTENT_MISMATCH: base closure {closure} is not in the store"));
    }
    let pi = std::process::Command::new("nix").args(["--extra-experimental-features", "nix-command", "path-info", "--json", "--recursive", closure]).output().unwrap_or_else(|e| die(&format!("nix path-info: {e}")));
    if !pi.status.success() {
        die(&format!("UPDATE_CONTENT_MISMATCH: nix path-info failed: {}", String::from_utf8_lossy(&pi.stderr).trim()));
    }
    let tmp = std::env::temp_dir().join(format!("agentosctl-pathinfo-{}", uuid()));
    agentos_machine::dir::write_private(&tmp, &pi.stdout).unwrap_or_else(|e| die(&e.to_string()));
    let o = std::process::Command::new(update_worker()).args(["verify-content", "--manifest", &mpath, "--path-info"]).arg(&tmp).output();
    let _ = std::fs::remove_file(&tmp);
    let o = o.unwrap_or_else(|e| die(&format!("update worker: {e}")));
    let r: Value = String::from_utf8_lossy(&o.stdout).lines().rev().find_map(|l| serde_json::from_str(l).ok()).unwrap_or(Value::Null);
    if r["ok"] != true {
        die(&format!("UPDATE_CONTENT_MISMATCH: {}", r["error"]["message"].as_str().unwrap_or("closure check failed")));
    }
    let mut images = Value::Null;
    if let Some(ix) = arg(a, "--images") {
        let idx = read_json(&ix);
        let mut got: Vec<String> = idx["images"].as_array().cloned().unwrap_or_default().iter().filter_map(|i| i["imageId"].as_str().map(String::from)).collect();
        let mut want: Vec<String> = m["ociDigests"].as_array().cloned().unwrap_or_default().iter().filter_map(|i| i.as_str().map(String::from)).collect();
        got.sort();
        want.sort();
        if got != want {
            die("UPDATE_CONTENT_MISMATCH: the shipped OCI images are not exactly the signed ociDigests");
        }
        let archive = std::path::Path::new(&ix).with_file_name(idx["archive"].as_str().unwrap_or("images.tar"));
        if !archive.is_file() {
            die(&format!("UPDATE_CONTENT_MISMATCH: OCI archive {} missing", archive.display()));
        }
        images = json!(got.len());
    }
    out(&json!({ "ok": true, "releaseId": v["releaseId"], "manifestHash": v["manifestHash"], "closurePaths": r["result"]["paths"], "ociImages": images }));
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
    if a.get(2).map(|s| s.as_str()) == Some("export") {
        return export(c, a);
    }
    let out_dir = arg(a, "--out").unwrap_or_else(|| die("usage: agentosctl backup --out <dir> [--pinned]"));
    let pinned = a.iter().any(|x| x == "--pinned");
    let with_archived = a.iter().any(|x| x == "--include-archived");
    let set_id = uuid();
    let call = |c: &mut Client, op: &str, args: Value| c.call(op, args);
    let st = call(c, "status", json!({})).unwrap_or_else(|e| die(&e.to_string()));
    let mid = st["meta"]["machineInstallId"].as_str().unwrap_or_default().to_string();
    let barrier = call(c, "barrier.hold", json!({ "ownerKind": "checkpoint", "ownerId": set_id, "scope": { "kind": "machine" } })).unwrap_or_else(|e| die(&e.to_string()));
    let barrier = barrier["barrierId"].as_str().unwrap_or_default().to_string();
    let wss: Vec<Value> = call(c, "workspaces.all", json!({})).map(|v| v["workspaces"].as_array().cloned().unwrap_or_default()).unwrap_or_default();
    // archived workspaces are already cold; they are part of the set only when asked (an export before deletion)
    let wss: Vec<Value> = wss.into_iter().filter(|w| match w["state"].as_str() { Some("deleting" | "deleted") => false, Some("archived") => with_archived, _ => true }).collect();
    let was_running: Vec<String> = wss.iter().filter(|w| matches!(w["state"].as_str(), Some("running" | "starting"))).map(|w| w["workspaceId"].as_str().unwrap_or_default().to_string()).collect();
    let fail = |c: &mut Client, msg: String, begun: bool| bail(c, &set_id, &barrier, msg, begun, &was_running);
    // the set is opened first: a full or read-only disk (R12) refuses it before any workspace is stopped
    if let Err(e) = call(c, "checkpoints.begin", json!({ "setId": set_id, "scope": "machine", "barrierId": barrier })) {
        fail(c, e.to_string(), false);
    }
    for w in &wss {
        let id = w["workspaceId"].as_str().unwrap_or_default();
        match call(c, "workspaces.rootStop", json!({ "workspaceId": id })) {
            // an archived workspace (included with --include-archived) is already cold and stays archived
            Ok(r) if r["state"] == "stopped" || (r["state"] == "archived" && w["state"] == "archived") => {}
            Ok(r) => fail(c, format!("workspace {id} did not stop cleanly ({})", r["state"]), true),
            Err(e) => fail(c, format!("workspace {id}: {e}"), true),
        }
    }
    let _ = std::fs::create_dir_all(format!("{out_dir}/ws"));
    let mut parts = vec![];
    let mut never_started = vec![];
    for w in &wss {
        let id = w["workspaceId"].as_str().unwrap_or_default();
        let dest = format!("{out_dir}/ws/{id}");
        let data = format!("/var/lib/agentos/workspaces/{id}/data");
        // A workspace whose Host never ran has no databases and nothing to restore: it is named in the set
        // (`neverStarted`) instead of failing the whole machine set. One database without the other stays an error.
        let (os_db, agent_db) = (std::path::Path::new(&format!("{data}/os.sqlite")).exists(), std::path::Path::new(&format!("{data}/agent.sqlite")).exists());
        if !os_db && !agent_db {
            never_started.push(json!({ "workspaceId": id, "storeUUID": w["storeUUID"] }));
            continue;
        }
        let r = rw(&["checkpoint", "--data", &data, "--out", &dest, "--set-id", &set_id, "--workspace-id", id, "--barrier-id", &barrier, "--machine-install-id", &mid]);
        if r["ok"] != true {
            fail(c, format!("checkpoint of {id} failed: {}", r["error"]), true);
        }
        fault("backup.after_first_workspace");
        let members = call(c, "workspaces.memberSnapshot", json!({ "workspaceId": id })).unwrap_or(Value::Null);
        parts.push(json!({ "workspaceId": id, "displayName": w["displayName"], "storeUUID": w["storeUUID"], "executionUid": w["executionUid"], "workspaceIncarnation": w["workspaceIncarnation"], "members": members["members"], "checkpoint": r["result"] }));
    }
    let manifest = json!({ "formatVersion": 1, "kind": "agentos-machine-set", "setId": set_id, "machineInstallId": mid, "barrierId": barrier,
        "machineControlEpoch": st["meta"]["machineControlEpoch"], "workspaces": parts, "neverStarted": never_started });
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

/// Off-machine copy of a complete machine set (spec §23.3/§24, V1-R12): the set stays labelled `local` until every
/// part was written as an age archive to the target and read back from there with a matching hash; only then is
/// the set's export state `exported` and, after the read-back of the manifest copy, `verified`. A failure leaves
/// the state at `none` (never `exported`).
fn export(c: &mut Client, a: &[String]) {
    let usage = "usage: agentosctl backup export --set <dir> --recipient <age1…> --out <dir>";
    let dir = arg(a, "--set").unwrap_or_else(|| die(usage));
    let rec = arg(a, "--recipient").unwrap_or_else(|| die(usage));
    let out_dir = arg(a, "--out").unwrap_or_else(|| die(usage));
    let bytes = std::fs::read(format!("{dir}/machine-set.json")).unwrap_or_else(|e| die(&format!("machine-set.json: {e}")));
    let set: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| die("machine-set.json is not JSON"));
    let set_id = set["setId"].as_str().unwrap_or_else(|| die("machine-set.json has no setId")).to_string();
    let rec_set = c.call("checkpoints.get", json!({ "setId": set_id })).unwrap_or_else(|e| die(&e.to_string()));
    let mh = format!("sha256:{}", sha256_hex(&bytes));
    if rec_set["state"] != "complete" || rec_set["manifestHash"].as_str() != Some(mh.as_str()) {
        die("the set on disk is not the complete set machined recorded (manifest hash differs)");
    }
    if std::path::Path::new(&out_dir).exists() {
        die(&format!("{out_dir} exists"));
    }
    std::fs::create_dir_all(&out_dir).unwrap_or_else(|e| die(&format!("{out_dir}: {e}")));
    if rec_set["exportState"] != "exported" && rec_set["exportState"] != "verified" {
        c.call("checkpoints.exportState", json!({ "setId": set_id, "state": "exporting" })).unwrap_or_else(|e| die(&e.to_string()));
    }
    let undo = |c: &mut Client, msg: String| -> ! {
        let _ = c.call("checkpoints.exportState", json!({ "setId": set_id, "state": "none" }));
        die(&msg)
    };
    let mut files = vec![];
    for w in set["workspaces"].as_array().cloned().unwrap_or_default() {
        let id = w["workspaceId"].as_str().unwrap_or_default().to_string();
        let target = format!("{out_dir}/ws-{id}.age");
        let r = rw(&["export", "--set", &format!("{dir}/ws/{id}"), "--recipient", &rec, "--out", &target]);
        if r["ok"] != true {
            undo(c, format!("export of {id} failed: {}", r["error"]));
        }
        files.push((target, r["result"]["ciphertextSha256"].as_str().unwrap_or_default().to_string()));
    }
    // the manifest itself (members, epochs) is encrypted to the same recipient
    let mpath = format!("{out_dir}/machine-set.json.age");
    let age = std::env::var("AGENTOS_AGE").unwrap_or_else(|_| "age".into());
    let st = std::process::Command::new(&age).args(["-r", &rec, "-o", &mpath, &format!("{dir}/machine-set.json")]).status();
    if !matches!(st, Ok(s) if s.success()) {
        undo(c, "age could not encrypt machine-set.json".into());
    }
    let mb = std::fs::read(&mpath).unwrap_or_else(|e| undo(c, format!("{mpath}: {e}")));
    let msum = sha256_hex(&mb);
    let _ = std::fs::write(format!("{mpath}.sha256"), format!("{msum}  machine-set.json.age\n"));
    files.push((mpath, msum));
    let _ = std::fs::File::open(&out_dir).and_then(|f| f.sync_all());
    c.call("checkpoints.exportState", json!({ "setId": set_id, "state": "exported" })).unwrap_or_else(|e| die(&e.to_string()));
    // read every file back from the target and compare with what was written
    for (f, h) in &files {
        let b = std::fs::read(f).unwrap_or_else(|e| die(&format!("read back {f}: {e} (set stays exported, not verified)")));
        if h.is_empty() || &sha256_hex(&b) != h {
            die(&format!("read back {f}: hash differs (set stays exported, not verified)"));
        }
    }
    c.call("checkpoints.exportState", json!({ "setId": set_id, "state": "verified" })).unwrap_or_else(|e| die(&e.to_string()));
    let after = c.call("checkpoints.get", json!({ "setId": set_id })).unwrap_or(Value::Null);
    out(&json!({ "ok": true, "setId": set_id, "files": files.iter().map(|(f, h)| json!({ "path": f, "sha256": h })).collect::<Vec<_>>(),
        "exportState": after["exportState"], "offMachineCopy": after["offMachineCopy"] }));
}

/// A UUID derived from stable inputs, so a repeated or resumed clone names the same workspace and journal.
fn derived_uuid(parts: &[&str]) -> String {
    let h = sha256_hex(parts.join("\u{1f}").as_bytes());
    format!("{}-{}-4{}-8{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

/// Cross-machine clone (spec §24.2, V1-R10). The set comes from ANOTHER machine (a same-machine set is restored, not
/// cloned). Every part becomes a NEW workspace here: machined allocates a new execution UID, sub-ID range and account
/// for the named local owner (the source machine's users, passwords and sessions do not exist here); the part's
/// tree is restored into it, owned by the new UID, and a clone marker makes the Host reconcile before it opens
/// anything (grants revoked, outboxes never dispatched, devices quarantined, policies need review, membership from
/// this machine only). The source machine's history stays in the data as evidence. Resumable: the same set gives the
/// same create ids and journal ids.
fn clone(c: &mut Client, a: &[String]) {
    root_only("clone");
    let usage = "usage: agentosctl clone --set <dir> --owner <login>";
    let dir = arg(a, "--set").unwrap_or_else(|| die(usage));
    let owner_login = arg(a, "--owner").unwrap_or_else(|| die(usage));
    let bytes = std::fs::read(format!("{dir}/machine-set.json")).unwrap_or_else(|_| die("not a machine set (machine-set.json missing)"));
    let set: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| die("machine-set.json is not JSON"));
    let set_id = set["setId"].as_str().unwrap_or_else(|| die("machine-set.json has no setId")).to_string();
    let src_mid = set["machineInstallId"].as_str().unwrap_or_default().to_string();
    let call = |c: &mut Client, op: &str, args: Value| c.call(op, args).unwrap_or_else(|e| die(&format!("{op}: {e}")));
    let st = call(c, "status", json!({}));
    if st["meta"]["machineInstallId"].as_str() == Some(src_mid.as_str()) {
        die("CONFLICT: this set was taken on this machine; use `agentosctl restore`, a clone is for another machine");
    }
    let users = call(c, "users.list", json!({}));
    let owner = users["users"].as_array().cloned().unwrap_or_default().into_iter().find(|u| u["loginName"].as_str() == Some(owner_login.as_str()) && u["state"] == "active")
        .unwrap_or_else(|| die(&format!("no active local user {owner_login} on this machine")));
    let owner_id = owner["userId"].as_str().unwrap_or_default().to_string();
    let parts = set["workspaces"].as_array().cloned().unwrap_or_default();
    // every part is verified before anything is created
    for p in &parts {
        let id = p["workspaceId"].as_str().unwrap_or_default();
        let v = rw(&["verify", "--set", &format!("{dir}/ws/{id}")]);
        if v["ok"] != true {
            die(&format!("set part {id} failed verification: {}", v["error"]));
        }
        if v["result"]["storeUUID"].is_string() && v["result"]["storeUUID"] != p["storeUUID"] {
            die(&format!("set part {id}: storeUUID differs from machine-set.json"));
        }
    }
    let mut report = vec![];
    for p in &parts {
        let old = p["workspaceId"].as_str().unwrap_or_default().to_string();
        let create_id = derived_uuid(&["clone-create", &set_id, &old]);
        let name = p["displayName"].as_str().map(String::from).unwrap_or_else(|| format!("Cloned {}", &old[..8.min(old.len())]));
        let w = call(c, "workspaces.createFor", json!({ "createId": create_id, "ownerUserId": owner_id, "displayName": name, "storeUUID": p["storeUUID"], "origin": "cloned" }));
        let ws = w["workspaceId"].as_str().unwrap_or_else(|| die("machined did not return the new workspace")).to_string();
        let _ = c.call("workspaces.rootStop", json!({ "workspaceId": ws }));
        let row = call(c, "workspaces.row", json!({ "workspaceId": ws }));
        let uid = row["executionUid"].as_i64().unwrap_or(-1);
        if uid <= 0 {
            die(&format!("workspace {ws} has no execution UID"));
        }
        let root = format!("/var/lib/agentos/workspaces/{ws}");
        let rid = derived_uuid(&["clone-restore", &set_id, &old]);
        let v = rw(&["restore", "--set", &format!("{dir}/ws/{old}"), "--ws-root", &root, "--restore-id", &rid, "--uid", &uid.to_string(), "--gid", &uid.to_string()]);
        if v["ok"] != true {
            die(&format!("clone of {old} into {ws} failed: {} (run the same command again to resume)", v["error"]));
        }
        let marker = format!("{root}/data/clone-reconcile-pending");
        let body = json!({ "workspaceId": ws, "sourceWorkspaceId": old, "sourceMachineInstallId": src_mid, "setId": set_id }).to_string();
        // a resumed run writes the marker only while the Host has not started since the swap (the restore marker is
        // still there); a clone the Host already reconciled is never reconciled twice
        if v["result"]["resumed"] != true || std::path::Path::new(&format!("{root}/data/restore-reconcile-pending")).exists() {
            agentos_machine::dir::write_private(std::path::Path::new(&marker), body.as_bytes()).unwrap_or_else(|e| die(&e.to_string()));
            unsafe {
                let cpath = std::ffi::CString::new(marker.clone()).unwrap();
                if libc::chown(cpath.as_ptr(), uid as u32, uid as u32) != 0 {
                    die("cannot hand the clone marker to the execution UID");
                }
            }
        }
        report.push(json!({ "sourceWorkspaceId": old, "workspaceId": ws, "executionUid": uid, "storeUUID": p["storeUUID"], "owner": owner_login }));
    }
    out(&json!({ "ok": true, "setId": set_id, "sourceMachineInstallId": src_mid, "machineInstallId": st["meta"]["machineInstallId"], "workspaces": report }));
}

fn bail(c: &mut Client, set_id: &str, barrier: &str, msg: String, begun: bool, was_running: &[String]) -> ! {
    if begun {
        let _ = c.call("checkpoints.abandon", json!({ "setId": set_id }));
    }
    let _ = c.call("barrier.release", json!({ "barrierId": barrier }));
    // a refused or failed backup gives the machine back as it found it
    for id in was_running {
        let _ = c.call("workspaces.rootStart", json!({ "workspaceId": id }));
    }
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
