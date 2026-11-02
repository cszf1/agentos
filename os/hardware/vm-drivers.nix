# Device drivers for every hypervisor AgentOS runs on: QEMU/KVM (virtio), VirtualBox, VMware (Workstation, Player,
# ESXi) and Hyper-V Gen2. Imported by the installed system (hardware/vm.nix) and by the installer ISO, so both find the
# same disks, keyboards and screens.
{ ... }:
{
  boot.initrd.availableKernelModules = [
    # storage: virtio, AHCI/IDE and NVMe (VirtualBox, VMware SATA/NVMe), LSI and PVSCSI (VMware), storvsc (Hyper-V), CD-ROM
    "virtio_pci" "virtio_blk" "virtio_scsi" "ahci" "ata_piix" "nvme" "sd_mod" "sr_mod" "mptspi" "vmw_pvscsi" "hv_vmbus" "hv_storvsc"
    # input for the disk passphrase prompt
    "xhci_pci" "usbhid" "hid_generic" "hyperv_keyboard"
    # network: only needed after switch-root, listed here so the initrd listing proves every emulated NIC is carried
    "virtio_net" "e1000" "e1000e" "vmxnet3" "hv_netvsc"
  ];
  # Early KMS, so the passphrase prompt draws on the virtual GPU. Off its own hypervisor hyperv_drm fails with ENODEV,
  # which systemd-modules-load logs as a notice without failing the unit.
  boot.initrd.kernelModules = [ "virtio_gpu" "vmwgfx" "vboxvideo" "hyperv_drm" ];
}
