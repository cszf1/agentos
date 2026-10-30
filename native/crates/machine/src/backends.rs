//! Real machine-control backends (spec §12.1): NetworkManager, logind and timedated over the system D-Bus, plus the
//! account flows. Every backend reports the real resource state before and after; a successful method call is not
//! taken as proof that the effect happened. Unsupported capabilities return HARDWARE_UNSUPPORTED, never success.
use crate::dir::Machine;
use crate::err::{MErr, R};
use crate::ops::Executor;
use crate::util::{hash, now_ms, uuid};
use serde_json::{json, Value};
use std::collections::HashMap;
use zbus::blocking::Connection;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value as ZValue};

pub fn static_code(c: &str) -> &'static str {
    const CODES: &[&str] = &[
        "SESSION_REQUIRED", "SESSION_LOCKED", "SESSION_STALE", "MEMBERSHIP_REVOKED", "REGISTRY_NOT_SYNCED", "WORKSPACE_FENCED", "STORE_ALREADY_REGISTERED",
        "CLIENT_EPOCH_STALE", "PLAN_STALE", "MACHINE_CAPACITY", "PERMIT_RECONCILING", "UPDATE_SIGNATURE_INVALID", "RELEASE_REPLAYED", "ROLLBACK_INCOMPATIBLE",
        "MIGRATION_REQUIRED", "CHECKPOINT_INCOMPLETE", "RESTORE_IN_PROGRESS", "EFFECT_UNKNOWN", "RESOURCE_QUARANTINED", "HARDWARE_UNSUPPORTED",
        "NATIVE_RENDER_UNSUPPORTED", "NOT_FOUND_OR_FORBIDDEN", "INVALID_REQUEST", "CONFLICT", "STORE_UNAVAILABLE", "SYSTEM_FAILED", "INTERNAL", "EVENT_GAP",
        "FAILED_NO_EFFECT", "LIMIT_EXCEEDED",
    ];
    CODES.iter().find(|x| **x == c).copied().unwrap_or("INTERNAL")
}

/// Short-lived in-memory secrets (passwords, Wi-Fi keys) handed in on a protected frame and consumed once by id.
/// Never persisted, never logged; zeroed on use and after 120 s.
#[derive(Default)]
pub struct SecretStore {
    items: HashMap<String, (String, Vec<u8>, i64)>,
}

impl SecretStore {
    pub fn put(&mut self, kind: &str, value: &[u8]) -> R<String> {
        if !matches!(kind, "password" | "wifi-psk") || value.is_empty() || value.len() > 512 {
            return Err(MErr::new("INVALID_REQUEST", "bad secret"));
        }
        let id = format!("secret:{}", uuid());
        self.items.insert(id.clone(), (kind.to_string(), value.to_vec(), now_ms() + 120_000));
        Ok(id)
    }
    pub fn take(&mut self, id: &str) -> R<Vec<u8>> {
        self.items.remove(id).map(|(_, v, _)| v).ok_or_else(|| MErr::new("SESSION_STALE", "secret reference expired"))
    }
    pub fn expire(&mut self) {
        let now = now_ms();
        self.items.retain(|_, (_, v, exp)| {
            if *exp < now {
                v.iter_mut().for_each(|b| *b = 0);
                false
            } else {
                true
            }
        });
    }
}

fn dbus() -> R<Connection> {
    Connection::system().map_err(|e| MErr::new("HARDWARE_UNSUPPORTED", format!("system bus unavailable: {e}")))
}

fn prop(c: &Connection, dest: &str, path: &str, iface: &str, name: &str) -> R<OwnedValue> {
    let p = zbus::blocking::fdo::PropertiesProxy::builder(c).destination(dest.to_string()).and_then(|b| b.path(path.to_string())).and_then(|b| b.build()).map_err(|e| MErr::new("HARDWARE_UNSUPPORTED", e.to_string()))?;
    p.get(iface.try_into().map_err(|_| MErr::new("INTERNAL", "iface"))?, name).map_err(|e| MErr::new("HARDWARE_UNSUPPORTED", e.to_string()))
}

fn nm_device(c: &Connection, iface: &str) -> R<OwnedObjectPath> {
    let r = c
        .call_method(Some("org.freedesktop.NetworkManager"), "/org/freedesktop/NetworkManager", Some("org.freedesktop.NetworkManager"), "GetDeviceByIpIface", &(iface,))
        .map_err(|e| MErr::new("HARDWARE_UNSUPPORTED", format!("no such network device: {e}")))?;
    r.body().deserialize::<OwnedObjectPath>().map_err(|e| MErr::new("INTERNAL", e.to_string()))
}

