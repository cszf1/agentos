# AgentOS v1.0 acceptance

Recorded at 18:27 Asia/Taipei on 30 October 2026. The host still reports `HOST_VERSION` `0.4.0`. This file does not mark v1.0 complete. A row is `pass` only when the command below produced the result the v1.0 specification names. A row is `blocked` when that command was not run, or when the run covered only part of the row. No row is `fail`.

The machine had Node 24.22.1, Rust 1.91.0, and g++ 13. It did not have Nix, Qt 6, a second login seat, or a signed release key. V3-E04 stays untested. Nothing in this file changes that.

## Commands that were run

`pnpm exec tsc -b packages/host` completed with exit 0.

`pnpm exec tsc -p tests/tsconfig.json --noEmit` completed with exit 0.

`pnpm contracts:check` completed with exit 0.

`pnpm exec vitest run --project unit --project identity --project machine --project migration-v1` reported 105 passed, then `pnpm exec vitest run --project identity` reported 9 passed after the role matrix assertion was added.

`cargo test -p agentos-protocol --test v1_vectors --test vectors` in `native/` reported 7 passed.

`cargo test -p agentos-broker --bin agentos-broker -- db::tests` reported 1 passed.

`CXX=g++ cmake -S desktop -B desktop/build && cmake --build desktop/build && ./desktop/build/v1_vectors fixtures/v1.0/protocol/vectors.json` printed `c++ v1 vectors match`.

## Baseline and contracts

| ID | Result | Evidence |
|---|---|---|
| V1-B01 | blocked | Unit, identity, machine, and migration-v1 passed. Native, sandbox, e2e, and recovery projects were not run. |
| V1-B02 | pass | `tests/integration/v02-contracts.test.ts` passed, including frozen hash `sha256:428df8c73bfcf3a1bc07029d9b5e31286728c4026d4cfe4a203fbc87211332d5` for `fixtures/todo-v1.json`. |
| V1-B03 | pass | `fixtures/v1.0/protocol/vectors.json` matches in TypeScript (`scripts/v1-vectors.mjs --check`), Rust (`v1_vectors` and `vectors`), and C++ (`desktop/build/v1_vectors`). The file covers a Unicode body, null, an integer, a duplicate key, and a non-finite number. |
| V1-B04 | blocked | Nix is not installed. There is no `flake.lock`. |
| V1-B05 | blocked | `MachineDirectory` rejects a second `storeUUID`. A Pi marker mismatch was not run again. |
| V1-B06 | pass | This file keeps contract tests, the faux-model unit suite, and the unrun VM and hardware rows apart. V3-E04 is not marked pass. |
| V1-B07 | blocked | `tests/migration/schema5.test.ts` keeps a `user:local` receipt hash. `db::tests::v3_log_upgrades_and_legacy_writes_stay_open_until_marked` keeps one effect row across schema 3 to schema 4. Neither test kills the process mid-write. |
| V1-B08 | blocked | No installation image was built. The development tree still contains test fixtures. |

## Login, members, and revocation

| ID | Result | Evidence |
|---|---|---|
| V1-I01 | blocked | No PAM or logind session was created. `userFromPeer` ignores a claimed user id in `tests/identity/access.test.ts`. |
| V1-I02 | blocked | No detached user-manager process was tested. |
| V1-I03 | blocked | `listVisible` hides a workspace from a non-member in `tests/machine/directory.test.ts`. Logs and counts were not checked through a second process. |
| V1-I04 | pass | `tests/identity/access.test.ts` checks every role against every workspace action, and a machine admin without membership cannot read. |
| V1-I05 | blocked | Own-task and any-task decisions are in the same test. Transcript text was not loaded. |
| V1-I06 | blocked | Revocation stays `revoking` until gateway, host, and broker ack. A previously committed business row was not paired with that ack. There is no UI. |
| V1-I07 | blocked | `admitPermit` revokes a reserved permit when the member version changed. No model request left the machine. |
| V1-I08 | blocked | The directory can record a missing ack. Host and broker were not killed. |
| V1-I09 | blocked | The last owner cannot be revoked. Disable keeps the login name reserved. A transfer of ownership was not asserted in the test file. |
| V1-I10 | blocked | A stale session epoch and a lock on a privileged action are rejected. An accepted run continues until the member version changes. Confirmation tickets are not implemented. |
| V1-I11 | blocked | Account creation takes no password argument. A log scan for secrets was not run. |
| V1-I12 | blocked | `admitWriteProtocol(3, 1)` is rejected in TypeScript and Rust, and `server.rs` calls `admit_write_protocol` before protocol 1 writes. A live broker socket was not used. |

