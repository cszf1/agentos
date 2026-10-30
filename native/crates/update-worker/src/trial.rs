//! Trial boot and commit reconciliation (spec §21.2 steps 5–7, §21.3, V1-U08/U10).
//! Pure decision functions over the persisted update facts and what the loader actually reports, so every crash
//! point (before/after one-shot, during validation, between commit intent and default, after default) resolves
//! from facts instead of trusting one database field.
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    pub state: String,
    pub candidate: String,
    pub known_good: String,
    pub trial_boot_id: Option<String>,
    pub commit_intent: bool,
    pub failed_candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Booted into the candidate for the first time: record bootId, open workspaces in check/frozen mode.
    EnterValidating { boot_id: String },
    /// Trial did not happen or failed (booted known-good while armed / trial boot gone): never retry this candidate.
    RolledBack { reason: &'static str },
    /// Commit intent recorded but default not yet the candidate: (re)write the default, read it back.
    ResumeCommitSetDefault,
    /// Default already points at the candidate under a commit intent: record committed/knownGood, open business.
    FinishCommit,
    /// Nothing to do in this state.
    None,
    /// Facts contradict each other (e.g. booted an unknown entry): stop and ask the administrator.
    NeedsAttention { reason: &'static str },
}

pub fn entry(rid: &str) -> String {
    format!("agentos-{rid}.conf")
}

pub fn after_boot(f: &Facts, booted: Option<&str>, default: Option<&str>, boot_id: &str) -> Action {
    let cand = entry(&f.candidate);
    let good = entry(&f.known_good);
    match f.state.as_str() {
        "armed" => match booted {
            Some(b) if b == cand => Action::EnterValidating { boot_id: boot_id.into() },
            Some(b) if b == good => Action::RolledBack { reason: "the candidate did not boot (firmware fell back to known-good)" },
            _ => Action::NeedsAttention { reason: "booted entry is neither candidate nor known-good" },
        },
        "trial_boot" | "validating" => {
            if f.commit_intent {
                return if default == Some(cand.as_str()) { Action::FinishCommit } else { Action::ResumeCommitSetDefault };
            }
            match (&f.trial_boot_id, booted) {
                (Some(t), Some(b)) if t == boot_id && b == cand => Action::None, // still in the same trial boot
                (_, Some(b)) if b == good => Action::RolledBack { reason: "the trial boot ended before health passed" },
                (_, Some(b)) if b == cand => Action::NeedsAttention { reason: "candidate booted again without a one-shot" },
                _ => Action::NeedsAttention { reason: "unknown boot entry during validation" },
            }
        }
        "rollback_pending" => {
            if booted == Some(good.as_str()) {
                Action::RolledBack { reason: "returned to known-good" }
            } else {
                Action::None
            }
        }
        _ => Action::None,
    }
}

/// A candidate that failed its trial is never armed again (no endless loop of a bad release).
pub fn may_arm(f: &Facts, rid: &str) -> Result<(), &'static str> {
    if f.failed_candidates.iter().any(|x| x == rid) {
        return Err("this release already failed its trial boot");
    }
    Ok(())
}

pub fn action_json(a: &Action) -> Value {
    match a {
        Action::EnterValidating { boot_id } => json!({ "action": "enter_validating", "bootId": boot_id }),
        Action::RolledBack { reason } => json!({ "action": "rolled_back", "reason": reason }),
        Action::ResumeCommitSetDefault => json!({ "action": "resume_commit_set_default" }),
        Action::FinishCommit => json!({ "action": "finish_commit" }),
        Action::None => json!({ "action": "none" }),
        Action::NeedsAttention { reason } => json!({ "action": "needs_attention", "reason": reason }),
    }
}
