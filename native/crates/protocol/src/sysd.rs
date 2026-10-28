//! Fixed systemd D-Bus calls (spec §14). Only the methods listed here are used; destinations, paths and members are
//! constants, unit names come from the root-owned catalog. Properties are read with an explicit Properties.Get so no
//! cached value is ever reported as the current state.
use serde_json::{json, Value};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use zbus::blocking::{Connection, MessageIterator};
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

const DEST: &str = "org.freedesktop.systemd1";
const MGR_PATH: &str = "/org/freedesktop/systemd1";
const MGR: &str = "org.freedesktop.systemd1.Manager";

pub fn system() -> Result<Connection, String> {
    Connection::system().map_err(|e| format!("system bus: {e}"))
}

pub fn load_unit(c: &Connection, unit: &str) -> Result<OwnedObjectPath, String> {
    let m = c.call_method(Some(DEST), MGR_PATH, Some(MGR), "LoadUnit", &(unit,)).map_err(|e| format!("LoadUnit: {e}"))?;
    m.body().deserialize::<OwnedObjectPath>().map_err(|e| format!("LoadUnit reply: {e}"))
}

pub fn get(c: &Connection, path: &str, iface: &str, prop: &str) -> Result<OwnedValue, String> {
    let m = c.call_method(Some(DEST), path, Some("org.freedesktop.DBus.Properties"), "Get", &(iface, prop)).map_err(|e| format!("Get {prop}: {e}"))?;
    m.body().deserialize::<OwnedValue>().map_err(|e| format!("Get {prop} reply: {e}"))
}

fn s(c: &Connection, path: &str, iface: &str, prop: &str) -> Result<String, String> {
    String::try_from(get(c, path, iface, prop)?).map_err(|e| format!("{prop}: {e}"))
}
fn t(c: &Connection, path: &str, iface: &str, prop: &str) -> Result<u64, String> {
    u64::try_from(get(c, path, iface, prop)?).map_err(|e| format!("{prop}: {e}"))
}

/// Snapshot of the unit's identity, state and the two modifiable limits.
pub fn describe(c: &Connection, unit: &str) -> Result<Value, String> {
    let p = load_unit(c, unit)?;
    let path = p.as_str();
    let u = "org.freedesktop.systemd1.Unit";
    let svc = "org.freedesktop.systemd1.Service";
    let inv: Vec<u8> = Vec::<u8>::try_from(get(c, path, u, "InvocationID")?).unwrap_or_default();
    let load = s(c, path, u, "LoadState")?;
    let mut v = json!({
        "unit": unit,
        "loadState": load,
        "activeState": s(c, path, u, "ActiveState")?,
        "subState": s(c, path, u, "SubState")?,
        "invocationId": hex::encode(inv),
        "fragmentPath": s(c, path, u, "FragmentPath")?,
        "activeEnterTimestampUs": t(c, path, u, "ActiveEnterTimestamp").unwrap_or(0),
    });
    if load == "loaded" {
        v["controlGroup"] = json!(s(c, path, svc, "ControlGroup").unwrap_or_default());
        v["CPUQuotaPerSecUSec"] = json!(t(c, path, svc, "CPUQuotaPerSecUSec").unwrap_or(u64::MAX));
        v["MemoryMax"] = json!(t(c, path, svc, "MemoryMax").unwrap_or(u64::MAX));
        v["mainPid"] = json!(u32::try_from(get(c, path, svc, "MainPID")?).unwrap_or(0));
        v["nRestarts"] = json!(u32::try_from(get(c, path, svc, "NRestarts")?).unwrap_or(0));
    }
    Ok(v)
}

/// Subscribe to JobRemoved before submitting a job so the signal cannot be missed.
pub fn job_listener(c: &Connection) -> Result<mpsc::Receiver<(String, String, String)>, String> {
    c.call_method(Some(DEST), MGR_PATH, Some(MGR), "Subscribe", &()).map_err(|e| format!("Subscribe: {e}"))?;
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender(DEST)
        .map_err(|e| e.to_string())?
        .interface(MGR)
        .map_err(|e| e.to_string())?
        .member("JobRemoved")
        .map_err(|e| e.to_string())?
        .build();
    let it = MessageIterator::for_match_rule(rule, c, Some(64)).map_err(|e| format!("match: {e}"))?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for m in it {
            let Ok(m) = m else { break };
            if let Ok((_id, job, unit, result)) = m.body().deserialize::<(u32, OwnedObjectPath, String, String)>() {
                if tx.send((job.as_str().to_string(), unit, result)).is_err() {
                    break;
                }
            }
        }
    });
    Ok(rx)
}

