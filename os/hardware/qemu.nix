{ lib, modulesPath, ... }:
{
  imports = [ (modulesPath + "/profiles/qemu-guest.nix") ];
  boot.initrd.availableKernelModules = [ "virtio_pci" "virtio_blk" "virtio_scsi" "virtio_gpu" "ahci" "xhci_pci" ];
  fileSystems."/" = lib.mkDefault { device = "/dev/disk/by-label/agentos-root"; fsType = "btrfs"; options = [ "subvol=@root" ]; };
  fileSystems."/boot" = lib.mkDefault { device = "/dev/disk/by-label/AGENTOS-ESP"; fsType = "vfat"; };
}
