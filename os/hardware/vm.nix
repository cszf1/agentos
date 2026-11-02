# Virtual-machine hardware profile: one toplevel for QEMU/KVM, VirtualBox, VMware and Hyper-V Gen2 (UEFI only).
# Separate from hardware/physical.nix. Rendering stays software (agentos.softwareRendering, set in flake.nix).
{ modulesPath, ... }:
{
  imports = [ (modulesPath + "/profiles/qemu-guest.nix") ./vm-drivers.nix ];
}
