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
  agentos-native = final.callPackage ./native.nix { inherit src rustPlatform; };
  agentos-node = final.callPackage ./node.nix { inherit src; };
  agentos-shell = final.callPackage ../../desktop/package.nix { };
}
