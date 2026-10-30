# agentos-install: the offline installer script with its fixed tool set (spec §19.3). `system` is the base release
# toplevel the ISO carries in its own store; `release` is the release manifest file.
{ lib, writeShellScriptBin, writeText, python3, gptfdisk, cryptsetup, btrfs-progs, dosfstools, parted, util-linux, coreutils, nixos-install-tools, nix, systemd, system ? "", release ? "" }:
let
  script = builtins.replaceStrings [ "@SYSTEM@" "@RELEASE@" ] [ "${system}" "${release}" ] (builtins.readFile ../installer/agentos-install.py);
  py = writeText "agentos-install.py" script;
in
writeShellScriptBin "agentos-install" ''
  export PATH=${lib.makeBinPath [ python3 gptfdisk cryptsetup btrfs-progs dosfstools parted util-linux coreutils nixos-install-tools nix systemd ]}:$PATH
  exec ${python3}/bin/python3 ${py} "$@"
''
