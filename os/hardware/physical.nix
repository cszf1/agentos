# Review F15: the physical-machine profile (Intel/AMD x86_64 desktops and laptops), separate from qemu.nix (which
# stays the qemu-virtio profile of the release and every VM check). Only the build of this profile is checked in CI
# (build-physical); booting it on real hardware - KMS output, NVMe, firmware, suspend/battery - is "需实体机，未验收"
# (docs/ACCEPTANCE_V1.0.md, H01–H08).
{ config, lib, pkgs, ... }:
{
  # storage and input reachable from stage 1: NVMe, AHCI/SATA, USB (installer media, keyboards), Thunderbolt, SD/MMC
  boot.initrd.availableKernelModules = [ "nvme" "ahci" "sd_mod" "xhci_pci" "ehci_pci" "usb_storage" "uas" "usbhid" "hid_generic" "thunderbolt" "sdhci_pci" "rtsx_pci_sdmmc" ];
  # early KMS for the LUKS passphrase prompt and a flicker-free hand-over: Intel and AMD integrated/discrete GPUs
  boot.initrd.kernelModules = [ "i915" "amdgpu" ];
  boot.kernelModules = [ "kvm-intel" "kvm-amd" ];
  # firmware and microcode (redistributable only: Wi-Fi, Bluetooth, GPU, NIC blobs)
  hardware.enableRedistributableFirmware = true;
  hardware.cpu.intel.updateMicrocode = true;
  hardware.cpu.amd.updateMicrocode = true;
  # Mesa with hardware acceleration (Sway uses GLES2 here; the qemu profile renders with pixman)
  hardware.graphics.enable = true;
  hardware.graphics.extraPackages = with pkgs; [ intel-media-driver ];
  # power: CPU frequency scaling, Intel thermal management, power profiles; batteries through UPower (graphics.nix),
  # which the update preflight reads (V1-U06 low battery)
  powerManagement.enable = true;
  services.thermald.enable = true;
  services.power-profiles-daemon.enable = true;
  services.fstrim.enable = true;
  services.fwupd.enable = true;
  # suspend on lid close only when not docked; the lock screen comes from the session (swayidle/swaylock)
  services.logind.settings.Login.HandleLidSwitchDocked = "ignore";
}
