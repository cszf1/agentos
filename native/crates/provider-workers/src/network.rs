//! Network worker (spec §15): started by systemd inside the pre-created lab namespace with only CAP_NET_ADMIN.
//! It compiles the two catalog profiles into nftables JSON itself and submits them through libnftables as one batch
//! touching only the AgentOS table. No nft text, table name or rule expression is accepted from a request.
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use crate::{die, has_fault, Res, WErr};
use agentos_protocol::worker::WorkerRequest;

#[repr(C)]
struct NftCtx {
    _p: [u8; 0],
}
#[link(name = "nftables")]
extern "C" {
    fn nft_ctx_new(flags: u32) -> *mut NftCtx;
    fn nft_ctx_free(ctx: *mut NftCtx);
    fn nft_ctx_output_set_flags(ctx: *mut NftCtx, flags: u32);
    fn nft_ctx_buffer_output(ctx: *mut NftCtx) -> i32;
    fn nft_ctx_buffer_error(ctx: *mut NftCtx) -> i32;
    fn nft_ctx_get_output_buffer(ctx: *mut NftCtx) -> *const libc::c_char;
    fn nft_ctx_get_error_buffer(ctx: *mut NftCtx) -> *const libc::c_char;
    fn nft_run_cmd_from_buffer(ctx: *mut NftCtx, buf: *const libc::c_char) -> i32;
}
const NFT_CTX_OUTPUT_JSON: u32 = 1 << 4;

/// Run one libnftables JSON command batch; returns (rc, output, error).
fn nft(cmd: &Value) -> (i32, String, String) {
    unsafe {
        let ctx = nft_ctx_new(0);
        nft_ctx_output_set_flags(ctx, NFT_CTX_OUTPUT_JSON);
        nft_ctx_buffer_output(ctx);
        nft_ctx_buffer_error(ctx);
        let c = CString::new(cmd.to_string()).unwrap();
        let rc = nft_run_cmd_from_buffer(ctx, c.as_ptr());
        let o = nft_ctx_get_output_buffer(ctx);
        let e = nft_ctx_get_error_buffer(ctx);
        let out = if o.is_null() { String::new() } else { CStr::from_ptr(o).to_string_lossy().to_string() };
        let err = if e.is_null() { String::new() } else { CStr::from_ptr(e).to_string_lossy().to_string() };
        nft_ctx_free(ctx);
        (rc, out, err)
    }
}

struct Lab {
    table: String,
    peer: String,
    port: u16,
    max_rules: usize,
    netns_path: String,
}

fn lab(req: &WorkerRequest) -> Result<Lab, WErr> {
    let t = &req.target;
    let table = t["table"].as_str().unwrap_or("");
    if !table.starts_with("agentos_") || !table.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
        return Err(WErr::none("NETWORK_SCOPE_DENIED", "only the installed agentos_* table is managed"));
    }
    Ok(Lab {
        table: table.into(),
        peer: t["peerAddress"].as_str().unwrap_or("").into(),
        port: t["peerPort"].as_u64().unwrap_or(0) as u16,
        max_rules: t["maxRules"].as_u64().unwrap_or(32) as usize,
        netns_path: t["netnsPath"].as_str().unwrap_or("").into(),
    })
}

/// The two fixed catalog profiles.
fn profile_rules(l: &Lab, profile: &str) -> Option<Vec<Value>> {
    let verdict = match profile {
        "local-allow" => json!({"accept": null}),
        "local-deny" => json!({"drop": null}),
        _ => return None,
    };
    Some(vec![json!({
        "family": "inet", "table": l.table, "chain": "output", "comment": format!("agentos:{profile}"),
        "expr": [
            {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "daddr"}}, "right": l.peer}},
            {"match": {"op": "==", "left": {"payload": {"protocol": "tcp", "field": "dport"}}, "right": l.port}},
            {"counter": {"packets": 0, "bytes": 0}},
            verdict
        ]
    })])
}

/// Normalized form for hashing: chain definitions and rules without handles or counters (spec §15: counters are
/// not part of the configuration hash).
fn normalize_rule(r: &Value) -> Value {
    let expr: Vec<Value> = r["expr"].as_array().cloned().unwrap_or_default().into_iter().filter(|e| e.get("counter").is_none()).collect();
    json!({"chain": r["chain"], "comment": r["comment"], "expr": expr})
}

fn hash_rules(rules: &[Value]) -> String {
    let norm: Vec<Value> = rules.iter().map(normalize_rule).collect();
    agentos_protocol::domain_hash("agentos.nft-rules.v1", &json!(norm)).unwrap_or_default()
}

fn current(l: &Lab) -> Result<(bool, Vec<Value>, Option<String>), WErr> {
    let (rc, out, err) = nft(&json!({"nftables": [{"list": {"table": {"family": "inet", "name": l.table}}}]}));
    if rc != 0 {
        if err.contains("No such file") || err.contains("does not exist") {
            return Ok((false, vec![], None));
        }
        return Err(WErr::none("PROVIDER_UNAVAILABLE", format!("nft list: {err}")));
    }
    let v: Value = serde_json::from_str(&out).map_err(|e| WErr::none("PROVIDER_UNAVAILABLE", format!("nft output: {e}")))?;
    let mut rules = Vec::new();
    let mut active = None;
    for item in v["nftables"].as_array().cloned().unwrap_or_default() {
        if let Some(r) = item.get("rule") {
            if let Some(c) = r["comment"].as_str() {
                if let Some(p) = c.strip_prefix("agentos:") {
                    active = Some(p.to_string());
                }
            }
            rules.push(r.clone());
        }
    }
    Ok((true, rules, active))
}