## Workspace isolation

| ID | Result | Evidence |
|---|---|---|
| V1-W01 | blocked | Two workspaces receive different `executionUid` values in one process. File and socket access as those uids was not run. |
| V1-W02 | blocked | No application container was started. |
| V1-W03 | blocked | A workspace stays `creating` and invisible until the broker step. The test does not kill the process between steps. |
| V1-W04 | blocked | Stopping workspace A leaves workspace B `running` inside `MachineDirectory`. There is one process, not two hosts. |
| V1-W05 | blocked | No native canvas was built. |
| V1-W06 | blocked | No run was accepted and then retried against a second workspace. |
| V1-W07 | blocked | `stopWorkspace` returns the row to `stopped`. Archive and instance recovery were not run. |
| V1-W08 | blocked | `run_when_logged_out` defaults to 0. The owner path and the cap were not given their own assertion. |
| V1-W09 | blocked | No shared physical resource was registered with the broker. |
| V1-W10 | blocked | A second import of the same `storeUUID` is `STORE_ALREADY_REGISTERED`. Deletion and tombstones were not run. |

## Native rendering

| ID | Result | Evidence |
|---|---|---|
| V1-D01 | blocked | Qt 6 is not installed. The C++ code is a frame and JSON codec, not a Wayland shell. |
| V1-D02 | blocked | No native records view. |
| V1-D03 | blocked | No slot components were rendered. |
| V1-D04 | blocked | No click path was compared with the web renderer. |
| V1-D05 | blocked | No QML engine was loaded. |
| V1-D06 | blocked | No list or chart widget was built. |
| V1-D07 | blocked | No confirmation panel was built. |
| V1-D08 | blocked | No native task, maintenance, or proposal page was built. |
| V1-D09 | blocked | No event cursor was implemented. |
| V1-D10 | blocked | No input method or keyboard walk was run. |
| V1-D11 | blocked | No shell process was killed. |
| V1-D12 | blocked | No layout store or clipboard was implemented. |

## Hardware, session, and power

| ID | Result | Evidence |
|---|---|---|
| V1-H01 | blocked | No physical GPU session. |
| V1-H02 | blocked | No display mode change. |
| V1-H03 | blocked | swaylock was not started. |
| V1-H04 | blocked | NetworkManager was not called. |
| V1-H05 | blocked | PipeWire and backlight were not called. |
| V1-H06 | blocked | Suspend was not requested. |
| V1-H07 | blocked | Shutdown drain was not run. |
| V1-H08 | blocked | No unsupported device was probed. |

## Scheduling and budgets

| ID | Result | Evidence |
|---|---|---|
| V1-S01 | blocked | The directory caps foreground model permits at 2. A 24 hour budget counter was not implemented. |
| V1-S02 | pass | `chooseWaiter` gives the next model slot to the other waiting workspace, and `tests/machine/directory.test.ts` leaves workspace A queued while A and B each hold one slot. |
| V1-S03 | blocked | No build slot was held across a model wait. |
| V1-S04 | blocked | `admitPermit` rechecks membership. Observe mode, pause, and job cancel were not rechecked. |
| V1-S05 | blocked | `reconcilePermits` moves `reserved` and `in_use` to `reconciling` and does not free the slot. The processes were not killed. |
| V1-S06 | blocked | `confirmSlot` refuses to release a slot until `cgroupStopped` is true, and `unknown` usage stays charged. No cgroup was inspected. |
| V1-S07 | blocked | A background waiter is not chosen while a foreground permit is held. Compaction was not included. |
| V1-S08 | blocked | The machine directory was not made unreachable from a host. |

## Install and update

