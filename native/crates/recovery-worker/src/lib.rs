//! agentos-recovery-worker (spec §23, §24, §29): cold workspace checkpoints, strict archive, age export/import and
//! journaled restore. machined owns the barrier, checkpoint and restore state machines; this worker performs the
//! file work for one fixed step at a time and is re-entrant by setId / restoreId.
pub mod archive;
pub mod cold;
pub mod export;
#[cfg(test)]
mod tests;