fn netns_ino() -> u64 {
    std::fs::metadata("/proc/self/ns/net").map(|m| std::os::unix::fs::MetadataExt::ino(&m)).unwrap_or(0)
}

fn probe(l: &Lab) -> Value {
    let addr: Option<SocketAddr> = format!("{}:{}", l.peer, l.port).parse().ok();
    let allowed = addr.map(|a| TcpStream::connect_timeout(&a, Duration::from_millis(700)).is_ok()).unwrap_or(false);
    json!({"target": format!("{}:{}", l.peer, l.port), "allowed": allowed, "atMs": agentos_protocol::now_ms()})
}

fn observe(l: &Lab, with_probe: bool) -> Res {
    let ino = netns_ino();
    // The namespace this worker runs in must be the installed one (the bind-mounted handle's inode).
    let handle_ino = std::fs::metadata(&l.netns_path).map(|m| std::os::unix::fs::MetadataExt::ino(&m)).unwrap_or(0);
    let (exists, rules, active) = current(l)?;
    let mut hashes = serde_json::Map::new();
    for p in ["local-allow", "local-deny"] {
        hashes.insert(p.into(), json!(hash_rules(&profile_rules(l, p).unwrap())));
    }
    let rh = if exists { hash_rules(&rules) } else { "absent".to_string() };
    let mut details = json!({"tableExists": exists, "ruleHash": rh, "ruleCount": rules.len(), "activeProfile": active, "profileHashes": hashes, "netnsMatchesHandle": ino == handle_ino && ino != 0, "snapshot": agentos_protocol::rtnl::snapshot().unwrap_or(Value::Null)});
    if with_probe {
        details["probe"] = probe(l);
    }
    Ok(json!({"identity": {"netnsIno": ino, "handleIno": handle_ino, "table": l.table}, "version": rh, "details": details}))
}

pub fn handle(req: &WorkerRequest) -> Res {
    let l = lab(req)?;
    match req.op.as_str() {
        "observe" => observe(&l, req.params["probe"].as_bool().unwrap_or(false)),
        "read" => {
            let cap = req.params["capabilityId"].as_str().unwrap_or("");
            match cap {
                "network.policy_status" => Ok(observe(&l, true)?["details"].clone()),
                "network.snapshot" => agentos_protocol::rtnl::snapshot().map_err(|e| WErr::none("PROVIDER_UNAVAILABLE", e)),
                _ => Err(WErr::none("CAPABILITY_VERSION_UNSUPPORTED", "unsupported network read")),
            }
        }
        "apply" => {
            let profile = req.params["profileId"].as_str().unwrap_or("");
            let rules = profile_rules(&l, profile).ok_or_else(|| WErr::none("NETWORK_SCOPE_DENIED", "profile not in the catalog"))?;
            if rules.len() > l.max_rules {
                return Err(WErr::none("LIMIT_EXCEEDED", "profile exceeds the rule limit"));
            }
            let o = observe(&l, false)?;
            if o["details"]["netnsMatchesHandle"] != true {
                return Err(WErr::none("RESOURCE_GENERATION_STALE", "worker namespace is not the installed lab namespace"));
            }
            let t = &l.table;
            let mut batch = vec![
                json!({"metainfo": {"json_schema_version": 1}}),
                json!({"add": {"table": {"family": "inet", "name": t}}}),
                json!({"add": {"chain": {"family": "inet", "table": t, "name": "output", "type": "filter", "hook": "output", "prio": 0, "policy": "accept"}}}),
                json!({"flush": {"chain": {"family": "inet", "table": t, "name": "output"}}}),
            ];
            for r in rules {
                batch.push(json!({"add": {"rule": r}}));
            }
            if has_fault(req, "network.fail_commit") {
                // Injected failure at the end of the batch: the whole transaction must be rejected.
                batch.push(json!({"add": {"rule": {"family": "inet", "table": t, "chain": "no_such_chain", "expr": [{"accept": null}]}}}));
            }
            let (rc, _, err) = nft(&json!({"nftables": batch}));
            if rc != 0 {
                // The batch is one netfilter transaction: report "no effect" only after verifying the table.
                let after = observe(&l, false)?;
                if after["details"]["ruleHash"] == o["details"]["ruleHash"] {
                    return Err(WErr::none("EXTERNAL_RESULT_INDETERMINATE", format!("nft transaction rejected, ruleset unchanged: {}", err.trim())));
                }
                return Err(WErr::unknown("EXTERNAL_RESULT_INDETERMINATE", format!("nft failed and the ruleset changed: {}", err.trim())));
            }
            if has_fault(req, "network.die_after_commit") {
                die("network.die_after_commit");
            }
            let after = observe(&l, true)?;
            let pr = &after["details"]["probe"];
            let matches = (profile == "local-allow" && pr["allowed"] == true) || (profile == "local-deny" && pr["allowed"] == false);
            let mut probe = pr.clone();
            probe["matchesProfile"] = json!(matches);
            Ok(json!({"ruleHash": after["details"]["ruleHash"], "probe": probe, "profileId": profile}))
        }
        _ => Err(WErr::none("INVALID_SYSTEM_PLAN", "unknown network op")),
    }
}
