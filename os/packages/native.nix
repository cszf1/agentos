{ lib, rustPlatform, src, pkg-config, dbus, linux-pam, systemdLibs, libbpf, nftables }:
rustPlatform.buildRustPackage {
  pname = "agentos-native";
  version = "1.0.0";
  src = "${src}/native";
  cargoLock.lockFile = "${src}/native/Cargo.lock";
  nativeBuildInputs = [ pkg-config ];
  buildInputs = [ dbus linux-pam systemdLibs libbpf nftables ];
  # Contracts and fixtures the crates include at compile time live outside native/.
  postUnpack = ''
    mkdir -p docs fixtures
    cp -r ${src}/docs/contracts docs/
    cp -r ${src}/fixtures/v1.0 fixtures/ || true
    cp -r ${src}/fixtures/v0.3 fixtures/ || true
  '';
  postInstall = ''
    install -Dm0644 bpf/exec_exit.bpf.o $out/lib/agentos/bpf/exec_exit.bpf.o
  '';
  doCheck = false;
  meta.description = "AgentOS root services: machined, session-gateway, broker and providers";
}
