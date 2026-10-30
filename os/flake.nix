{
  description = "AgentOS v1.0 system image";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/6f06d204d8f2d8761d9da78778745974a3216381"; # nixos-26.05, 2026-10-29
    rust-overlay = {
      url = "github:oxalica/rust-overlay/96a0986b0486341fbc163fa2fabc6d3b44cdcbf1";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };
  outputs = { self, nixpkgs, rust-overlay }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default (import ./packages/overlay.nix) ]; };
      lib = nixpkgs.lib;
      mk = modules: lib.nixosSystem {
        inherit system;
        modules = [ { nixpkgs.pkgs = pkgs; } ] ++ modules;
      };
    in {
      packages.${system} = {
        inherit (pkgs) agentos-native agentos-node agentos-shell;
        m0-toplevel = self.nixosConfigurations.m0-proto.config.system.build.toplevel;
      };
      nixosConfigurations.m0-proto = mk [ ./modules/base.nix ./modules/graphics.nix ./hardware/qemu.nix ];
    };
}
