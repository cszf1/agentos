# v0.4 acceptance report (2026-10-29)

Baseline: [AGENTOS_MVP_V0.4.md](AGENTOS_MVP_V0.4.md) §26 (M0–M8), §27 (88 items) and §28. Item-by-item evidence:
[V0.4_CHECKLIST.md](V0.4_CHECKLIST.md); design decisions and the running log: [V0.4_PROGRESS.md](V0.4_PROGRESS.md).
Every row names what the evidence ran on:

- **in-process** — `openCore` with a manual clock and the real persistence/services (unit, agents, maintenance,
  gc-online, compaction projects).
- **real process** — the built host as a child process with SIGKILL fault points (recovery, maintenance-recovery).
- **real Podman** — rootless Podman 5.4.2 on the development box (sandbox project, e2e).
- **real native** — the installed root broker (protocol 1 + 2), workers and demo systemd units (native, broker-recovery).
- **real eBPF (guest)** — the fixed BPF object in the QEMU guest kernel 6.12 with BTF (telemetry; the boxes have none).
- **faux model** — the real Pi Durable 1.4.0 runtime and host tools with the deterministic faux model.
- **real model** — `openai-compatible` TokenRhythm `qwen3.8-flash`, `reasoning_effort=low`, through a key-less relay
  (the key never exists on the test machines).
- **software PTY** — the PTY serial sample, a software protocol test, **not** serial hardware.

## Environments

| | Development box `agentos` | Clean box `agentos-clean4` (README install, V4-O04) | Clean box `agentos-clean3` (v0.3 → v0.4 upgrade, V4-O04) | eBPF acceptance guest |
|---|---|---|---|---|
| OS / kernel | Debian 13.7, 6.18.54-instabox, x86_64 | Debian 13, 6.18.54-instabox, created empty | Debian 13, same kernel, v0.3 installed by its README | Debian 13 genericcloud 6.12 (QEMU TCG on the dev box) |
| CPU / memory / storage | 4 vCPU AMD EPYC, 7 GiB, `/data` 20 GB virtio disk, `/tmp` 3.9 GB tmpfs | same class | same class | QEMU TCG guest |
| BTF / tracing | **no** `/sys/kernel/btf/vmlinux` | no | no | present |
| systemd / Podman | 257.13 / 5.4.2 rootless | same | same | — |
| Node / pnpm / Pi | 24.22.1 / 10 / Pi Durable **1.4.0** (pinned) | same via README | same | — |
| Native | rustc 1.91.0 (`native/rust-toolchain.toml`), crate version **0.4.0**, `Cargo.lock` sha256 `b266d6e7…3735e` | same via rustup | same | — |
| Broker | `agentos-broker 0.4.0`, **protocol 1 + 2**, broker.sqlite **schema 3**, test mode on (`AGENTOS_MAINT_CAPS=40:400:1`, second demo unit `agentos-demo2`) | protocol 1/2, **test mode off**, default caps | upgraded in place, protocol 1/2 | — |
| os.sqlite | schema **4** (v0.3 = 3) | 4 | 3 → 4 | — |

### Native artifacts (`pnpm native:build` manifest on the dev box, final full run)

| File | sha256 |
|---|---|
| `agentos-broker` | `aae5747b8795065faa076395e3d97b26ae3a34431afc7eb13c129b31eb5bc406` |
| `agentos-worker` | `c4f808ce5d9824f4ce67041d643fe8a1b52fc7b2a47c3df372c017024f3bcd54` |
| `agentos-provider-user` | `77e8f0daf460c0f6cdd42d21747e66c3ba7c4357eed7ed3f40fd3d832658430f` |
| `agentos-telemetry` | `8eaae8bcf27bd89404cc8cdaa799fd4ef1b5519eb3e0bc0e15033b6bf0fa0d2e` |
| `agentos-serial-sim` | `e13732e2641c981d89b8f2e205fd1e84861691757b0cd4878db7804b5489ba3e` |
| `native/bpf/exec_exit.bpf.o` (unchanged from v0.3) | `edf86f1cd8130fe3316546cf7812058b936a4e76df9bdd267c7c6380c664a59c` |

