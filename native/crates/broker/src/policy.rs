//! Root-owned installation policy (spec §8, §12.1). The broker refuses to start writes when the file or its directory
//! can be modified by anyone but root. The policy version is the hash of the canonical policy document.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::os::unix::fs::MetadataExt;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostEntry {
    pub uid: u32,
    pub store_uuid: String,
    pub workspace_path_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRoot {
    pub key: String,
    pub store_uuid: String,
    pub path: String,
    pub display_name: String,
    pub max_file_bytes: u64,
    pub quota_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Range {
    pub min: u64,
    pub max: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnitEntry {
    pub key: String,
    pub store_uuid: String,
    pub unit: String,
    pub display_name: String,
    pub template_hash: String,
    /// Restarting the program twice is harmless (catalog decision, spec §14).
    pub safe_repeat_start: bool,
    /// Reconciliation may dispatch again inside the original deadline.
    pub auto_converge: bool,
    #[serde(rename = "cpuQuotaPerSecUSec")]
    pub cpu_quota_per_sec_usec: Range,
    pub memory_max: Range,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LabNetwork {
    pub key: String,
    pub store_uuid: String,
    pub display_name: String,
    pub netns_path: String,
    pub table: String,
    pub peer_address: String,
    pub peer_port: u16,
    pub max_rules: u32,
    pub profiles: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerialEntry {
    pub key: String,
    pub store_uuid: String,
    pub display_name: String,
    /// "pty-fixture" (software protocol tests) or "udev" (real hardware).
    pub kind: String,
    pub path: String,
    #[serde(default)]
    pub udev_match: Option<Value>,
    pub profile: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerEntry {
    pub socket: String,
    pub unit: String,
    pub uid: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workers {
    pub file: WorkerEntry,
    pub service: WorkerEntry,
    pub network: WorkerEntry,
    pub serial: WorkerEntry,
}

/// v0.4 (spec §13.3, §16): which registered units a workspace's maintenance principal may keep running, with hard
/// upper bounds. User policies can only narrow these; an entry missing here means "no maintenance recovery".
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceEntry {
    pub unit_key: String,
    pub store_uuid: String,
    pub action_families: Vec<String>,
    pub per_hour: u32,
    pub per24h: u32,
    pub cooldown_seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub policy_format: u32,
    pub machine_install_id: String,
    pub hosts: Vec<HostEntry>,
    pub managed_roots: Vec<ManagedRoot>,
    pub units: Vec<UnitEntry>,
    pub lab_networks: Vec<LabNetwork>,
    pub serial: Vec<SerialEntry>,
    pub workers: Workers,
    /// v0.4 maintenance install caps (absent in v0.3 policies: no maintenance recovery allowed).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub maintenance: Vec<MaintenanceEntry>,
    /// Enables fault points from /etc/agentos/broker/faultpoints (dedicated test installs only).
    pub test_mode: bool,
}

pub const POLICY_PATH: &str = "/etc/agentos/broker/policy.json";

pub fn check_root_owned(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    let mut cur = Some(p);
    while let Some(c) = cur {
        let md = std::fs::symlink_metadata(c).map_err(|e| format!("{}: {e}", c.display()))?;
        if md.uid() != 0 {
            return Err(format!("{} is not owned by root", c.display()));
        }
        if md.mode() & 0o022 != 0 {
            return Err(format!("{} is writable by group or others", c.display()));
        }
        if md.file_type().is_symlink() {
            return Err(format!("{} is a symlink", c.display()));
        }
        cur = c.parent().filter(|x| !x.as_os_str().is_empty());
    }
    Ok(())
}

pub fn load(path: &str, require_root: bool) -> Result<(Policy, String), String> {
    if require_root {
        check_root_owned(path)?;
    }
    let text = std::fs::read(path).map_err(|e| format!("read policy: {e}"))?;
    let v: Value = serde_json::from_slice(&text).map_err(|e| format!("policy JSON: {e}"))?;
    let p: Policy = serde_json::from_value(v.clone()).map_err(|e| format!("policy shape: {e}"))?;
    if p.policy_format != 1 {
        return Err("unsupported policy format".into());
    }
    let version = agentos_protocol::domain_hash("agentos.broker-policy.v1", &v).map_err(|e| e.0)?;
    Ok((p, version))
}

/// Stable broker resource id for a catalog entry.
pub fn resource_id(install: &str, store: &str, kind: &str, key: &str) -> String {
    let h = agentos_protocol::sha256_hex(format!("{install}\n{store}\n{kind}\n{key}").as_bytes());
    format!("res_{}_{}", kind.replace('-', ""), &h[..20])
}
