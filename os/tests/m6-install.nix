# M6 offline install (spec §19.2–19.4, V1-U01/U02/U03 in a KVM VM): the installer refuses wrong targets, binds the
# plan to the disk identity, survives a crash during copying without touching another disk, installs the release
# closure from the local store only (network off), and the installed disk boots through systemd-boot + LUKS2 +
# Btrfs into an unregistered machine whose first boot creates one identity.
# The installed system here is the release modules + the NixOS test backdoor (needed to drive it); the release
# ISO itself is built by `nix build .#agentos-iso`.
{ pkgs, mkSystem, releaseModules, nixpkgs }:
let
  installed = mkSystem (releaseModules ++ [
    "${nixpkgs}/nixos/modules/testing/test-instrumentation.nix"
    ({ lib, ... }: { agentos.graphical = lib.mkForce false; boot.kernelParams = [ "console=ttyS0" ]; boot.initrd.systemd.enable = true; })
  ]);
  top = installed.config.system.build.toplevel;
  installer = pkgs.callPackage ./../packages/installer.nix { system = top; };
in
pkgs.testers.runNixOSTest {
  name = "agentos-m6-install";
  nodes.machine = { lib, ... }: {
    virtualisation = { memorySize = 3072; cores = 2; diskSize = 8192; emptyDiskImages = [ 65536 1024 ]; writableStore = true; };
    virtualisation.additionalPaths = [ top ];
    environment.systemPackages = [ installer pkgs.jq pkgs.gptfdisk ];
    networking.useDHCP = false;
    networking.interfaces = lib.mkForce { };
    nix.settings.substituters = lib.mkForce [ ];
    boot.supportedFilesystems = [ "btrfs" "vfat" ];
  };
  testScript = ''
    import json, os, shutil
    TOP = "${top}"
    def inst(args, ok=True, stdin=None):
        cmd = f"AGENTOS_INSTALL_ALLOW_PATH=1 agentos-install {args}"
        if stdin is not None:
            cmd = f"printf '%s' '{stdin}' | {cmd}"
        rc, out = machine.execute(cmd)
        v = json.loads(out.strip().splitlines()[-1])
        assert v["ok"] == ok, (args, v)
        return v

    machine.start()
    machine.wait_for_unit("multi-user.target")
    machine.fail("ip route | grep -q default")   # no network: everything comes from the local store

    with subtest("inspect lists disks with identity; small and system disks are refused (U02)"):
        d = {x["path"]: x for x in inst("inspect")["disks"]}
        assert "smaller than 64 GiB" in " ".join(d["/dev/vdc"]["problems"]), d["/dev/vdc"]
        assert any("mounted" in p for p in d["/dev/vda"]["problems"]), d["/dev/vda"]
        inst("plan --disk /dev/vdc", ok=False)
        inst("plan --disk /dev/vda", ok=False)
        machine.fail("agentos-install plan --disk /dev/vdb")  # not by-id without the test override

    with subtest("identity change between plan and run is refused; nothing written (U02)"):
        p = inst("plan --disk /dev/vdb --timezone Asia/Taipei")
        serial = p["plan"]["identity"]["serial"] or p["plan"]["identity"]["wwn"] or p["plan"]["identity"]["majMin"]
        inst(f"confirm --plan-hash sha256:{'0'*64} --serial {serial}", ok=False)
        inst(f"confirm --plan-hash {p['planHash']} --serial wrong", ok=False)
        inst(f"confirm --plan-hash {p['planHash']} --serial {serial}")
        machine.succeed("sgdisk -n1:1MiB:+16MiB /dev/vdb")   # someone changed the disk after the plan
        v = inst("run --passphrase-stdin", ok=False, stdin="correct horse battery")
        assert "changed" in v["error"], v
        machine.succeed("test $(sgdisk -p /dev/vdb | grep -c '^ *[0-9]') -eq 1")  # only the foreign partition
        machine.succeed("sgdisk --zap-all /dev/vdb")

    with subtest("a crash during copying resumes on the same disk only (U02)"):
        p = inst("plan --disk /dev/vdb --timezone Asia/Taipei")
        inst(f"confirm --plan-hash {p['planHash']} --serial {serial}")
        machine.fail("printf 'correct horse battery' | AGENTOS_INSTALL_ALLOW_PATH=1 AGENTOS_FAULT_POINT=install.copying agentos-install run --passphrase-stdin")
        assert inst("status")["state"] == "copying"
        machine.succeed("sgdisk -p /dev/vdb | grep -q agentos-luks")
        machine.succeed("umount -R /mnt || true; cryptsetup close agentos-root || true")
        v = inst("run --passphrase-stdin", stdin="correct horse battery")
        assert v["state"] == "installed", v
        machine.succeed("test -s /mnt/etc/agentos/install.json")
        machine.fail("test -e /mnt/var/lib/agentos-machine/machine.sqlite")
        machine.succeed("ls /mnt/boot/loader/entries/ | grep -q .")
        machine.succeed("grep -E '^root:!' /mnt/etc/shadow")
        machine.succeed("sync; umount -R /mnt; cryptsetup close agentos-root")
    machine.shutdown()

    with subtest("the installed disk boots: systemd-boot → LUKS2 → Btrfs → unregistered machine (U01/U03)"):
        disk = os.path.join(machine.state_dir, "empty0.qcow2")
        vars_ = os.path.join(machine.state_dir, "ovmf-vars.fd")
        shutil.copy("${pkgs.OVMF.variables}", vars_)
        os.chmod(vars_, 0o644)
        start = (f"${pkgs.qemu_test}/bin/qemu-kvm -m 2048 -smp 2 "
                 f"-drive if=pflash,format=raw,unit=0,readonly=on,file=${pkgs.OVMF.firmware} "
                 f"-drive if=pflash,format=raw,unit=1,file={vars_} -drive file={disk},if=virtio,format=qcow2")
        target = create_machine(start, name="installed")
        target.start()
        target.wait_for_console_text("assphrase", timeout=600)
        target.send_chars("correct horse battery\n")
        target.wait_for_unit("multi-user.target", timeout=900)
        target.succeed("findmnt -no FSTYPE / | grep -q btrfs && cryptsetup status agentos-root | grep -q LUKS2")
        for sv in ["@nix", "@home", "@machine", "@broker", "@snapshots"]:
            target.succeed(f"findmnt -no OPTIONS -T / | grep -q subvol=/@root && btrfs subvolume list / | grep -q {sv}")
        target.wait_for_unit("agentos-machine.service")
        st = json.loads(target.succeed("agentosctl status"))
        assert st["meta"]["firstBootState"] != "closed", st
        out = json.loads(target.succeed("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace Home"))
        mid = out["machineInstallId"]
        target.fail("printf x | agentosctl firstboot --admin mallory")
        target.fail("ss -ltn | grep -vE '^State' | grep -q .")   # no TCP listener on the installed system
        target.succeed("test \"$(readlink -f /run/current-system)\" = " + TOP)
        target.shutdown()
        target.start()
        target.wait_for_console_text("assphrase", timeout=600)
        target.send_chars("correct horse battery\n")
        target.wait_for_unit("agentos-machine.service", timeout=900)
        assert json.loads(target.succeed("agentosctl status"))["meta"]["machineInstallId"] == mid
  '';
}