The native build is path-independent (v0.3 remap flags kept); the dev box and `agentos-clean4` built byte-identical
artifacts from the same tree. `cargo fmt --all -- --check` (native/rustfmt.toml, width 160) passes, `cargo test --release`
passes, and the build has 0 Rust warnings. Runtime catalog `runtime/catalog/catalog.json` sha256 `cee0025b…58d8660` is
unchanged from v0.3 (ABI-1/ABI-2 locks byte-identical).

## Suite results (development box)

Full regression `/data/home/full2.sh` on the tree of commit `bfcdc69` (2026-10-29 15:40–16:30 CST); the later commits
change only the agent-pi bundle-argument decoding, `candidate_stage` and the smoke script, and the affected suites were rerun
on the final tree (second table).

| Command | Ran on | Result |
|---|---|---|
| `pnpm native:build`; `pnpm build`; `tsc --noEmit` for core/host/agent-pi/web | — | all exit 0 |
| `vitest --project unit` (v0.1–v0.3 unit + v0.4 contracts, migration, review regressions incl. #5 List item binding) | in-process | 80/80 |
| `pnpm test:agents` (two foreground sessions, routing, queues, cancel/finalise, role tool sets) | in-process, faux model | 21/21 |
| `pnpm test:maintenance` (templates, policies, receipts, incidents, budgets, archive, notifications, space) | in-process | 21/21 |
| `pnpm test:maintenance-recovery` (SIGKILL in trigger tx, after step admission, after effect, after app intent) | real process | 4/4 |
| `pnpm test:gc-online` | in-process, real files | 7/7 |
| `pnpm test:compaction` (incl. HTTP endpoint test) | in-process, faux model | 6/6 |
| `vitest --project recovery` (v0.1–v0.3 + v04 upgrade/restore/offline, perf O05) | real process | 32/32 + 3 skipped (opt-in V2-O01, V2-O03, V3-O01 — rerun with their real sources below), perf 1/1 |
| `vitest --project sandbox` (v0.2/v0.3 + v04 proposals, offline real recovery) | real Podman | 60/60 + 1 skipped (opt-in V2-B04 offline — rerun below) |
| `vitest --project native` | real native | 21/21 |
| `vitest --project broker-recovery` broker-kill, host-crash, maintenance-v2 (protocol 2), zz-restore | real native | 32/32 |
| `tests/broker-recovery/host-maintenance.test.ts` (real host + broker, two SIGKILL points; run separately because the root caps of `agentos-demo2` allow 3 recoveries per 24 h) | real native | passed (box run logged in V0.4_PROGRESS 15:10) |
| `vitest --project telemetry` | real eBPF (guest) + host-unavailable path | 6/6 |
| `playwright test` (v0.1–v0.3 specs + `v04-centers.spec.ts`) | real browser (Chromium) | 8/8 |

Final-tree reruns (`/data/home/aff.sh`, commit `9459fee`):

| Command | Result |
|---|---|
| `pnpm build` | exit 0 |
| `vitest --project unit` | 80/80 |
| `vitest --project agents` (adds the trailing-bracket decoding tests) | 23/23 |
| `vitest --project maintenance` | 21/21 |
| `vitest --project compaction` | 6/6 |
| `vitest --project sandbox tests/sandbox/v04-proposals.test.ts` (faux refactor now sends `files`; candidate differs from the base only in that file) | 3/3 |

__REALMODEL__

## Performance (V4-O05)

`tests/recovery/v04-perf.test.ts` on the dev box (4 vCPU, 7 GiB, virtio disk; no model in the loop). Same dataset, A/B
alternating rounds (3 baseline + 3 with background, 200 CRUD/query operations each, warm-up round discarded) while the
background rounds run 3 maintenance jobs and one conversation compaction (faux). Raw samples:
`docs/evidence/perf-v04-o05.json`.

| | p50 | p95 |
|---|---|---|
| no background | 0.783 ms | 1.333 ms |
| background batch running | 0.795 ms | 1.473 ms |
| ratio | | **1.105** (limit 1.25) |

A first version measured sequential blocks and was biased by table growth (even an idle control gave 1.25–1.30); it was
replaced by the alternating design before this result.

## Clean install and upgrade (V4-O04)

- `agentos-clean4` (empty Debian 13): README v0.4 install. `pnpm runtime:doctor` all checks ok; broker reports protocol 1
  and 2, `hostVersion 0.4.0`, test mode off; `pnpm agents:doctor` and `pnpm maintenance:doctor` all ✓; native doctor ok;
  model shown as unavailable (no key on the box, by design).
- `agentos-clean3` (v0.3 installed by the v0.3 README): README upgrade. records hash before = after, os.sqlite schema 3 → 4,
  broker schema 2 → 3 with rows copied (no deletion), new writes work, doctors pass. Backup + restore on this box found a
  real bug (an empty `managed/` directory was not created in the backup); fixed in `backup-v3.ts`, rerun passed with
  `workspaceIncarnation: 2`.
- B02 (real v0.3 workspace): v0.3 build of git `7b31947` generated `/data/home/v03-ws` (`scripts/make-v03-workspace.mjs`);
  `tests/recovery/v04-upgrade.test.ts` passed: apps, revisions, records, runs, deployments preserved; code app runtime and
  queries work; a new task succeeds.

## Matrix (§27, 88 items)

Labels say what each row ran on; "faux model" rows use the real Pi Durable 1.4.0 runtime with the deterministic faux model.

__MATRIX__

## §26 exit conditions

| Milestone | Status |
|---|---|
| M0 | Pi 1.4.0 prototype (`m0-pi-prototype.test.ts`): two sessions, routing, per-session abort, atomic session dir, atomic compaction registration, restart rebuild |
| M1 | contracts/migrations: B04–B07, migration test; v0.3 single-slot index removed, nullable target, strict enums |
| M2 | two foreground slots, target queue, build/prepare queues, per-session cancel/finalise, global model permit (S01–S10); real-model overlap in O01 |
| M3 | J01–J08, health observation and incidents, clock anomalies, budgets/cooldowns, global pause |
| M4 | H01–H08, P01–P08 incl. broker protocol 2 on the real broker (root caps, maintenance principal, control epochs, attempt reservation, native ensure-running) |
| M5 | G01–G08, archive/restore E06/E07 |
| M6 | E01–E08, C01–C06; real-model candidate and compaction in O01/O03 |
| M7 | R01–R10 |
| M8 | __M8__ |

## Scope and what is not claimed (V4-O08)

- Automatic actions are only the ones a user policy enables inside root caps: app recovery through RuntimeManager, the
  registered demo service ensure-running, online cache GC and archive. Diagnosis and optimisation produce reports and
  candidates; nothing is installed, merged or published without the user's exact hash + epoch. There is no "whole machine
  maintains itself" claim.
- **V3-E04 remains not accepted**: no serial hardware exists on any test machine; every serial result is from the software
  PTY sample and is labeled so.
- eBPF is verified only in the QEMU guest (kernel 6.12 with BTF). The development and clean boxes have no BTF; there the
  collector reports unavailable and nothing depends on it.
- Real-model evidence uses one provider/model (`qwen3.8-flash`, `reasoning_effort=low`) through a key-less relay; other
  models were not tested.
- Model output defects seen in real runs are not hidden: only a missing/extra closer at the very end of a stringified
  bundle is repaired, a defect inside the body is refused with its position, and the result is validated like any other
  bundle.