/// Device state as NetworkManager reports it, plus the active connection's id: the resource generation input.
pub fn nm_device_state(iface: &str) -> R<Value> {
    let c = dbus()?;
    let dev = nm_device(&c, iface)?;
    let state: u32 = prop(&c, "org.freedesktop.NetworkManager", dev.as_str(), "org.freedesktop.NetworkManager.Device", "State")?.try_into().unwrap_or(0);
    let dtype: u32 = prop(&c, "org.freedesktop.NetworkManager", dev.as_str(), "org.freedesktop.NetworkManager.Device", "DeviceType")?.try_into().unwrap_or(0);
    let ac: OwnedObjectPath = prop(&c, "org.freedesktop.NetworkManager", dev.as_str(), "org.freedesktop.NetworkManager.Device", "ActiveConnection")?.try_into().map_err(|_| MErr::new("INTERNAL", "ac"))?;
    let mut ac_id = String::new();
    if ac.as_str() != "/" {
        if let Ok(v) = prop(&c, "org.freedesktop.NetworkManager", ac.as_str(), "org.freedesktop.NetworkManager.Connection.Active", "Id") {
            ac_id = String::try_from(v).unwrap_or_default();
        }
    }
    Ok(json!({ "iface": iface, "state": state, "deviceType": dtype, "activeConnection": ac_id, "connected": state == 100 }))
}

pub fn nm_overview() -> Value {
    let c = match dbus() {
        Ok(c) => c,
        Err(e) => return json!({ "available": false, "reason": e.message }),
    };
    let r = c.call_method(Some("org.freedesktop.NetworkManager"), "/org/freedesktop/NetworkManager", Some("org.freedesktop.NetworkManager"), "GetDevices", &());
    let devs: Vec<OwnedObjectPath> = match r.and_then(|m| m.body().deserialize().map_err(Into::into)) {
        Ok(d) => d,
        Err(e) => return json!({ "available": false, "reason": e.to_string() }),
    };
    let mut out = vec![];
    for d in devs {
        let iface: String = prop(&c, "org.freedesktop.NetworkManager", d.as_str(), "org.freedesktop.NetworkManager.Device", "Interface").ok().and_then(|v| String::try_from(v).ok()).unwrap_or_default();
        if iface == "lo" || iface.is_empty() {
            continue;
        }
        if let Ok(s) = nm_device_state(&iface) {
            out.push(s);
        }
    }
    let conn: u32 = prop(&c, "org.freedesktop.NetworkManager", "/org/freedesktop/NetworkManager", "org.freedesktop.NetworkManager", "Connectivity").ok().and_then(|v| u32::try_from(v).ok()).unwrap_or(0);
    json!({ "available": true, "devices": out, "connectivity": conn })
}

fn logind_call(method: &str, arg: bool) -> R<()> {
    let c = dbus()?;
    c.call_method(Some("org.freedesktop.login1"), "/org/freedesktop/login1", Some("org.freedesktop.login1.Manager"), method, &(arg,)).map(|_| ()).map_err(|e| MErr::new("SYSTEM_FAILED", e.to_string()))
}

fn logind_can(what: &str) -> String {
    dbus()
        .ok()
        .and_then(|c| c.call_method(Some("org.freedesktop.login1"), "/org/freedesktop/login1", Some("org.freedesktop.login1.Manager"), what, &()).ok())
        .and_then(|m| m.body().deserialize::<String>().ok())
        .unwrap_or_else(|| "na".into())
}

pub fn timezone() -> R<String> {
    let c = dbus()?;
    prop(&c, "org.freedesktop.timedate1", "/org/freedesktop/timedate1", "org.freedesktop.timedate1", "Timezone").and_then(|v| String::try_from(v).map_err(|_| MErr::new("INTERNAL", "tz")))
}

fn valid_zone(z: &str) -> bool {
    !z.is_empty() && z.len() < 64 && !z.contains("..") && z.chars().all(|c| c.is_ascii_alphanumeric() || "/_-+".contains(c)) && ["/etc/zoneinfo", "/usr/share/zoneinfo"].iter().any(|d| std::path::Path::new(d).join(z).is_file())
}

pub struct RealExecutor {
    pub secrets: std::sync::Arc<std::sync::Mutex<SecretStore>>,
    pub drain: Box<dyn FnMut(&mut Machine, bool) -> R<Value> + Send>,
}

