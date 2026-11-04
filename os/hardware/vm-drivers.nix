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
    # Virtual GPUs, still in the initrd for early KMS: initrd udev (80-drivers.rules) loads the one whose PCI or VMBus
    # alias matches during coldplug, before the passphrase prompt. They are deliberately not boot.initrd.kernelModules:
    # those are force-loaded by systemd-modules-load, which then runs every probe itself, and any error other than
    # ENODEV/ENOENT (or a probe that faults and kills it) fails "Load Kernel Modules" on hypervisors the driver is not
    # for. Through udev an off-platform driver is never loaded and a failing probe is logged by the udev worker only.
    "virtio_gpu" "vmwgfx" "vboxvideo" "hyperv_drm"
  ];
}