pub fn submit_job(c: &Connection, unit: &str, start: bool) -> Result<String, String> {
    let method = if start { "StartUnit" } else { "StopUnit" };
    let m = c.call_method(Some(DEST), MGR_PATH, Some(MGR), method, &(unit, "replace")).map_err(|e| format!("{method}: {e}"))?;
    let p = m.body().deserialize::<OwnedObjectPath>().map_err(|e| format!("{method} reply: {e}"))?;
    Ok(p.as_str().to_string())
}

/// Wait for the job's JobRemoved; when the signal is lost, fall back to re-reading the unit until the deadline.
pub fn wait_job(c: &Connection, rx: &mpsc::Receiver<(String, String, String)>, unit: &str, job: &str, deadline: Instant) -> (Option<String>, Value) {
    let mut result = None;
    while Instant::now() < deadline {
        let left = deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(250));
        match rx.recv_timeout(left) {
            Ok((j, _u, r)) if j == job => {
                result = Some(r);
                break;
            }
            Ok(_) => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Signal not seen yet: if the unit no longer has a job pending, the job is done.
                if let Ok(d) = describe(c, unit) {
                    let st = d["activeState"].as_str().unwrap_or("");
                    if st != "activating" && st != "deactivating" && st != "reloading" {
                        if !job_exists(c, job) {
                            break;
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }
    let state = describe(c, unit).unwrap_or(Value::Null);
    (result, state)
}

pub fn job_exists(c: &Connection, job: &str) -> bool {
    get(c, job, "org.freedesktop.systemd1.Job", "State").is_ok()
}

pub fn set_property(c: &Connection, unit: &str, prop: &str, value: u64) -> Result<(), String> {
    let props: Vec<(&str, zbus::zvariant::Value)> = vec![(prop, zbus::zvariant::Value::U64(value))];
    c.call_method(Some(DEST), MGR_PATH, Some(MGR), "SetUnitProperties", &(unit, true, props)).map_err(|e| format!("SetUnitProperties: {e}"))?;
    Ok(())
}

/// Stop a unit and wait until it is inactive (used by the broker to fence workers of a previous instance).
pub fn stop_and_wait(c: &Connection, unit: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let _ = submit_job(c, unit, false)?;
    while Instant::now() < deadline {
        let d = describe(c, unit)?;
        let st = d["activeState"].as_str().unwrap_or("");
        if st == "inactive" || st == "failed" {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("{unit} did not stop within {timeout:?}"))
}

pub fn start_and_wait(c: &Connection, unit: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let _ = submit_job(c, unit, true)?;
    while Instant::now() < deadline {
        let d = describe(c, unit)?;
        if d["activeState"].as_str() == Some("active") {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("{unit} did not start within {timeout:?}"))
}

pub fn cg_path(d: &Value, file: &str) -> String {
    format!("/sys/fs/cgroup{}/{}", d["controlGroup"].as_str().unwrap_or("/nonexistent"), file)
}

pub fn read_cg(d: &Value, file: &str) -> Option<String> {
    std::fs::read_to_string(cg_path(d, file)).ok().map(|s| s.trim().to_string())
}

pub fn metrics(d: &Value) -> Value {
    let kv = |f: &str| -> Value {
        let mut m = serde_json::Map::new();
        for l in read_cg(d, f).unwrap_or_default().lines() {
            let mut it = l.split_whitespace();
            if let (Some(k), Some(v)) = (it.next(), it.next()) {
                if let Ok(n) = v.parse::<u64>() {
                    m.insert(k.into(), json!(n));
                }
            }
        }
        Value::Object(m)
    };
    let num = |f: &str| -> Value { read_cg(d, f).and_then(|s| s.parse::<u64>().ok()).map(|n| json!(n)).unwrap_or(Value::Null) };
    json!({
        "cpuStat": kv("cpu.stat"),
        "memoryCurrent": num("memory.current"),
        "memoryPeak": num("memory.peak"),
        "pidsCurrent": num("pids.current"),
        "memoryEvents": kv("memory.events"),
        "cpuMax": read_cg(d, "cpu.max"),
        "memoryMax": read_cg(d, "memory.max"),
        "sampledAtMs": crate::now_ms(),
    })
}

