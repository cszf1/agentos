//! Service worker (spec §14): fixed systemd D-Bus calls on catalog units only. Runs as agentos-svc; a polkit rule
//! installed by the administrator allows exactly start/stop/set-property on the catalog units for this UID.
use serde_json::{json, Value};
use std::time::{Duration, Instant};

use crate::{die, has_fault, Res, WErr};
use agentos_protocol::sysd;
use agentos_protocol::worker::WorkerRequest;

fn unit(req: &WorkerRequest) -> Result<String, WErr> {
    let u = req.target["unit"].as_str().ok_or_else(|| WErr::none("SERVICE_TARGET_NOT_REGISTERED", "target.unit missing"))?;
    if !u.starts_with("agentos-") || !u.ends_with(".service") || u.contains('/') {
        return Err(WErr::none("SERVICE_TARGET_NOT_REGISTERED", "only catalog agentos-*.service units are managed"));
    }
    Ok(u.to_string())
}

fn read_cg(d: &Value, file: &str) -> Option<String> {
    sysd::read_cg(d, file)
}

fn fragment_hash(d: &Value) -> String {
    let p = d["fragmentPath"].as_str().unwrap_or("");
    std::fs::read(p).map(|b| agentos_protocol::sha256_hex(&b)).unwrap_or_default()
}

pub fn observe_value(c: &zbus::blocking::Connection, u: &str) -> Res {
    let d = sysd::describe(c, u).map_err(|e| WErr::none("PROVIDER_UNAVAILABLE", e))?;
    let identity = json!({"unit": u, "fragmentPath": d["fragmentPath"], "fragmentHash": fragment_hash(&d), "loadState": d["loadState"], "bootId": agentos_protocol::boot_id()});
    // Version covers identity, state and the two modifiable limits — never CPU usage (spec §10).
    let version = agentos_protocol::domain_hash("agentos.service-version.v1", &json!({"identity": identity, "activeState": d["activeState"], "invocationId": d["invocationId"], "cpu": d["CPUQuotaPerSecUSec"], "mem": d["MemoryMax"]})).unwrap_or_default();
    Ok(json!({"identity": identity, "version": version, "details": d}))
}

pub fn handle(req: &WorkerRequest) -> Res {
    let u = unit(req)?;
    let c = sysd::system().map_err(|e| WErr::none("PROVIDER_UNAVAILABLE", e))?;
    let p = &req.params;
    match req.op.as_str() {
        "observe" => observe_value(&c, &u),
        "read" => {
            let o = observe_value(&c, &u)?;
            match p["capabilityId"].as_str() {
                Some("service.metrics") => Ok(json!({"unit": u, "metrics": sysd::metrics(&o["details"]), "activeState": o["details"]["activeState"]})),
                _ => Ok(o["details"].clone()),
            }
        }
        "ensure" => {
            let want = p["state"].as_str().unwrap_or("");
            if want != "running" && want != "stopped" {
                return Err(WErr::none("INVALID_SYSTEM_PLAN", "state must be running or stopped"));
            }
            let timeout = Duration::from_millis(p["timeoutMs"].as_u64().unwrap_or(15000).min(15000));
            let rx = sysd::job_listener(&c).map_err(|e| WErr::none("PROVIDER_UNAVAILABLE", e))?;
            let job = sysd::submit_job(&c, &u, want == "running").map_err(|e| WErr::unknown("SERVICE_STATE_UNCONFIRMED", e))?;
            if has_fault(req, "service.die_after_job") {
                die("service.die_after_job");
            }
            let (result, state) = sysd::wait_job(&c, &rx, &u, &job, Instant::now() + timeout);
            Ok(json!({"job": job, "jobResult": result, "state": state, "verifiedAtMs": agentos_protocol::now_ms()}))
        }
        "set_property" => {
            let prop = p["property"].as_str().unwrap_or("");
            if prop != "CPUQuotaPerSecUSec" && prop != "MemoryMax" {
                return Err(WErr::none("INVALID_SYSTEM_PLAN", "only CPUQuotaPerSecUSec or MemoryMax"));
            }
            let val = p["value"].as_u64().ok_or_else(|| WErr::none("INVALID_SYSTEM_PLAN", "value"))?;
            sysd::set_property(&c, &u, prop, val).map_err(|e| {
                if e.contains("AccessDenied") || e.contains("InvalidArgs") { WErr::none("BROKER_POLICY_DENIED", e) } else { WErr::unknown("SERVICE_STATE_UNCONFIRMED", e) }
            })?;
            if has_fault(req, "service.die_after_job") {
                die("service.die_after_job");
            }
            let d = sysd::describe(&c, &u).map_err(|e| WErr::unknown("SERVICE_STATE_UNCONFIRMED", e))?;
            let now = d[prop].as_u64();
            // Verify the kernel value too: cpu.max "<quota> <period>" or memory.max bytes.
            let (cg, matches) = if prop == "CPUQuotaPerSecUSec" {
                let s = read_cg(&d, "cpu.max");
                let ok = s.as_deref().map(|t| {
                    let mut it = t.split_whitespace();
                    let q = it.next().and_then(|x| x.parse::<u64>().ok());
                    let per = it.next().and_then(|x| x.parse::<u64>().ok()).unwrap_or(100000);
                    q.map(|q| q * 1_000_000 / per == val).unwrap_or(false)
                });
                (s, ok)
            } else {
                let s = read_cg(&d, "memory.max");
                let ok = s.as_deref().map(|t| t.parse::<u64>().ok() == Some(val));
                (s, ok)
            };
            // A unit that is not running has no cgroup; the property alone is then the evidence.
            let matches = matches.unwrap_or(d["activeState"] != "active");
            Ok(json!({"property": prop, "value": now, "cgroup": cg, "cgroupMatches": matches}))
        }
        _ => Err(WErr::none("INVALID_SYSTEM_PLAN", "unknown service op")),
    }
}
