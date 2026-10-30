//! Machine flows the gateway may request but never performs: updates, backups, restores and diagnostics are
//! carried out by machined's fixed workers. The gateway passes the authenticated principal and the typed body.
use crate::gw::Gw;
use serde_json::{json, Value};

fn err(code: &str, msg: &str) -> Value {
    json!({ "code": code, "message": msg })
}

pub fn call(gw: &Gw, p: &Value, method: &str, ws: &str, body: &Value, idem: Option<&str>) -> Result<(u16, Value), Value> {
    let v = gw.machine("workers.request", json!({ "principal": p, "method": method, "workspaceId": ws, "body": body, "idempotencyKey": idem }))?;
    Ok((202, v))
}

pub fn read(gw: &Gw, p: &Value, method: &str, ws: &str, params: &Value) -> Result<(u16, Value), Value> {
    match method {
        "backups.list" => gw.machine("workers.backups", json!({ "principal": p, "workspaceId": ws })).map(|v| (200, v)),
        "backups.inspect" => gw.machine("workers.inspect", json!({ "principal": p, "workspaceId": ws, "setId": params.get("setId") })).map(|v| (200, v)),
        "restores.status" => gw.machine("restores.get", json!({ "restoreId": params.get("restoreId").and_then(|x| x.as_str()).ok_or_else(|| err("INVALID_REQUEST", "restoreId"))? })).map(|v| (200, v)),
        _ => Err(err("INVALID_REQUEST", "unknown method")),
    }
}

/// Bounded, redacted diagnostics: identity digests, epochs, permits, barrier and the last audit entries; never
/// prompts, records, Wi-Fi keys, provider secrets, cookies or serial frames (spec §27.3).
pub fn diagnostics(gw: &Gw, p: &Value, ws: &str, body: &Value) -> Result<(u16, Value), Value> {
    let scope = body.get("scope").and_then(|x| x.as_str()).unwrap_or("machine");
    if scope == "machine" && p["admin"] != true {
        return Err(err("NOT_FOUND_OR_FORBIDDEN", "not found"));
    }
    let st = gw.machine("status", json!({}))?;
    let audit = if p["admin"] == true { gw.machine("audit.tail", json!({ "limit": 100 }))? } else { json!({ "audit": [] }) };
    let wsv = if scope == "workspace" { gw.machine("workspaces.get", json!({ "principal": p, "workspaceId": ws })).ok() } else { None };
    Ok((200, json!({ "redaction": "default", "machine": st, "audit": audit["audit"], "workspace": wsv.map(|w| json!({ "workspaceId": w["workspaceId"], "state": w["state"], "workspaceIncarnation": w["workspaceIncarnation"], "instanceEpoch": w["instanceEpoch"] })) })))
}
