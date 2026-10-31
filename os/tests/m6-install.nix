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
    ({ lib, ... }: { agentos.graphical = lib.mkForce false; boot.kernelParams = [ "console=ttyS0" ]; users.users.root.hashedPasswordFile = lib.mkForce null; boot.initrd.systemd.enable = true; })
  ]);
  top = installed.config.system.build.toplevel;
  installer = pkgs.callPackage ./../packages/installer.nix { system = top; };
in
pkgs.testers.runNixOSTest {
  name = "agentos-m6-install";
  nodes.machine = { lib, ... }: {
    virtualisation = { memorySize = 3072; cores = 2; diskSize = 8192; emptyDiskImages = [ 65536 1024 65536 ]; writableStore = true; };
    virtualisation.additionalPaths = [ top ];
    environment.systemPackages = [ installer pkgs.jq pkgs.gptfdisk pkgs.cryptsetup pkgs.btrfs-progs ];
    networking.useDHCP = false;
    networking.interfaces = lib.mkForce { };
    nix.settings.substituters = lib.mkForce [ ];
    boot.supportedFilesystems = [ "btrfs" "vfat" ];
    # the ISO's medium identity file (os/flake.nix); without it the installer falls back to the boot id, which is
    # not an install medium identity across a power cut
    environment.etc."agentos-install-medium.json".text = builtins.toJSON { system = toString top; test = "m6-install"; };
  };
  testScript = ''
    import json, os, shutil
    TOP = "${top}"
    extra = []
    import contextlib
    @contextlib.contextmanager
    def kill_on_fail():
        # a failed check must not leave a create_machine() VM running: the driver would wait for it until the CI
        # step deadline (that, not slowness, is why earlier m6 runs only ended at the 110-minute cap)
        try:
            yield
        except BaseException:
            for x in extra:
                if x.booted:
                    x.crash()
            raise

    import time as _t
    def feed(m, text, done, timeout=900):
        # Console prompts (systemd-ask-password) end without a newline, so the driver only sees them once a later
        # line arrives (m6-install waited 8.5 min on "assphrase"). Type the answer every 15 s until `done` shows.
        end = _t.time() + timeout
        while _t.time() < end:
            m.send_console(text + "\n")
            try:
                m.wait_for_console_text(done, timeout=15)
                return
            except Exception:
                pass
        raise Exception(f"console never showed {done!r}")

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
        serial = p["plan"]["confirmToken"]
        # review F05: a virtio disk without serial/WWN is confirmed by its exact size, never by major:minor
        assert not p["plan"]["identity"]["serial"] and serial == f"no-serial:{p['plan']['identity']['sizeBytes']}", p["plan"]
        assert p["plan"]["identity"]["majMin"] not in serial
        inst(f"confirm --plan-hash sha256:{'0'*64} --serial {serial}", ok=False)
        inst(f"confirm --plan-hash {p['planHash']} --serial wrong", ok=False)
        inst(f"confirm --plan-hash {p['planHash']} --serial {serial}")
        machine.succeed("sgdisk -n1:1MiB:+16MiB /dev/vdb")   # someone changed the disk after the plan
        v = inst("run --passphrase-stdin", ok=False, stdin="correct horse battery")
        assert "changed" in v["error"], v
        machine.succeed("test $(sgdisk -p /dev/vdb | grep -c '^ *[0-9]') -eq 1")  # only the foreign partition
        machine.succeed("sgdisk --zap-all /dev/vdb")

    with subtest("power cut during copying: after a reboot from the install medium the state is read back from the target ESP, wrong disks are refused, an explicit recover resumes (U02, review F05)"):
        p = inst("plan --disk /dev/vdb --timezone Asia/Taipei")
        inst(f"confirm --plan-hash {p['planHash']} --serial {p['plan']['confirmToken']}")
        iid = p["plan"]["installId"]
        machine.fail("printf 'correct horse battery' | AGENTOS_INSTALL_ALLOW_PATH=1 AGENTOS_FAULT_POINT=install.copying agentos-install run --passphrase-stdin")
        machine.crash()                      # power cut: no unmount, no sync, /run is gone
        machine.start()
        machine.wait_for_unit("multi-user.target")
        assert inst("status")["state"] == "inspecting"      # nothing left in /run
        before = machine.succeed("sha256sum /dev/vdb1 | cut -d' ' -f1; sgdisk -p /dev/vdb | sha256sum").strip()
        r = inst("recover --disk /dev/vdb")                  # read-only look
        assert r["readOnly"] and r["recover"]["state"] == "copying" and r["recover"]["installId"] == iid, r
        assert machine.succeed("sha256sum /dev/vdb1 | cut -d' ' -f1; sgdisk -p /dev/vdb | sha256sum").strip() == before, "recover inspection wrote to the disk"
        assert inst("status")["state"] == "inspecting"
        # wrong disks: an empty same-model/same-size disk without serial, the small disk, the system disk
        v = inst("recover --disk /dev/vdd --resume", ok=False)
        assert "no interrupted AgentOS install" in v["error"], v
        inst("recover --disk /dev/vdc --resume", ok=False)
        inst("recover --disk /dev/vda --resume", ok=False)
        # a disk with existing partitions and a foreign AgentOS-looking ESP (another install id) is refused
        machine.succeed("sgdisk -n1:1MiB:+64MiB -t1:ef00 -c1:agentos-esp /dev/vdd && mkfs.vfat /dev/vdd1 && mkdir -p /tmp/e && mount /dev/vdd1 /tmp/e && mkdir -p /tmp/e/EFI/agentos && echo '{\"installId\":\"someone-else\"}' > /tmp/e/EFI/agentos/install.json && umount /tmp/e")
        v = inst("recover --disk /dev/vdd --resume", ok=False)
        assert "no interrupted AgentOS install" in v["error"], v
        # same model, same size, no serial, and a byte copy of our ESP (same install id on two disks): ambiguous
        machine.succeed("sgdisk --zap-all /dev/vdd && sgdisk -n1:1MiB:+2GiB -t1:ef00 -c1:agentos-esp /dev/vdd && dd if=/dev/vdb1 of=/dev/vdd1 bs=4M status=none && sync")
        v = inst("recover --disk /dev/vdd --resume", ok=False)
        print("clone refused:", v["error"])
        v = inst("recover --disk /dev/vdb --resume", ok=False)
        assert "2 disks" in v["error"], v
        machine.succeed("sgdisk --zap-all /dev/vdd && wipefs -a /dev/vdd")
        # the explicit entry adopts the state from the ESP; run then continues on the same disk
        r = inst("recover --disk /dev/vdb --resume")
        assert not r["readOnly"] and r["state"] == "copying", r
        v = inst("run --passphrase-stdin", stdin="correct horse battery")
        assert v["state"] == "installed" and v["installId"] == iid, v
        machine.fail("test -e /mnt/boot/EFI/agentos/install-state.json")   # cleared once installed
        machine.succeed("test -s /mnt/etc/agentos/install.json")
        machine.succeed("sync; umount -R /mnt; cryptsetup close agentos-root")
        machine.succeed("sgdisk --zap-all /dev/vdb && wipefs -a /dev/vdb")

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

    with subtest("the installed disk boots: systemd-boot → LUKS2 → Btrfs → unregistered machine (U01/U03)"), kill_on_fail():
        disk = os.path.join(machine.state_dir, "empty0.qcow2")
        vars_ = os.path.join(machine.state_dir, "ovmf-vars.fd")
        shutil.copy("${pkgs.OVMF.variables}", vars_)
        os.chmod(vars_, 0o644)
        start = (f"${pkgs.qemu_test}/bin/qemu-kvm -m 2048 -smp 2 "
                 f"-drive if=pflash,format=raw,unit=0,readonly=on,file=${pkgs.OVMF.firmware} "
                 f"-drive if=pflash,format=raw,unit=1,file={vars_} -drive file={disk},if=virtio,format=qcow2")
        target = create_machine(start, name="installed")
        extra.append(target)
        target.start()
        feed(target, "correct horse battery", "Password query on /dev/ttyS0 finished")
        target.wait_for_unit("multi-user.target", timeout=900)
        target.succeed("findmnt -no FSTYPE / | grep -q btrfs && cryptsetup status agentos-root | grep -q LUKS2")
        for sv in ["@nix", "@home", "@machine", "@broker", "@snapshots"]:
            target.succeed(f"findmnt -no OPTIONS -T / | grep -q subvol=/@root && btrfs subvolume list / | grep -q {sv}")
        target.wait_for_unit("agentos-machine.service")
        rc, o = target.execute("agentosctl status 2>&1")   # unregistered: no identity exists before first boot
        assert rc != 0 and "not installed" in o, o
        target.fail("test -e /var/lib/agentos-machine/first-boot-id")
        out = json.loads(target.succeed("printf 'alice-pw-1' | agentosctl firstboot --admin alice --workspace Home"))
        mid = out["machineInstallId"]
        target.fail("printf x | agentosctl firstboot --admin mallory")
        target.fail("ss -ltn | grep -vE '^State' | grep -q .")   # no TCP listener on the installed system
        target.succeed("test \"$(readlink -f /run/current-system)\" = " + TOP)
        target.shutdown()
        target.start()
        feed(target, "correct horse battery", "Password query on /dev/ttyS0 finished")
        target.wait_for_unit("agentos-machine.service", timeout=900)
        assert json.loads(target.succeed("agentosctl status"))["meta"]["machineInstallId"] == mid
        # The driver's cleanup does not stop a create_machine() VM: left running, nix build waited for it until the
        # CI cap even though every subtest had passed (run 41112940578: script finished at 1314 s, job cancelled at
        # 75 min). Shut it down explicitly.
        target.shutdown()
  '';
}
