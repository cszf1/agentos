//! Error codes of spec §16.2 plus the generic request errors. Messages never carry secrets or user content.
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MErr {
    pub code: &'static str,
    pub message: String,
}

impl MErr {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        MErr { code, message: message.into() }
    }
    pub fn hidden() -> Self {
        MErr::new("NOT_FOUND_OR_FORBIDDEN", "not found")
    }
    pub fn json(&self) -> Value {
        json!({ "code": self.code, "message": self.message, "retryable": matches!(self.code, "MACHINE_CAPACITY" | "PERMIT_RECONCILING" | "REGISTRY_NOT_SYNCED" | "STORE_UNAVAILABLE") })
    }
}

impl std::fmt::Display for MErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl From<rusqlite::Error> for MErr {
    fn from(e: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(f, _) = &e {
            if f.code == rusqlite::ErrorCode::ConstraintViolation {
                return MErr::new("CONFLICT", format!("constraint: {e}"));
            }
            if matches!(f.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked | rusqlite::ErrorCode::DiskFull | rusqlite::ErrorCode::ReadOnly) {
                return MErr::new("STORE_UNAVAILABLE", format!("{e}"));
            }
        }
        MErr::new("INTERNAL", format!("{e}"))
    }
}

pub type R<T> = Result<T, MErr>;
