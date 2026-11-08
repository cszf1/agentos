# New-install initialization protocol, version 1

This protocol recovers **new quick installs on completely zero disks** that have a
stable `/dev/disk/by-id/` name and a serial or WWN. Legacy checkpoints, templates,
non-quick installs and disks without that hardware identity keep the existing
legacy path. Legacy `partitioning` checkpoints still refuse automatic recovery.
Version 1 uses the public quick-install template key and rejects an operator
stdin-key override before writing. A new quick plan with this protocol refuses a
nonzero target even if an operator has confirmed that plan. It does not turn a recovery attempt into a new erase.

## Immutable ownership record

Before the first GPT write, the installer persists the plan in two 64-KiB raw
slots at byte offsets 4 MiB and 8 MiB, then fsyncs both. The ESP starts at 16 MiB,
so neither GPT nor a partition filesystem covers those slots. A fresh target is
fully checked for zeros before the journal is created.

The plan binds the by-id name, serial/WWN, model, size, original identity,
installer medium and system closure. It preassigns the GPT disk GUID, both
partition GUIDs, FAT volume ID, LUKS UUID, Btrfs UUID and partition geometry.
`sgdisk`, `mkfs.vfat`, `cryptsetup luksFormat --uuid` and `mkfs.btrfs -U` receive
those identifiers explicitly. The LUKS data offset is fixed at 16 MiB.

Each slot has framing, a length, SHA-256 checksum and zero padding. Records have
an exact versioned schema, phase/sequence and the previous record's digest.
The sequence is the phase's index plus one. Two equal copies are accepted. Two
adjacent, hash-linked copies are also accepted after interrupted replication.
A malformed, missing half, divergent or unlinked recognized journal refuses.
Checksums detect interrupted writes. They do not authenticate against a malicious
root operator or host that can rewrite disks and spoof device identities.

## Observed states and admitted transitions

| Checkpoint phase | Allowed observation |
| --- | --- |
| gpt-before | zero disk except journal, or exact GPT with zero partitions |
| gpt-after | exact GPT with zero partitions |
| esp-before | zero ESP, or matching FAT with only protocol metadata |
| esp-after | matching FAT with only protocol metadata |
| luks-before | zero LUKS partition, or matching usable LUKS with untouched payload |
| luks-after | matching usable LUKS with untouched payload |
| fs-before | untouched LUKS payload, or matching empty Btrfs |
| fs-after | matching empty Btrfs |
| subvol-before | empty Btrfs or a subset of the fixed, empty subvolumes |
| subvol-after | all fixed subvolumes, empty |
| copying | initialization is complete; a durable copy barrier precedes payload writes |

The observer validates GPT geometry, partition GUIDs/types/names and GPT integrity.
Unclaimed disk regions must be zero. A matching LUKS UUID and valid header must
open with the public quick-install key. Existing matching LUKS is reused, never
reformatted. An unrecognized inner filesystem is initialized only if its raw
ciphertext payload is still entirely zero. Recognized Btrfs must match its
precommitted UUID. Read-only observation disables Btrfs log replay and rejects
unknown files, non-subvolume directories or nonempty subvolumes.

Each initialization write has a persisted `before` phase and a flushed `after`
phase. Once FAT exists, checkpoint transitions must also persist the ESP copy.
A current or immediately preceding, hash-linked ESP copy is accepted. Replicas
are brought to the same record before continuing. ESP mount, fsync and unmount
failures stop the installer. No payload copying starts without both the raw
`copying` barrier and successful ESP persistence.

The CLI holds an exclusive installer lock. Disk tools inherit it so killing only
the parent does not allow a second installer to race a still-running tool.

## Safe refusal boundaries

A power loss during the initial two-slot journal commit can leave only one valid
copy. That window refuses instead of guessing ownership. Torn GPT, FAT, LUKS,
Btrfs or ESP checkpoint writes also refuse unless the normal observer can prove
the complete pre-write or post-write state. No repair-by-reformat is attempted.

Automatic recovery stops once the raw journal says `copying`, unless a matching
completed-install marker proves installation finished. An interrupted payload
copy requires explicit `recover --resume`. Error hints provide an actual by-id
command, or a command-local path override for read-only inspection when necessary.

A blank auto install performs the original two zero scans plus one final full
scan before creating its journal. Recovery scans unclaimed regions and whichever
partitions still require a zero proof once, not once per phase. These are byte
work bounds, not measured device throughput.

## Verification boundary

Unit tests run the production observer and phase driver with block-tool/mount
adapters, including both admitted sides of every phase. Separate tests use real
journal files, interior-data/short-read probes, real `sgdisk`/`sfdisk` and an
actual inherited-lock child process. M24 adds a real ISO power cut after LUKS
creation but before its after-checkpoint and requires recovery without another
`luksFormat`. Nix evaluation checks the VM test wiring; it is not a VM boot or
power-loss execution result.
