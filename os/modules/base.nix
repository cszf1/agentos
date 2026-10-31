{ config, lib, pkgs, ... }:
{
  system.stateVersion = "26.05";
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = false;
  boot.supportedFilesystems = [ "btrfs" ];
  boot.initrd.luks.devices = lib.mkDefault { };
  zramSwap.enable = true;
  time.timeZone = lib.mkDefault "UTC";
  i18n.defaultLocale = "C.UTF-8";
  nix.settings = { require-sigs = true; trusted-users = [ "root" ]; experimental-features = [ "nix-command" "flakes" ]; };
  users.mutableUsers = true;
  users.users.root.hashedPassword = "!";
  services.openssh.enable = false;
  networking.networkmanager.enable = true;
  networking.firewall.enable = true;
  security.polkit.enable = true;
  # Decision 85: an active local operator can mount removable recovery media without a root shell.
  # Keep udisks2's normal polkit policy: no blanket rule granting access to system disks or inactive sessions.
  services.udisks2.enable = true;
  virtualisation.podman.enable = true;
  environment.systemPackages = with pkgs; [ btrfs-progs cryptsetup sqlite age podman ];
  systemd.coredump.settings.Coredump = { Storage = "none"; ProcessSizeMax = 0; };
}
