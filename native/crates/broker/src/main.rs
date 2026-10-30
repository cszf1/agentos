//! agentos-broker: the fixed privileged broker (spec §12). It holds the root policy, the execution log and the
//! dispatch to fixed workers. It never runs model output, shell text, scripts or dynamic libraries.
mod admin;
mod db;
mod exec;
mod maintenance;
mod policy;
mod registry;
mod server;
mod state;

fn main() {
    // Never inherit a dynamic environment (spec §12.3): the unit starts us with a clean one, and we drop what remains.
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy().to_string();
        if k != "NOTIFY_SOCKET" && k != "INVOCATION_ID" && k != "JOURNAL_STREAM" {
            std::env::remove_var(&k);
        }
    }
    std::env::set_var("PATH", "/run/current-system/sw/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    let args: Vec<String> = std::env::args().collect();
    let code = match args.get(1).map(|s| s.as_str()) {
        Some("serve") => server::serve(),
        Some("admin") => admin::main(&args[2..]),
        Some("--version") => {
            println!(
                "agentos-broker {} protocol {} (+{} maintenance)",
                env!("CARGO_PKG_VERSION"),
                agentos_protocol::dto::PROTOCOL_VERSION,
                agentos_protocol::dto::PROTOCOL_V2
            );
            0
        }
        _ => {
            eprintln!("usage: agentos-broker serve | admin <install-db|inspect|policy-version> | --version");
            2
        }
    };
    std::process::exit(code);
}
