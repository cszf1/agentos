//! Broker ↔ worker channel: same framing, peer credentials checked on both ends, requests deduplicated by
//! operationId + dispatchNonce + brokerInstanceId inside the worker (spec §12.3).
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::os::unix::net::UnixStream;
use std::time::Duration;

use crate::frame::{parse_strict, read_frame, write_frame, MAX_CONTROL_FRAME};
use crate::peer::peer_cred;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerRequest {
    pub v: u32,
    pub op: String,
    pub broker_instance_id: String,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub dispatch_nonce: Option<String>,
    pub target: Value,
    pub params: Value,
    /// Fault points honoured only when the root policy enables test mode.
    #[serde(default)]
    pub faults: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerResponse {
    pub ok: bool,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<WorkerError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerError {
    pub code: String,
    pub message: String,
    /// none | verified | unknown: whether the worker can say the target effect did not happen.
    pub effect: String,
}

#[derive(Debug)]
pub struct CallError {
    pub code: String,
    pub message: String,
    /// True when the request may have reached the worker (connection broke after sending).
    pub maybe_sent: bool,
    pub effect: String,
}

pub fn call(socket: &str, expect_uid: u32, req: &WorkerRequest, timeout: Duration) -> Result<Value, CallError> {
    let s = UnixStream::connect(socket).map_err(|e| CallError {
        code: "PROVIDER_UNAVAILABLE".into(),
        message: format!("connect {socket}: {e}"),
        maybe_sent: false,
        effect: "none".into(),
    })?;
    let pc = peer_cred(&s).map_err(|e| CallError {
        code: "PROVIDER_UNAVAILABLE".into(),
        message: format!("peer cred: {e}"),
        maybe_sent: false,
        effect: "none".into(),
    })?;
    if pc.uid != expect_uid {
        return Err(CallError {
            code: "BROKER_IDENTITY_MISMATCH".into(),
            message: format!("worker socket peer uid {} != {}", pc.uid, expect_uid),
            maybe_sent: false,
            effect: "none".into(),
        });
    }
    s.set_read_timeout(Some(timeout)).ok();
    s.set_write_timeout(Some(timeout)).ok();
    let body = serde_json::to_vec(req).unwrap();
    let mut w = &s;
    write_frame(&mut w, &body).map_err(|e| CallError {
        code: "PROVIDER_UNAVAILABLE".into(),
        message: format!("send: {e}"),
        maybe_sent: true,
        effect: "unknown".into(),
    })?;
    let mut r = &s;
    let resp = read_frame(&mut r, MAX_CONTROL_FRAME).map_err(|e| CallError {
        code: "EXTERNAL_RESULT_INDETERMINATE".into(),
        message: format!("no response: {e}"),
        maybe_sent: true,
        effect: "unknown".into(),
    })?;
    let v = parse_strict(&resp).map_err(|e| CallError {
        code: "EXTERNAL_RESULT_INDETERMINATE".into(),
        message: e.to_string(),
        maybe_sent: true,
        effect: "unknown".into(),
    })?;
    let r: WorkerResponse = serde_json::from_value(v).map_err(|e| CallError {
        code: "EXTERNAL_RESULT_INDETERMINATE".into(),
        message: e.to_string(),
        maybe_sent: true,
        effect: "unknown".into(),
    })?;
    if r.ok {
        Ok(r.result.unwrap_or(Value::Null))
    } else {
        let e = r.error.unwrap_or(WorkerError { code: "INTERNAL".into(), message: "worker error".into(), effect: "unknown".into() });
        Err(CallError { code: e.code, message: e.message, maybe_sent: true, effect: e.effect })
    }
}
