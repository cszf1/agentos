import json

GOOD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
CAND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
BAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
UW = "agentos-update-worker"

def uw(args):
    out = machine.succeed(f"{UW} {args}")
    v = json.loads(out.strip().splitlines()[-1])
    assert v["ok"], v
    return v["result"]

def write_entry(rid, init_override=None, extra=""):
    machine.succeed("readlink -f /run/current-system > /tmp/sys")
    sysp = machine.succeed("cat /tmp/sys").strip()
    kernel = machine.succeed(f"readlink -f {sysp}/kernel").strip()
    initrd = machine.succeed(f"readlink -f {sysp}/initrd").strip()
    ih = "sha256:" + machine.succeed(f"sha256sum {initrd} | cut -d' ' -f1").strip()
    params = machine.succeed(f"cat {sysp}/kernel-params").strip()
    init = init_override or f"{sysp}/init"
    return uw(f"write-entry --esp /boot --release-id {rid} --kernel {kernel} --initrd {initrd} --initrd-hash {ih} --init {init} --cmdline '{params} {extra}' --title 'AgentOS {rid[:8]}'")

def booted_release():
    return machine.succeed("tr ' ' '\\n' < /proc/cmdline | sed -n 's/^agentos.release=//p'").strip()

machine.start()
machine.wait_for_unit("multi-user.target")
machine.succeed("test -d /sys/firmware/efi/efivars")

with subtest("known-good and candidate entries are complete; the default is known-good"):
    write_entry(GOOD)
    machine.succeed(f"bootctl set-default agentos-{GOOD}.conf")
    write_entry(CAND)
    machine.succeed(f"test -s /boot/loader/entries/agentos-{CAND}.conf && test -s /boot/EFI/agentos/{CAND}/linux && test -s /boot/EFI/agentos/{CAND}/initrd")
    # foreign entries (NixOS' own generations) exist and are not registered
    machine.succeed("ls /boot/loader/entries/ | grep -v '^agentos-' | grep -q .")

with subtest("first boot into known-good from the persistent default"):
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("multi-user.target")
    assert booted_release() == GOOD, booted_release()

with subtest("one-shot trial boots the candidate exactly once; default unchanged (U08)"):
    r = uw(f"arm --esp /boot --release-id {CAND} --known-good {GOOD}")
    assert r["oneshot"] == f"agentos-{CAND}.conf", r
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("multi-user.target")
    assert booted_release() == CAND, booted_release()
    facts = json.dumps({"state": "armed", "candidate": CAND, "knownGood": GOOD})
    a = uw(f"after-boot --facts '{facts}' --boot-id $(cat /proc/sys/kernel/random/boot_id)")
    assert a["action"] == "enter_validating", a
    # without commit the next boot returns to known-good
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("multi-user.target")
    assert booted_release() == GOOD, booted_release()

with subtest("commit sets and reads back the default (U10)"):
    r = uw(f"commit --release-id {CAND}")
    assert r["default"] == f"agentos-{CAND}.conf", r
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("multi-user.target")
    assert booted_release() == CAND, booted_release()
    facts = json.dumps({"state": "validating", "candidate": CAND, "knownGood": GOOD, "commitIntent": True, "trialBootId": "x"})
    a = uw(f"after-boot --facts '{facts}' --boot-id $(cat /proc/sys/kernel/random/boot_id)")
    assert a["action"] == "finish_commit", a

with subtest("a bad candidate (no init) falls back to the default, no endless retry (U08)"):
    write_entry(BAD, init_override="/nix/store/00000000000000000000000000000000-missing/init", extra="boot.panic_on_fail panic=1")
    uw(f"arm --esp /boot --release-id {BAD} --known-good {CAND}")
    machine.succeed("sync")
    machine.shutdown()
    machine.start()
    # stage 1 panics, the kernel resets, the firmware boots the persistent default (one-shot consumed)
    machine.wait_for_unit("multi-user.target", timeout=900)
    assert booted_release() == CAND, booted_release()
    facts = json.dumps({"state": "armed", "candidate": BAD, "knownGood": CAND})
    a = uw(f"after-boot --facts '{facts}' --boot-id $(cat /proc/sys/kernel/random/boot_id)")
    assert a["action"] == "rolled_back", a
    machine.fail("test -n \"$(cat /sys/firmware/efi/efivars/LoaderEntryOneShot-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f 2>/dev/null)\"")

with subtest("GC removes only unpinned registered entries; NixOS entries stay (U12)"):
    before = machine.succeed("ls /boot/loader/entries | grep -v '^agentos-' | sort")
    r = uw(f"gc --esp /boot --keep {CAND},{GOOD}")
    assert r["removed"] == [BAD], r
    after = machine.succeed("ls /boot/loader/entries | grep -v '^agentos-' | sort")
    assert before == after, (before, after)
    machine.succeed(f"test -e /boot/loader/entries/agentos-{GOOD}.conf && test -e /boot/loader/entries/agentos-{CAND}.conf")
