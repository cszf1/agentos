# The node m21-vmware and m22-virtio share: the released VM system (hardware/vm.nix, systemd initrd, software
# rendering, the bundled OCI images) on the test framework's disk instead of hardware/disk-layout.nix.
{ pkgs, modules }:
{ ... }: {
  imports = modules ++ [ ../hardware/vm.nix ];
  boot.initrd.systemd.enable = true;     # as the release images (hardware/disk-layout.nix)
  # qemu-vm.nix imports profiles/qemu-guest.nix into every test node, which vm.nix leaves out of the release system
  agentos.vmDrivers.forcedInitrdAllowed = [ "virtio_balloon" "virtio_console" "virtio_rng" "virtio_gpu" ];
  agentos.enable = true;
  agentos.softwareRendering = true;
  agentos.releaseImages = pkgs.agentos-oci;
  virtualisation = { memorySize = 4096; cores = 2; diskSize = 8192; };
  environment.systemPackages = [ pkgs.sqlite ];
}
