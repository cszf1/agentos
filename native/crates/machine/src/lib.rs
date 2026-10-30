//! agentos-machined: the single coordinator of the machine directory (spec §5). It owns machine.sqlite, never loads Pi,
//! never reads prompts and never executes model-provided commands. Root helpers it starts take fixed parameter schemas.
pub mod backends;
pub mod ckpt;
pub mod db;
pub mod dir;
pub mod err;
pub mod ops;
pub mod permits;
pub mod release;
pub mod server;
pub mod sys;
pub mod util;

pub use dir::Machine;
pub use err::MErr;
