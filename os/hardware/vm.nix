# Virtual-machine hardware profile: one toplevel for QEMU/KVM, VirtualBox, VMware and Hyper-V Gen2 (UEFI only).
# Separate from hardware/physical.nix. Rendering stays software (agentos.softwareRendering, set in flake.nix).
# Every guest tool below starts only on its own hypervisor (ConditionVirtualization=, or activation by a device that
# only that hypervisor provides), so the same system boots cleanly on all four.
{ config, lib, pkgs, modulesPath, ... }:
let
  vboxTools = config.virtualisation.virtualbox.guest.package;
  openVmTools = config.virtualisation.vmware.guest.package;
in
{
  imports = [ (modulesPath + "/profiles/qemu-guest.nix") ./vm-drivers.nix ];

  # VirtualBox. VBoxClient (clipboard, seamless, drag and drop and the VMSVGA session helper) is an X11 client that
  # needs $DISPLAY, which the Sway session does not provide, so all of it is off. VBoxService (time sync, guest
  # properties) and VBoxDRMClient (screen size follows the window through vmwgfx) need no display server. Shutdown
  # from the host arrives as an ACPI power button press, which logind handles. The in-tree vboxguest and vboxvideo
  # modules replace the out-of-tree build so the kernel stays untainted.
  virtualisation.virtualbox.guest = {
    enable = true;
    use3rdPartyModules = false;
    vboxsf = false;
    clipboard = false;
    seamless = false;
    dragAndDrop = false;
  };
  systemd.user.services.virtualboxClientVmsvga.enable = false;
  # Upstream also puts VBoxService in multi-user.target with Requires=dev-vboxguest.device; elsewhere that device never
  # appears and boot waits for its job to time out. Started by the device instead, it never queues off VirtualBox.
  systemd.services.virtualbox.wantedBy = lib.mkForce [ "dev-vboxguest.device" ];
  # Guest control would let the host run programs in the guest as any user whose password it knows; QEMU has no such
  # channel (no guest agent), so it stays off along with shared-folder automount.
  systemd.services.virtualbox.serviceConfig.ExecStart =
    lib.mkForce "@${vboxTools}/bin/VBoxService VBoxService --foreground --disable-control --disable-automount";
  systemd.services.virtualbox-drm-client = {
    description = "VirtualBox screen resize (VBoxDRMClient)";
    wantedBy = [ "dev-vboxguest.device" ];
    requires = [ "dev-vboxguest.device" ];
    after = [ "dev-vboxguest.device" ];
    # VBoxDRMClient drives vmwgfx: present only with the VMSVGA graphics controller
    unitConfig.ConditionVirtualization = "oracle";
    unitConfig.ConditionPathExistsGlob = "/sys/bus/pci/drivers/vmwgfx/0000:*";
    serviceConfig.ExecStart = "${vboxTools}/bin/VBoxDRMClient";
    serviceConfig.Restart = "on-failure";
  };

  # VMware. The desktop open-vm-tools build adds only X11 parts (vmware-user, vmblock, the vmmouse Xorg driver); the
  # headless build keeps vmtoolsd: time sync, host power operations and the resolutionKMS plugin, which resizes the
  # screen through vmwgfx without a display server. The service carries ConditionVirtualization=vmware upstream.
  virtualisation.vmware.guest = { enable = true; headless = true; };
  # Guest operations (host runs programs or copies files as a guest user) and guest customization (host-supplied
  # scripts run as root) are host-to-guest channels QEMU does not have: off.
  environment.etc.vmware-tools.source = lib.mkForce (pkgs.runCommand "agentos-vmware-tools-etc" { } ''
    mkdir $out
    for f in ${openVmTools}/etc/vmware-tools/*; do ln -s "$f" $out/; done
    rm -f $out/tools.conf
    printf '[guestoperations]\ndisabled=true\n\n[deployPkg]\nenable-customization=false\n' > $out/tools.conf
  '');

  # Hyper-V: hv_utils (time sync, host shutdown), hv_balloon, hyperv_keyboard and the KVP/VSS/FCOPY daemons, whose
  # units carry ConditionVirtualization=microsoft upstream.
  virtualisation.hypervGuest.enable = true;
  # FCOPY lets the host write files into the running guest as root, past the disk encryption: masked.
  systemd.units."hv-fcopy.service".enable = false;
}
