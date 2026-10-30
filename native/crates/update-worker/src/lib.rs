//! agentos-update-worker (spec §21, §29): fixed steps of the update state machine that touch boot assets and the
//! loader. machined owns `update_jobs` and the barrier; this worker performs one step and reports facts.
pub mod boot;
pub mod content;
pub mod health;
pub mod trial;
