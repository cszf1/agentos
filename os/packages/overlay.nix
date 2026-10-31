# AgentOS packages built from this repository at the fixed nixpkgs revision. Rust uses the repository's pinned
# toolchain (native/rust-toolchain.toml = 1.91.0) from the fixed rust-overlay input, not nixpkgs' newer rustc.
final: prev:
let
  src = final.lib.cleanSourceWith {
    src = ../..;
    filter = path: type:
      let rel = final.lib.removePrefix (toString ../.. + "/") (toString path); in
      !(final.lib.hasPrefix "node_modules" (baseNameOf path) || baseNameOf path == "target" || baseNameOf path == "dist"
        || final.lib.hasPrefix "os/" rel && final.lib.hasSuffix ".qcow2" rel || baseNameOf path == "test-results" || baseNameOf path == ".git");
  };
  rust = final.rust-bin.stable."1.91.0".minimal;
  rustPlatform = final.makeRustPlatform { cargo = rust; rustc = rust; };
in {
  # Repository pin (package.json packageManager = pnpm@10.34.9).
  pnpm_10 = prev.pnpm_10.overrideAttrs (_: rec {
    version = "10.34.9";
    src = final.fetchurl { url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz"; hash = "sha512-9JtajqD97bRLs8DB1ldQkqU8KVDZW3rRXfEfF5dId6LeOgHAfpNOmyjOcW5RwJqUlixzBtCb4uHksYqMh2L9Mg=="; };
  });
  agentos-src = src;
  # Narrow sources so a change in one part does not rebuild the others.
  agentos-native = final.callPackage ./native.nix { inherit rustPlatform; src = final.lib.fileset.toSource { root = ../..; fileset = final.lib.fileset.unions [ ../../native/Cargo.toml ../../native/Cargo.lock ../../native/crates ../../native/bpf ../../native/rust-toolchain.toml ../../docs/contracts ../../fixtures/v1.0 ../../fixtures/v0.3 ]; }; };
  agentos-node = final.callPackage ./node.nix { src = final.lib.fileset.toSource { root = ../..; fileset = final.lib.fileset.unions [ ../../package.json ../../pnpm-lock.yaml ../../pnpm-workspace.yaml ../../.node-version ../../tsconfig.base.json ../../packages ../../runtime ../../fixtures ../../docs/contracts ../../bin ]; }; };
  # V1-U11 (m7 only, never in a release): the same recipes over an EARLIER v1.0 commit's sources, so the rollback boots
  # genuinely older AgentOS programs. The caller picks a commit with the same schemas and the same lockfiles (the
  # pnpm dependency hash above stays valid).
  agentos-older = olderSrc: {
    native = final.callPackage ./native.nix { inherit rustPlatform; src = olderSrc; };
    node = final.callPackage ./node.nix { src = olderSrc; };
  };
  agentos-shell = final.callPackage ../../desktop/package.nix { };
  # Test-only: the Shell's controller + QML driven against a real gateway in the m13-native and m20-sway VM checks (never in a
  # release). The fixtures it renders in m20 come from the source in the store (the build tree is gone at run time).
  agentos-shell-e2e = final.agentos-shell.overrideAttrs (o: { pname = "agentos-shell-e2e"; cmakeFlags = (o.cmakeFlags or [ ]) ++ [ "-DAGENTOS_E2E=ON" "-DAGENTOS_FIXTURES_DIR=${o.src}/fixtures" ]; doCheck = false; });
  # Approved OCI images of the catalog, built offline from fixed inputs (spec §19.1); shipped in the release closure.
  agentos-oci = final.callPackage ./oci.nix { src = final.lib.fileset.toSource { root = ../..; fileset = final.lib.fileset.unions [ ../../runtime/overlays ../../scripts/release-image-contexts.mjs ]; }; };
}
