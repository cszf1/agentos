# M6 qcow2 template (spec §19.1, V1-U03 in a KVM VM): the template is built by os/packages/qcow2.nix (the same
# installer and layout as an ISO install) from the release modules + the NixOS test backdoor (needed to drive the
# guest; the release output `agentos-qcow2` uses the plain release toplevel). Two clones of one template boot,
# each must replace the template disk key before machined starts, and first boot gives each its own identity.
{ pkgs, mkSystem, releaseModules, nixpkgs }:
let
  installed = mkSystem (releaseModules ++ [
    "${nixpkgs}/nixos/modules/testing/test-instrumentation.nix"
    ({ lib, ... }: { agentos.graphical = lib.mkForce false; boot.kernelParams = [ "console=ttyS0" ]; users.users.root.hashedPasswordFile = lib.mkForce null; })
  ]);
  top = installed.config.system.build.toplevel;
  installer = pkgs.callPackage ./../packages/installer.nix { system = top; };
  image = pkgs.callPackage ./../packages/qcow2.nix { system = top; inherit installer; qemu = pkgs.qemu-utils; name = "agentos-qcow2-test"; };
in
pkgs.testers.runNixOSTest {
  name = "agentos-m6-qcow2";
  nodes = { };
  testScript = ''
    import json, os, shutil, subprocess
    IMG = "${image}/agentos.qcow2"
    TOP = "${top}"
    assert open("${image}/system").read().strip() == TOP

    def boot(n):
        d = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"clone{n}")
        os.makedirs(d, exist_ok=True)
        disk = os.path.join(d, "disk.qcow2")
        if not os.path.exists(disk):
            subprocess.run(["${pkgs.qemu_test}/bin/qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", IMG, disk], check=True)
        vars_ = os.path.join(d, "ovmf-vars.fd")
        if not os.path.exists(vars_):
            shutil.copy("${pkgs.OVMF.variables}", vars_)
            os.chmod(vars_, 0o644)
        start = (f"${pkgs.qemu_test}/bin/qemu-kvm -m 2048 -smp 2 "
                 f"-drive if=pflash,format=raw,unit=0,readonly=on,file=${pkgs.OVMF.firmware} "
                 f"-drive if=pflash,format=raw,unit=1,file={vars_} -drive file={disk},if=virtio,format=qcow2")
        return create_machine(start, name=f"clone{n}")

    ids = []
    for n in (1, 2):
        m = boot(n)
        with subtest(f"clone {n}: the template key opens the disk once and must be replaced before machined (U03)"):
            m.start()
            m.wait_for_console_text("New AgentOS disk passphrase", timeout=900)
            m.fail("systemctl is-active agentos-machine.service")
            m.send_console("clone-pass-" + str(n) + "\n")
            m.wait_for_console_text("Repeat the disk passphrase", timeout=120)
            m.send_console("clone-pass-" + str(n) + "\n")
            m.wait_for_unit("agentos-machine.service", timeout=600)
            m.fail("cryptsetup open --test-passphrase --key-file=/etc/agentos/template-disk.key /dev/disk/by-partlabel/agentos-luks")
            m.succeed(f"printf clone-pass-{n} | cryptsetup open --test-passphrase --key-file=- /dev/disk/by-partlabel/agentos-luks")
            m.succeed("cryptsetup status agentos-root | grep -q LUKS2 && findmnt -no FSTYPE / | grep -q btrfs")
            m.succeed("test \"$(readlink -f /run/current-system)\" = " + TOP)
            m.succeed("jq -e '.template == true' /etc/agentos/install.json || grep -q '\"template\":true' /etc/agentos/install.json")
            st = json.loads(m.succeed("agentosctl status"))
            assert st["meta"]["firstBootState"] != "closed", st
            out = json.loads(m.succeed("printf 'admin-pw-1' | agentosctl firstboot --admin alice --workspace Home"))
            ids.append(out["machineInstallId"])
            m.fail("ss -ltn | grep -vE '^State' | grep -q .")
        with subtest(f"clone {n}: after a reboot the disk asks for the new passphrase; identity kept"):
            m.shutdown()
            m.start()
            m.wait_for_console_text("assphrase", timeout=900)
            m.send_console("clone-pass-" + str(n) + "\n")
            m.wait_for_unit("agentos-machine.service", timeout=900)
            assert json.loads(m.succeed("agentosctl status"))["meta"]["machineInstallId"] == ids[-1]
            m.shutdown()
    assert ids[0] != ids[1], ids
  '';
}