impl Executor for RealExecutor {
    fn probe(&mut self, kind: &str, p: &Value) -> R<(String, i64, Value)> {
        let gen = |v: &Value| -> i64 { i64::from_str_radix(&hash("agentos.machine.resource.v1", v)[7..19], 16).unwrap_or(0) };
        match kind {
            "network.wifi.connect" | "network.wifi.forget" | "network.device.disconnect" | "network.device.connect" => {
                let iface = p["device"].as_str().ok_or_else(|| MErr::new("INVALID_REQUEST", "device is required"))?;
                if iface.len() > 15 || !iface.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                    return Err(MErr::new("INVALID_REQUEST", "bad device name"));
                }
                let st = nm_device_state(iface)?;
                if kind.starts_with("network.wifi") && st["deviceType"] != 2 {
                    return Err(MErr::new("HARDWARE_UNSUPPORTED", "device is not Wi-Fi"));
                }
                let impact = json!({ "device": iface, "current": st["activeConnection"], "summary": format!("{kind} on {iface}") });
                Ok((format!("nm:device:{iface}"), gen(&st), impact))
            }
            "time.timezone.set" => {
                let z = p["zone"].as_str().unwrap_or_default();
                if !valid_zone(z) {
                    return Err(MErr::new("INVALID_REQUEST", "unknown time zone"));
                }
                let cur = timezone()?;
                Ok(("timedate:zone".into(), gen(&json!(cur)), json!({ "from": cur, "to": z })))
            }
            "time.ntp.enable" => Ok(("timedate:ntp".into(), 1, json!({ "summary": "keep network time on" }))),
            "power.reboot" | "power.poweroff" | "power.suspend" => {
                let can = logind_can(match kind {
                    "power.reboot" => "CanReboot",
                    "power.poweroff" => "CanPowerOff",
                    _ => "CanSuspend",
                });
                if can != "yes" && can != "challenge" {
                    return Err(MErr::new("HARDWARE_UNSUPPORTED", format!("logind reports {can}")));
                }
                Ok(("logind:power".into(), gen(&json!(crate::util::boot_id())), json!({ "summary": kind, "drainSeconds": 30 })))
            }
            "users.create" => {
                let n = p["loginName"].as_str().unwrap_or_default();
                if !crate::dir::valid_login(n) {
                    return Err(MErr::new("INVALID_REQUEST", "bad login name"));
                }
                Ok((format!("user:{n}"), 1, json!({ "loginName": n, "role": p["role"] })))
            }
            "users.disable" => Ok((format!("user:{}", p["userId"].as_str().unwrap_or_default()), 1, json!({ "userId": p["userId"] }))),
            "workspaces.runWhenLoggedOut" => {
                let ws = p["workspaceId"].as_str().unwrap_or_default();
                Ok((format!("workspace:{ws}:runWhenLoggedOut"), 1, json!({ "workspaceId": ws, "enabled": p["enabled"] })))
            }
            "workspaces.delete" | "workspaces.deleteConsent" => {
                let ws = p["workspaceId"].as_str().ok_or_else(|| MErr::new("INVALID_REQUEST", "workspaceId is required"))?;
                if !matches!(p["dataDisposition"].as_str(), Some("exported") | Some("discard")) {
                    return Err(MErr::new("INVALID_REQUEST", "dataDisposition must be exported or discard"));
                }
                // every precondition is checked again inside the dispatch transaction (begin_delete)
                Ok((format!("workspace:{ws}:delete"), 1, json!({ "workspaceId": ws, "dataDisposition": p["dataDisposition"], "exportSetId": p["exportSetId"], "summary": if kind == "workspaces.delete" { "delete the workspace data; its UID and storeUUID stay as a tombstone" } else { "owner confirms deleting this workspace" } })))
            }
            "updates.activate" | "updates.rollback" | "restores.confirm" => Ok((format!("{kind}:{}", p["id"].as_str().unwrap_or_default()), 1, json!({ "id": p["id"] }))),
            _ => Err(MErr::new("INVALID_REQUEST", "unknown kind")),
        }
    }

    fn dispatch(&mut self, m: &mut Machine, op: &Value) -> R<Value> {
        let kind = op["kind"].as_str().unwrap_or_default();
        let p = &op["params"];
        match kind {
            "network.wifi.connect" => {
                let iface = p["device"].as_str().unwrap_or_default();
                let ssid = p["ssid"].as_str().ok_or_else(|| MErr::new("INVALID_REQUEST", "ssid"))?;
                let psk = match p["secretRef"].as_str() {
                    Some(r) => Some(self.secrets.lock().unwrap().take(r)?),
                    None => None,
                };
                let c = dbus()?;
                let dev = nm_device(&c, iface)?;
                let mut conn: HashMap<&str, HashMap<&str, ZValue>> = HashMap::new();
                let mut s_conn = HashMap::new();
                s_conn.insert("type", ZValue::from("802-11-wireless"));
                s_conn.insert("id", ZValue::from(ssid.to_string()));
                conn.insert("connection", s_conn);
                let mut s_wifi = HashMap::new();
                s_wifi.insert("ssid", ZValue::from(ssid.as_bytes().to_vec()));
                conn.insert("802-11-wireless", s_wifi);
                if let Some(k) = &psk {
                    let mut sec = HashMap::new();
                    sec.insert("key-mgmt", ZValue::from("wpa-psk"));
                    sec.insert("psk", ZValue::from(String::from_utf8_lossy(k).to_string()));
                    conn.insert("802-11-wireless-security", sec);
                }
                let root = OwnedObjectPath::try_from("/").unwrap();
                c.call_method(Some("org.freedesktop.NetworkManager"), "/org/freedesktop/NetworkManager", Some("org.freedesktop.NetworkManager"), "AddAndActivateConnection", &(conn, &dev, &root))
                    .map_err(|e| MErr::new("SYSTEM_FAILED", e.to_string()))?;
                // Wait (bounded) for the device to reach a terminal state; the reconcile step reads the real outcome.
                for _ in 0..60 {
                    let st = nm_device_state(iface)?;
                    let s = st["state"].as_u64().unwrap_or(0);
                    if s == 100 || s == 120 || s == 30 {
                        return Ok(st);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                nm_device_state(iface)
            }
            "network.device.disconnect" | "network.device.connect" | "network.wifi.forget" => {
                let iface = p["device"].as_str().unwrap_or_default();
                let c = dbus()?;
                let dev = nm_device(&c, iface)?;
                if kind == "network.device.connect" {
                    let root = OwnedObjectPath::try_from("/").unwrap();
                    c.call_method(Some("org.freedesktop.NetworkManager"), "/org/freedesktop/NetworkManager", Some("org.freedesktop.NetworkManager"), "ActivateConnection", &(&root, &dev, &root))
                        .map_err(|e| MErr::new("SYSTEM_FAILED", e.to_string()))?;
                } else {
                    c.call_method(Some("org.freedesktop.NetworkManager"), dev.as_str(), Some("org.freedesktop.NetworkManager.Device"), "Disconnect", &()).map_err(|e| MErr::new("SYSTEM_FAILED", e.to_string()))?;
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
                nm_device_state(iface)
            }
            "time.timezone.set" => {
                let z = p["zone"].as_str().unwrap_or_default();
                let c = dbus()?;
                c.call_method(Some("org.freedesktop.timedate1"), "/org/freedesktop/timedate1", Some("org.freedesktop.timedate1"), "SetTimezone", &(z, false)).map_err(|e| MErr::new("SYSTEM_FAILED", e.to_string()))?;
                Ok(json!({ "zone": timezone()? }))
            }
            "time.ntp.enable" => {
                let c = dbus()?;
                c.call_method(Some("org.freedesktop.timedate1"), "/org/freedesktop/timedate1", Some("org.freedesktop.timedate1"), "SetNTP", &(true, false)).map_err(|e| MErr::new("SYSTEM_FAILED", e.to_string()))?;
                Ok(json!({ "ntp": true }))
            }
            "power.reboot" | "power.poweroff" | "power.suspend" => {
                let force = p["forceAfterDrain"].as_bool().unwrap_or(false);
                let drained = (self.drain)(m, force)?;
                if drained["blocked"].as_bool().unwrap_or(false) && !force {
                    return Err(MErr::new("FAILED_NO_EFFECT", format!("drain did not finish: {}", drained["reason"])));
                }
                Machine::audit(&m.c, "root", &format!("power:{kind}"), None, if drained["blocked"].as_bool().unwrap_or(false) { "forced_shutdown" } else { "drained" }, op["operationId"].as_str())?;
                let method = match kind {
                    "power.reboot" => "Reboot",
                    "power.poweroff" => "PowerOff",
                    _ => "Suspend",
                };
                logind_call(method, false)?;
                Ok(json!({ "requested": method, "drain": drained }))
            }
            "users.create" => {
                let pid = p["provisioningId"].as_str().map(String::from).unwrap_or_else(uuid);
                let u = m.provision_user(&pid, p["loginName"].as_str().unwrap_or_default(), p["role"].as_str().unwrap_or("user"))?;
                if let Some(r) = p["secretRef"].as_str() {
                    let pw = self.secrets.lock().unwrap().take(r)?;
                    m.set_password(u["userId"].as_str().unwrap_or_default(), &pw)?;
                }
                Ok(u)
            }
            "users.disable" => m.disable_user(p["userId"].as_str().unwrap_or_default(), &uuid()),
            "workspaces.runWhenLoggedOut" => {
                let enabled = p["enabled"].as_bool().ok_or_else(|| MErr::new("INVALID_REQUEST", "enabled"))?;
                m.set_run_when_logged_out(op["initiator"].as_str().unwrap_or_default(), p["workspaceId"].as_str().unwrap_or_default(), enabled)?;
                Ok(json!({ "runWhenLoggedOut": enabled }))
            }
            "workspaces.deleteConsent" => {
                let ws = p["workspaceId"].as_str().unwrap_or_default();
                m.delete_consent_check(op["initiator"].as_str().unwrap_or_default(), ws)?;
                Ok(json!({ "consented": true, "workspaceId": ws }))
            }
            "workspaces.delete" => m.begin_delete(
                op["initiator"].as_str().unwrap_or_default(),
                p["workspaceId"].as_str().unwrap_or_default(),
                op["operationId"].as_str().unwrap_or_default(),
                p["dataDisposition"].as_str().unwrap_or_default(),
                p["exportSetId"].as_str(),
                p["ownerConsentOperationId"].as_str(),
            ),
            _ => Err(MErr::new("HARDWARE_UNSUPPORTED", "this action is performed by its fixed worker")),
        }
    }

    fn reconcile(&mut self, kind: &str, p: &Value, dispatched: &Value) -> Option<bool> {
        match kind {
            "network.wifi.connect" => {
                let st = nm_device_state(p["device"].as_str()?).ok()?;
                Some(st["state"] == 100 && st["activeConnection"].as_str() == p["ssid"].as_str())
            }
            "network.device.disconnect" | "network.wifi.forget" => nm_device_state(p["device"].as_str()?).ok().map(|s| s["state"].as_u64().unwrap_or(0) < 40),
            "network.device.connect" => nm_device_state(p["device"].as_str()?).ok().map(|s| s["state"] == 100),
            "time.timezone.set" => timezone().ok().map(|z| Some(z.as_str()) == p["zone"].as_str()),
            "time.ntp.enable" => Some(true),
            // After a power request the outcome is the next boot; until then it is unknown, never "done".
            "power.reboot" | "power.poweroff" | "power.suspend" => {
                if dispatched.is_null() {
                    None
                } else {
                    Some(true)
                }
            }
            "users.create" | "users.disable" | "workspaces.runWhenLoggedOut" | "workspaces.deleteConsent" => Some(!dispatched.is_null() && dispatched.get("code").is_none()),
            // Phase 1 of a deletion is applied once the workspace is `deleting` (the broker verdict finishes it).
            "workspaces.delete" => Some(matches!(dispatched["state"].as_str(), Some("deleting") | Some("deleted"))),
            _ => None,
        }
    }
}

pub fn capabilities() -> Value {
    json!({
        "network": nm_overview(),
        "power": { "reboot": logind_can("CanReboot"), "poweroff": logind_can("CanPowerOff"), "suspend": logind_can("CanSuspend"), "hibernate": "unsupported" },
        "time": { "timezone": timezone().ok() },
        "battery": upower(),
    })
}

pub fn upower() -> Value {
    let c = match dbus() {
        Ok(c) => c,
        Err(_) => return json!({ "available": false }),
    };
    let present: bool = prop(&c, "org.freedesktop.UPower", "/org/freedesktop/UPower/devices/DisplayDevice", "org.freedesktop.UPower.Device", "IsPresent").ok().and_then(|v| bool::try_from(v).ok()).unwrap_or(false);
    let pct: f64 = prop(&c, "org.freedesktop.UPower", "/org/freedesktop/UPower/devices/DisplayDevice", "org.freedesktop.UPower.Device", "Percentage").ok().and_then(|v| f64::try_from(v).ok()).unwrap_or(-1.0);
    let on_battery: Option<bool> = prop(&c, "org.freedesktop.UPower", "/org/freedesktop/UPower", "org.freedesktop.UPower", "OnBattery").ok().and_then(|v| bool::try_from(v).ok());
    json!({ "available": on_battery.is_some(), "batteryPresent": present, "percentage": if present { json!(pct) } else { Value::Null }, "onBattery": on_battery })
}
