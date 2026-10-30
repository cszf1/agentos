{
  description = "AgentOS v1.0 system image";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/6f06d204d8f2d8761d9da78778745974a3216381"; # nixos-26.05
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      mk = modules: nixpkgs.lib.nixosSystem { inherit system; modules = modules; specialArgs = { agentosSrc = self; }; };
    in {
      nixosConfigurations.m0-proto = mk [ ./modules/base.nix ./modules/graphics.nix ./hardware/qemu.nix ];
      packages.${system}.m0-toplevel = self.nixosConfigurations.m0-proto.config.system.build.toplevel;
    };
}
