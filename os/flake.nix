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
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ rust-overlay.overlays.default (import ./packages/overlay.nix) ];
        # Build-time only: pnpm at the repository's packageManager pin (10.34.9). nixpkgs flags the whole pnpm 10
        # line; the tool never ships in the image. Recorded in docs/v1.0-decisions.tsv.
        config.permittedInsecurePackages = [ "pnpm-10.34.9" ];
      };
      lib = nixpkgs.lib;
      mk = modules: lib.nixosSystem {
        inherit system;
        modules = [ { nixpkgs.pkgs = pkgs; } ] ++ modules;
      };
      releaseModules = [ ./modules/base.nix ./modules/graphics.nix ./modules/agentos.nix ./hardware/qemu.nix ./modules/disk-layout.nix
        { agentos.enable = true; agentos.softwareRendering = true; } ];
      agentosSystem = mk releaseModules;
      toplevel = agentosSystem.config.system.build.toplevel;
      rev = self.rev or "dirty";
      release = import ./release.nix {
        inherit pkgs toplevel rev;
        lastModified = self.lastModified or 0;
        nixpkgsRev = nixpkgs.rev;
        flakeLockHash = "sha256:" + builtins.hashFile "sha256" ./flake.lock;
      };
      installerPkg = pkgs.callPackage ./packages/installer.nix { system = toplevel; release = "${release}/manifest.json"; };
      installerSystem = mk [
        "${nixpkgs}/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix"
        ({ lib, ... }: {
          system.stateVersion = "26.05";
          isoImage.volumeID = lib.mkForce "AGENTOS-INSTALL";
          isoImage.storeContents = [ toplevel ];        # the whole release closure is on the medium: offline install
          environment.systemPackages = [ installerPkg ];
          environment.etc."agentos-install-medium.json".text = builtins.toJSON { release = "${release}/manifest.json"; system = toString toplevel; };
          services.openssh.enable = lib.mkForce false;   # no remote entry on the installer
          networking.wireless.enable = lib.mkForce false;
          nix.settings.substituters = lib.mkForce [ ];
          boot.supportedFilesystems = [ "btrfs" "vfat" ];
        })
      ];
      # qcow2: the same AgentOS package set and modules on a plain ext4 VM disk without LUKS (no passphrase can be
      # baked into a template). Identity is created at first boot; the image ships with no machine.sqlite.
      qcowSystem = mk [ ./modules/base.nix ./modules/graphics.nix ./modules/agentos.nix ./hardware/qemu.nix
        ({ lib, ... }: {
          agentos.enable = true; agentos.softwareRendering = true;
          fileSystems."/" = { device = "/dev/disk/by-label/nixos"; fsType = "ext4"; };
          fileSystems."/boot" = { device = "/dev/disk/by-label/ESP"; fsType = "vfat"; options = [ "umask=0077" ]; };
          boot.growPartition = true;
        }) ];
      test = name: file: extra: import file ({ inherit pkgs; modules = [ ./modules/base.nix ./modules/agentos.nix ]; } // extra);
    in {
      packages.${system} = {
        inherit (pkgs) agentos-native agentos-node agentos-shell;
        agentos-toplevel = toplevel;
        agentos-release = release;
        agentos-installer = installerPkg;
        agentos-iso = installerSystem.config.system.build.isoImage;
        agentos-qcow2 = import "${nixpkgs}/nixos/lib/make-disk-image.nix" {
          inherit pkgs lib; config = qcowSystem.config; format = "qcow2"; partitionTableType = "efi"; diskSize = "auto"; additionalSpace = "2G"; copyChannel = false;
        };
        m0-toplevel = self.nixosConfigurations.m0-proto.config.system.build.toplevel;
      };
      nixosConfigurations.agentos = agentosSystem;
      nixosConfigurations.installer = installerSystem;
      nixosConfigurations.m0-proto = mk [ ./modules/base.nix ./modules/graphics.nix ./hardware/qemu.nix ./modules/disk-layout.nix ];
      checks.${system} = {
        # KVM runs (CI) may use several vCPUs; "-tcg" variants are single-vCPU for hosts without KVM (RCU stalls).
        m2-identity = test "m2" ./tests/m2-identity.nix { };
        m2-identity-tcg = test "m2" ./tests/m2-identity.nix { cores = 1; };
        m6-install = import ./tests/m6-install.nix { inherit pkgs releaseModules nixpkgs; mkSystem = mk; };
        m7-update = test "m7" ./tests/m7-update.nix { };
      };
    };
}
