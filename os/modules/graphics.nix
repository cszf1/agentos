{ config, lib, pkgs, ... }:
{
  programs.sway = { enable = true; wrapperFeatures.gtk = true; extraPackages = with pkgs; [ swaylock swayidle ]; };
  security.pam.services.swaylock = { };
  services.greetd.enable = true;
  programs.regreet.enable = true;
  services.pipewire = { enable = true; wireplumber.enable = true; pulse.enable = false; alsa.enable = true; };
  services.upower.enable = true;
  i18n.inputMethod = { enable = true; type = "fcitx5"; fcitx5.addons = with pkgs; [ qt6Packages.fcitx5-chinese-addons ]; };
  fonts.packages = with pkgs; [ noto-fonts-cjk-sans noto-fonts ];
  environment.systemPackages = with pkgs; [ qt6.qtbase qt6.qtdeclarative qt6.qtwayland ];
}