| ID | Result | Evidence |
|---|---|---|
| V1-U01 | blocked | No ISO was built. |
| V1-U02 | blocked | No disk was partitioned. |
| V1-U03 | blocked | `ensureInstall` keeps one `machineInstallId` for one `firstBootId` and rejects a second id. No qcow2 was cloned. |
| V1-U04 | blocked | `verifyManifestSignature` rejects a bad Ed25519 signature in `tests/identity/access.test.ts`. Nix `require-sigs` was not configured. |
| V1-U05 | blocked | `admitReleaseSequence` rejects an old sequence, and `rollbackKnownGood` keeps the high water. No key rotation was signed. |
| V1-U06 | blocked | No download was interrupted. |
| V1-U07 | blocked | No boot entry was written. |
| V1-U08 | blocked | The update state machine can move `trial_boot` to `validating` and then `committed` in `tests/machine/directory.test.ts`. systemd-boot was not used. |
| V1-U09 | blocked | No health agent ran. |
| V1-U10 | blocked | No commit-intent crash points were injected. |
| V1-U11 | blocked | `offline_breaking` is refused by `acceptRelease`. A second system generation was not booted. |
| V1-U12 | blocked | No Nix garbage collection ran. |

## Backup and restore

| ID | Result | Evidence |
|---|---|---|
| V1-R01 | blocked | No paired `os.sqlite` and `agent.sqlite` copy was made. |
| V1-R02 | blocked | No multi-volume barrier was taken. |
| V1-R03 | blocked | `planRestore` rejects a checkpoint that is still `building`. The worker was not killed. |
| V1-R04 | blocked | No age archive was written. |
| V1-R05 | blocked | No archive was unpacked. |
| V1-R06 | blocked | `applyMemberSnapshot` leaves a `revoking` member in place during restore. Broker history was not merged. |
| V1-R07 | blocked | `planRestore` closes business writes. Incarnation and client epoch were not advanced on a workspace database. |
| V1-R08 | blocked | No second workspace was left half-replaced. |
| V1-R09 | blocked | No cache rebuild was run. |
| V1-R10 | blocked | No second machine identity was cloned from a backup. |
| V1-R11 | blocked | A missing machine log was not repaired. |
| V1-R12 | blocked | Disk-full behavior was not injected. |

## v0.4 import

| ID | Result | Evidence |
|---|---|---|
| V1-M01 | blocked | No frozen v0.4 deployment was backed up. |
| V1-M02 | blocked | `importLegacy` stores the supplied receipt hash unchanged. App and record ids from a real backup were not compared. |
| V1-M03 | blocked | `bindLegacyPrincipal` records `user:local` without rewriting `operations`. An unfinished run was not left without new rights. |
| V1-M04 | blocked | Podman storage was not copied or rebuilt. |
| V1-M05 | blocked | `importLegacy` sets `legacy_policy_state` to `paused_needs_review`. Provider keys were not moved. |
| V1-M06 | blocked | No native UI replayed the v0.4 flows. |
| V1-M07 | blocked | A second `storeUUID` does not create another writable workspace. A bad backup hash was not staged. |
| V1-M08 | blocked | An old v0.4 binary was not pointed at a schema 5 file. |

## Delivery

| ID | Result | Evidence |
|---|---|---|
| V1-O01 | blocked | No real model call was made from a native UI. |
| V1-O02 | blocked | No overlapping model requests were captured. |
| V1-O03 | blocked | The existing unit test `O02 no model configured` still passes for the v0.4 host. It was not repeated on a native shell. |
| V1-O04 | blocked | No boot or input latency sample was taken. |
| V1-O05 | blocked | No background load measurement was taken. |
| V1-O06 | blocked | No SIGKILL or power cut was injected. |
| V1-O07 | blocked | The C++ and Rust parsers agree on the vector file. A fuzzer was not run. |
| V1-O08 | blocked | No diagnostic bundle was collected. |
| V1-O09 | blocked | One C++ build and one Rust test build ran. A second clean build and an ISO install were not done. |
| V1-O10 | blocked | 5 of 100 rows are pass. The rest are blocked. v1.0 is not a release. |
