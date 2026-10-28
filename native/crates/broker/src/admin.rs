//! Administrator entry points (root only; not reachable through the host socket): create the log for a fresh
//! install and inspect the registry, caps, log version, quarantines and unreconciled operations.
use rusqlite::params;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;

use crate::db;
use crate::policy;

pub fn main(args: &[String]) -> i32 {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("agentos-broker admin must run as root");
        return 1;
    }
    match args.first().map(|s| s.as_str()) {
        Some("install-db") => install_db(),
        Some("inspect") => inspect(),
        Some("policy-version") => match policy::load(policy::POLICY_PATH, true) {
            Ok((_, v)) => {
                println!("{v}");
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        _ => {
            eprintln!("usage: agentos-broker admin install-db | inspect | policy-version");
            2
        }
    }
}

fn install_db() -> i32 {
    let (pol, ver) = match policy::load(policy::POLICY_PATH, true) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("policy refused: {e}");
            return 1;
        }
    };
    let _ = std::fs::create_dir_all(db::BLOB_DIR);
    let _ = std::fs::set_permissions(db::DATA_DIR, std::fs::Permissions::from_mode(0o700));
    match db::create(db::DB_PATH, &pol.machine_install_id, &ver) {
        Ok(_) => {
            let _ = std::fs::set_permissions(db::DB_PATH, std::fs::Permissions::from_mode(0o600));
            println!("{}", json!({"created": db::DB_PATH, "machineInstallId": pol.machine_install_id, "policyVersion": ver}));
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

fn q(c: &rusqlite::Connection, sql: &str, cols: &[&str]) -> Vec<Value> {
    let Ok(mut st) = c.prepare(sql) else { return vec![] };
    st.query_map(params![], |r| {
        let mut m = serde_json::Map::new();
        for (i, k) in cols.iter().enumerate() {
            let v: rusqlite::types::Value = r.get(i)?;
            m.insert(
                (*k).into(),
                match v {
                    rusqlite::types::Value::Null => Value::Null,
                    rusqlite::types::Value::Integer(n) => json!(n),
                    rusqlite::types::Value::Real(f) => json!(f),
                    rusqlite::types::Value::Text(t) => json!(t),
                    rusqlite::types::Value::Blob(_) => json!("<blob>"),
                },
            );
        }
        Ok(Value::Object(m))
    })
    .map(|it| it.filter_map(|x| x.ok()).collect())
    .unwrap_or_default()
}

fn inspect() -> i32 {
    let pol = policy::load(policy::POLICY_PATH, true);
    let mut out = json!({
        "policy": match &pol { Ok((p, v)) => json!({"version": v, "machineInstallId": p.machine_install_id, "hosts": p.hosts, "units": p.units.iter().map(|u| json!({"key": u.key, "unit": u.unit, "cpu": [u.cpu_quota_per_sec_usec.min, u.cpu_quota_per_sec_usec.max], "memory": [u.memory_max.min, u.memory_max.max]})).collect::<Vec<_>>(), "managedRoots": p.managed_roots.iter().map(|m| json!({"key": m.key, "path": m.path, "quotaBytes": m.quota_bytes})).collect::<Vec<_>>(), "labNetworks": p.lab_networks.iter().map(|n| json!({"key": n.key, "profiles": n.profiles})).collect::<Vec<_>>(), "serial": p.serial.iter().map(|s| json!({"key": s.key, "kind": s.kind, "profile": s.profile})).collect::<Vec<_>>(), "testMode": p.test_mode}), Err(e) => json!({"error": e}) },
    });
    let c = match rusqlite::Connection::open_with_flags(db::DB_PATH, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(e) => {
            out["log"] = json!({"error": format!("{e}")});
            println!("{}", serde_json::to_string_pretty(&out).unwrap());
            return 3;
        }
    };
    out["log"] = json!({
        "schemaVersion": db::meta(&c, "schema_version"),
        "machineInstallId": db::meta(&c, "machine_install_id"),
        "seq": db::meta(&c, "seq"),
        "integrity": c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)).unwrap_or_else(|e| e.to_string()),
    });
    out["workspaces"] = json!(q(&c, "SELECT store_uuid, allowed_uid, incarnation, state FROM workspace_bindings", &["storeUUID", "uid", "incarnation", "state"]));
    out["resources"] = json!(q(&c, "SELECT resource_id, kind, catalog_key, generation, status, lock_operation_id, quarantine_operation_id FROM resource_state", &["resourceId", "kind", "key", "generation", "status", "lock", "quarantine"]));
    out["unreconciled"] = json!(q(
        &c,
        "SELECT operation_id, incarnation, capability_id, state, error_code FROM effect_operations WHERE state IN ('accepted','running','reconciling') OR (state='indeterminate' AND resolution_json IS NULL)",
        &["operationId", "incarnation", "capability", "state", "error"]
    ));
    out["counts"] = json!(q(&c, "SELECT state, count(*) FROM effect_operations GROUP BY state", &["state", "n"]));
    out["grants"] = json!(q(&c, "SELECT count(*), sum(revoked_seq IS NOT NULL) FROM broker_grants", &["total", "revoked"]));
    out["restores"] = json!(q(&c, "SELECT restore_request_id, previous_incarnation, target_incarnation, phase FROM restore_sessions", &["restoreRequestId", "from", "to", "phase"]));
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    0
}
