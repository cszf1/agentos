# The node m21-vmware and m22-virtio share: the released VM system (hardware/vm.nix, systemd initrd, software
# rendering, the bundled OCI images) on the test framework's disk instead of hardware/disk-layout.nix.
{ pkgs, modules }:
{ ... }: {
  imports = modules ++ [ ../hardware/vm.nix ];
  boot.initrd.systemd.enable = true;     # as the release images (hardware/disk-layout.nix)
  agentos.enable = true;
  agentos.softwareRendering = true;
  agentos.releaseImages = pkgs.agentos-oci;
  virtualisation = { memorySize = 4096; cores = 2; diskSize = 8192; };
  environment.systemPackages = [ pkgs.sqlite ];
}
