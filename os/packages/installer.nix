# agentos-install: the offline installer script with its fixed tool set (spec §19.3). `system` is the base release
# toplevel the ISO carries in its own store; `release` is the release manifest file. The public template key is
# carried for the quick install (`--quick`, `auto`): first boot replaces it (os/modules/disk-layout.nix).
{ lib, writeShellScriptBin, writeText, python3, gptfdisk, cryptsetup, btrfs-progs, dosfstools, mtools, libfaketime, parted, util-linux, coreutils, nixos-install-tools, nix, systemd, efibootmgr, system ? "", release ? "" }:
let
  initializer = writeText "agentos-initialization.py" (builtins.readFile ../installer/initialization.py);
  script = builtins.replaceStrings [ "@SYSTEM@" "@RELEASE@" "@TEMPLATE_KEY@" "@INITIALIZER@" ] [ "${system}" "${release}" "${../modules/template-disk.key}" "${initializer}" ] (builtins.readFile ../installer/agentos-install.py);
  py = writeText "agentos-install.py" script;
in
writeShellScriptBin "agentos-install" ''
  export PATH=${lib.makeBinPath [ python3 gptfdisk cryptsetup btrfs-progs dosfstools mtools libfaketime parted util-linux coreutils nixos-install-tools nix systemd efibootmgr ]}:$PATH
  exec ${python3}/bin/python3 ${py} "$@"
''
