//! agentosctl (spec §30): operator entry that calls the same machined service the Shell uses; it never opens a
//! database, never skips a plan or confirmation, and prints only bounded, redacted facts.
//!   agentosctl status | doctor | workspace list | workspace status <id> | update status
//!   agentosctl firstboot --admin <login> [--workspace <name>]   (root, only while first boot is open; password on stdin)
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
    let mut c = Client::connect(&sock()).unwrap_or_else(|e| die(&format!("machine service unreachable: {e}")));
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
        _ => die("usage: agentosctl status | doctor | workspace list | workspace status <id> | update status | firstboot --admin <login>"),
    }
}
