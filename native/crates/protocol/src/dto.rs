//! Broker protocol DTOs (spec §12.2). Every struct refuses unknown fields; numbers are integers within the JS safe
//! range; identifiers are short ASCII tokens. The TypeScript mirror lives in packages/contracts/src/v3/broker.ts and
//! both are checked against fixtures/v0.3/protocol/vectors.json.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u32,
    pub id: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub machine_install_id: String,
    pub store_uuid: String,
    pub workspace_incarnation: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandshakeParams {
    pub protocol_version: u32,
    pub store_uuid: String,
    pub machine_install_id: Option<String>,
    pub workspace_incarnation: Option<u64>,
    pub client_nonce: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Principal {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantSyncParams {
    pub identity: Identity,
    pub grant_id: String,
    pub grant_version: u64,
    pub principal: Principal,
    pub capability_id: String,
    pub contract_version: u32,
    pub resource_id: String,
    pub resource_generation: u64,
    pub limits: Value,
    pub params_hash: Option<String>,
    pub expires_at_ms: u64,
    pub request_hash: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantRevokeParams {
    pub identity: Identity,
    pub grant_id: String,
    pub grant_version: u64,
}

/// The frozen write request (spec §12.2). `request_hash` covers every other field.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteEnvelope {
    pub protocol_version: u32,
    pub machine_install_id: String,
    pub store_uuid: String,
    pub workspace_incarnation: u64,
    pub operation_id: String,
    pub action_id: String,
    pub plan_hash: String,
    pub capability_id: String,
    pub contract_version: u32,
    pub resource_id: String,
    pub resource_generation: u64,
    pub grant_id: String,
    pub grant_version: u64,
    pub preconditions: Value,
    pub deadline_ms: u64,
    pub params: Value,
    /// Present as null when absent: both sides hash the same body (a missing key is refused, like the TS schema).
    #[serde(deserialize_with = "required_nullable")]
    pub compensates_operation_id: Option<String>,
    pub request_hash: String,
}

fn required_nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    <Option<String> as serde::Deserialize>::deserialize(d)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationRef {
    pub identity: Identity,
    pub operation_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelParams {
    pub identity: Identity,
    pub operation_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveParams {
    pub identity: Identity,
    pub operation_id: String,
    /// confirmed_applied | confirmed_not_applied | accept_unknown
    pub decision: String,
    pub observed_evidence: Value,
    pub release_quarantine: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadParams {
    pub identity: Identity,
    pub grant_id: String,
    pub capability_id: String,
    pub contract_version: u32,
    pub resource_id: String,
    pub resource_generation: u64,
    pub params: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DescribeParams {
    pub identity: Identity,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryParams {
    pub store_uuid: String,
    pub machine_install_id: String,
    pub since_seq: u64,
    pub limit: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuiesceParams {
    pub identity: Identity,
    pub reason: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeParams {
    pub identity: Identity,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreParams {
    pub store_uuid: String,
    pub machine_install_id: String,
    pub restore_request_id: String,
    #[serde(default)]
    pub source_incarnation: Option<u64>,
}

pub const METHODS: &[&str] = &[
    "handshake",
    "describe",
    "read",
    "grant-sync",
    "grant-revoke",
    "submit",
    "operation-get",
    "operation-cancel",
    "operation-resolve",
    "history-sync",
    "workspace-quiesce",
    "workspace-resume",
    "restore-begin",
    "restore-status",
    "restore-complete",
];

/// Short ASCII identifiers (ids, hashes, capability ids).
pub fn token_ok(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_:.-@".contains(&b))
}

pub fn hash_ok(s: &str) -> bool {
    s.len() == 71 && s.starts_with("sha256:") && s[7..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn safe_u64(n: u64) -> bool {
    n <= MAX_SAFE
}

pub fn check_identity(i: &Identity) -> Result<(), String> {
    if !token_ok(&i.machine_install_id, 64) || !token_ok(&i.store_uuid, 64) || !safe_u64(i.workspace_incarnation) {
        return Err("identity fields are malformed".into());
    }
    Ok(())
}

impl WriteEnvelope {
    /// Value over which `request_hash` is computed: the envelope without the hash itself.
    pub fn hash_body(&self) -> Value {
        let mut v = serde_json::to_value(self).expect("serializable");
        v.as_object_mut().unwrap().remove("requestHash");
        v
    }
    pub fn check(&self) -> Result<(), String> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err("CAPABILITY_VERSION_UNSUPPORTED: protocol version".into());
        }
        for (name, v, max) in [
            ("machineInstallId", &self.machine_install_id, 64),
            ("storeUUID", &self.store_uuid, 64),
            ("operationId", &self.operation_id, 64),
            ("actionId", &self.action_id, 64),
            ("capabilityId", &self.capability_id, 64),
            ("resourceId", &self.resource_id, 96),
            ("grantId", &self.grant_id, 64),
        ] {
            if !token_ok(v, max) {
                return Err(format!("{name} is malformed"));
            }
        }
        if !hash_ok(&self.plan_hash) || !hash_ok(&self.request_hash) {
            return Err("hashes must be sha256:<64 lowercase hex>".into());
        }
        for n in [self.workspace_incarnation, self.resource_generation, self.grant_version, self.deadline_ms] {
            if !safe_u64(n) {
                return Err("integer outside the safe range".into());
            }
        }
        if !self.preconditions.is_object() || !self.params.is_object() {
            return Err("preconditions and params must be objects".into());
        }
        if let Some(c) = &self.compensates_operation_id {
            if !token_ok(c, 64) {
                return Err("compensatesOperationId is malformed".into());
            }
        }
        Ok(())
    }
}

impl GrantSyncParams {
    pub fn hash_body(&self) -> Value {
        let mut v = serde_json::to_value(self).expect("serializable");
        v.as_object_mut().unwrap().remove("requestHash");
        v
    }
}

// ---------------------------------------------------------------- protocol 2: maintenance (v0.4 spec §13.3)

/// Protocol 2 adds the maintenance principal. Protocol 1 DTOs, methods and hash domains are unchanged; a protocol-1
/// request never carries maintenance fields (deny_unknown_fields) and a maintenance request is never downgraded.
pub const PROTOCOL_V2: u32 = 2;
pub const SUPPORTED_PROTOCOLS: &[u32] = &[1, 2];
pub const MAINTENANCE_WRITE_DOMAIN: &str = "agentos.broker.maintenance-write.v2";
pub const MAINTENANCE_POLICY_DOMAIN: &str = "agentos.broker.maintenance-policy.v2";
pub const METHODS_V2: &[&str] = &["maintenance-policy-sync", "maintenance-policy-revoke", "maintenance-control", "maintenance-state", "maintenance-submit"];
/// The only action family a maintenance principal may run in v0.4 (spec §16).
pub const MAINTENANCE_FAMILY_ENSURE_RUNNING: &str = "service.ensure_state.running";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceBounds {
    pub per_hour: u32,
    pub per24h: u32,
    pub cooldown_seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenancePolicySyncParams {
    pub identity: Identity,
    pub policy_id: String,
    pub policy_version: u64,
    pub policy_hash: String,
    pub resource_id: String,
    pub resource_generation: u64,
    pub action_family: String,
    pub bounds: MaintenanceBounds,
    pub expires_at_ms: u64,
    pub maintenance_epoch: u64,
    pub request_hash: String,
}

impl MaintenancePolicySyncParams {
    pub fn hash_body(&self) -> Value {
        let mut v = serde_json::to_value(self).expect("serializable");
        v.as_object_mut().unwrap().remove("requestHash");
        v
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenancePolicyRevokeParams {
    pub identity: Identity,
    pub policy_id: String,
    pub policy_version: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetControl {
    pub resource_id: String,
    pub control_epoch: u64,
}

/// Global pause/resume (with the new maintenance epoch) and/or a target control epoch (user stop wins over recovery).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceControlParams {
    pub identity: Identity,
    /// running | paused
    pub state: String,
    pub maintenance_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<TargetControl>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceStateParams {
    pub identity: Identity,
}

/// The frozen maintenance write (protocol 2). `request_hash` covers every other field under MAINTENANCE_WRITE_DOMAIN.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceWriteEnvelope {
    pub protocol_version: u32,
    pub machine_install_id: String,
    pub store_uuid: String,
    pub workspace_incarnation: u64,
    pub operation_id: String,
    pub action_id: String,
    pub plan_hash: String,
    pub capability_id: String,
    pub contract_version: u32,
    pub resource_id: String,
    pub resource_generation: u64,
    pub preconditions: Value,
    pub deadline_ms: u64,
    pub params: Value,
    pub job_id: String,
    pub step_id: String,
    pub policy_id: String,
    pub policy_version: u64,
    pub maintenance_epoch: u64,
    pub target_control_epoch: u64,
    pub trigger_key: String,
    pub request_hash: String,
}

impl MaintenanceWriteEnvelope {
    pub fn hash_body(&self) -> Value {
        let mut v = serde_json::to_value(self).expect("serializable");
        v.as_object_mut().unwrap().remove("requestHash");
        v
    }
    pub fn check(&self) -> Result<(), String> {
        if self.protocol_version != PROTOCOL_V2 {
            return Err("CAPABILITY_VERSION_UNSUPPORTED: a maintenance write is protocol 2".into());
        }
        for (name, v, max) in [
            ("machineInstallId", &self.machine_install_id, 64),
            ("storeUUID", &self.store_uuid, 64),
            ("operationId", &self.operation_id, 64),
            ("actionId", &self.action_id, 64),
            ("capabilityId", &self.capability_id, 64),
            ("resourceId", &self.resource_id, 96),
            ("jobId", &self.job_id, 64),
            ("stepId", &self.step_id, 64),
            ("policyId", &self.policy_id, 64),
            ("triggerKey", &self.trigger_key, 200),
        ] {
            // triggerKey may contain extra graphic characters that token_ok rejects; everything else must be a token.
            if !(token_ok(v, max) || (name == "triggerKey" && v.len() <= 200 && !v.is_empty() && v.bytes().all(|b| b.is_ascii_graphic()))) {
                return Err(format!("{name} is malformed"));
            }
        }
        if !hash_ok(&self.plan_hash) || !hash_ok(&self.request_hash) {
            return Err("hashes must be sha256:<64 lowercase hex>".into());
        }
        for n in
            [self.workspace_incarnation, self.resource_generation, self.policy_version, self.maintenance_epoch, self.target_control_epoch, self.deadline_ms]
        {
            if !safe_u64(n) {
                return Err("integer outside the safe range".into());
            }
        }
        if !self.preconditions.is_object() || !self.params.is_object() {
            return Err("preconditions and params must be objects".into());
        }
        Ok(())
    }
    /// The executor's view: a protocol-1-shaped envelope without a grant (the maintenance policy replaces it).
    pub fn as_write(&self) -> WriteEnvelope {
        WriteEnvelope {
            protocol_version: PROTOCOL_VERSION,
            machine_install_id: self.machine_install_id.clone(),
            store_uuid: self.store_uuid.clone(),
            workspace_incarnation: self.workspace_incarnation,
            operation_id: self.operation_id.clone(),
            action_id: self.action_id.clone(),
            plan_hash: self.plan_hash.clone(),
            capability_id: self.capability_id.clone(),
            contract_version: self.contract_version,
            resource_id: self.resource_id.clone(),
            resource_generation: self.resource_generation,
            grant_id: format!("maint-{}", &self.policy_id.chars().take(50).collect::<String>()),
            grant_version: self.policy_version,
            preconditions: self.preconditions.clone(),
            deadline_ms: self.deadline_ms,
            params: self.params.clone(),
            compensates_operation_id: None,
            request_hash: self.request_hash.clone(),
        }
    }
}
