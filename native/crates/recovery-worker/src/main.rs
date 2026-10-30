//! CLI for the fixed recovery steps. machined invokes it with typed arguments; output is one JSON line.
//!   checkpoint --data DIR --out DIR --set-id ID --workspace-id ID --barrier-id ID --machine-install-id ID [--release-id R]
//!   verify --set DIR
//!   export --set DIR --recipient age1... --out FILE
//!   import --in FILE --identity FILE --staging DIR [--max-bytes N]
//!   restore --set DIR --ws-root DIR --restore-id ID --uid N --gid N
use agentos_recovery_worker::{cold, export};
use serde_json::json;
use std::path::PathBuf;

fn arg(a: &[String], n: &str) -> Option<String> {
    a.iter().position(|x| x == n).and_then(|i| a.get(i + 1).cloned())
}
fn req(a: &[String], n: &str) -> String {
    arg(a, n).unwrap_or_else(|| {
        println!("{}", json!({ "ok": false, "error": { "code": "INVALID_REQUEST", "message": format!("{n} is required") } }));
        std::process::exit(2)
    })
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let cmd = a.get(1).cloned().unwrap_or_default();
    let p = |n: &str| PathBuf::from(req(&a, n));
    let r = match cmd.as_str() {
        "checkpoint" => cold::checkpoint(&p("--data"), &p("--out"), &cold::CheckpointInput {
            set_id: &req(&a, "--set-id"), workspace_id: &req(&a, "--workspace-id"), barrier_id: &req(&a, "--barrier-id"),
            machine_install_id: &req(&a, "--machine-install-id"), release_id: &arg(&a, "--release-id").unwrap_or_default(),
            incarnation: arg(&a, "--incarnation").and_then(|x| x.parse().ok()).unwrap_or(1),
            member_version: arg(&a, "--member-version").and_then(|x| x.parse().ok()).unwrap_or(1),
            broker_checkpoint_seq: arg(&a, "--broker-seq").and_then(|x| x.parse().ok()).unwrap_or(0),
            unknown_effects: json!([]),
        }),
        "verify" => cold::verify_set(&p("--set")),
        "export" => export::export(&p("--set"), &req(&a, "--recipient"), &p("--out")),
        "import" => export::import(&p("--in"), &p("--identity"), &p("--staging"), arg(&a, "--max-bytes").and_then(|x| x.parse().ok()).unwrap_or(8 << 30)),
        "restore" => cold::restore(&p("--set"), &p("--ws-root"), &req(&a, "--restore-id"), req(&a, "--uid").parse().unwrap_or(u32::MAX), req(&a, "--gid").parse().unwrap_or(u32::MAX)),
        _ => Err(cold::CErr("INVALID_REQUEST", "unknown command".into())),
    };
    match r {
        Ok(v) => println!("{}", json!({ "ok": true, "result": v })),
        Err(e) => {
            println!("{}", json!({ "ok": false, "error": { "code": e.0, "message": e.1 } }));
            std::process::exit(1)
        }
    }
}
