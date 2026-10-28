# v0.3 acceptance report (2026-10-29)

Baseline: [AGENTOS_MVP_V0.3.md](AGENTOS_MVP_V0.3.md) §25 (M0–M7), §26 (80 items) and §27. The v0.1/v0.2 regressions are
kept and rerun. Every row says what the evidence ran on. Labels used below:

- **real native** — the installed root broker, unprivileged workers, provider-user and real kernel/systemd/nftables objects.
- **real eBPF (guest)** — the fixed BPF object loaded on a real kernel with BTF inside the QEMU acceptance guest.
- **faux model** — the real Pi Durable runtime and host tools with the deterministic faux model.
- **real model** — `openai-compatible` TokenRhythm `qwen3.8-flash`.
- **software PTY** — the PTY serial sample (`agentos-serial-sim`), a software protocol test, **not** serial hardware.

## Environments

| | Development box `agentos` | Clean box `agentos-clean3` (README reproduction, V3-O08) | eBPF acceptance guest |
|---|---|---|---|
| OS / kernel | Debian 13 (trixie), 6.18.54-instabox, x86_64 | Debian 13 (trixie), 6.18.54-instabox, created empty | Debian 13 genericcloud, **6.12.113+deb13-cloud-amd64**, QEMU TCG on the dev box |
| BTF / tracing | **no** `/sys/kernel/btf/vmlinux`, no tracefs/tracepoints | same (no) | `/sys/kernel/btf/vmlinux` present, tracepoints available |
| systemd / Podman / crun | 257.13 / 5.4.2 rootless / 1.21 | 257.13 / 5.4.2 / Debian crun | — |
| Libraries | libnftables1 1.1.3, libbpf1 1.5.0, libsystemd0/libudev1 257.13 | same packages via README | libbpf from the guest's Debian |
| Native toolchain | rustc/cargo 1.91.0 (rust-toolchain.toml), clang 19.1.7, `Cargo.lock` sha256 `94e7ddc9…7594c` | same via rustup + README | — |
| Node / pnpm | 24.22.1 / 10 | 24.22.1 / 10 | — |
| Broker | `agentos-broker 0.3.0 protocol 1`, policyFormat 1, test mode on | protocol 1, **test mode off** | — |

Known VM quirk on both boxes: `/proc/sys/kernel/random/boot_id` is overmounted (README Troubleshooting has the fix; the clean
install script applies it).

### Artifacts (pnpm native:build manifest)

| File | sha256 |
|---|---|
| `native/bpf/exec_exit.bpf.o` (fixed BPF object; identical on the box install and in the guest) | `03a2234af161eca63bb6d9b0f1980e194cef118bfabb2698b95e2ab9fe4c84a8` |
| `agentos-broker` | `dcc03bf6ab6b21dc37808394e1a1eb76c69f25fc6bcf19a45a2644ca7bb33de0` |
| `agentos-worker` | `0b626b9e4bacd9a351118bcac70b2642a22adbe803d88ce6dbbd39aec4a9a9ba` |
| `agentos-provider-user` (runs as the host user, from the checkout) | `40657bcc566270b45346ff8d95ce5fc9a3a09bbdeeb4f3d4d5cc686f340abb92` |
| `agentos-telemetry` | `51445fef4bba4bde7c6f7e11725ed255a56f52f28da8f9499dfb4b965b58047a` |
| `agentos-serial-sim` | `8f6a572aa590ec5952b50681e1dc545ab74f347ccb65994208266ccdd7e6218b` |

The installed copies under `/usr/lib/agentos` on the dev box have exactly these hashes. Policy
`/etc/agentos/broker/policy.json` (policyFormat 1) sha256 `8a4681ff93f906611dbaa339d54a8058c3554605bfa9aa92d6eb37236850ace6`.
Runtime catalog: `runtime/catalog/catalog.json` sha256 `cee0025b4dade0751a94d31e300e441ca954f4d9520cf87c41c9aef6c58d8660`,
catalog hash `sha256:37b6fca0829c00c15e9de803d1e31ef53c2c3ed6bc72ce10bfa35481d600cb7b`; ABI-1 locks `core-v1@1`/`data-v1@1` are
byte-identical to the v0.2 release (V3-C07 test against `fixtures/v0.2/catalog-v0.2.json` = `79377eb:runtime/catalog/catalog.json`);
new ABI-2 locks `core-v2@1`/`data-v2@1`. `fixtures/v0.3/system-console/bundle.json` canonical hash
`sha256:00a0a63321e202687553b4099583352e1d65158298b50898750092f524720adc`.

Devices: no serial hardware is attached to any test machine. The only serial resource is the software PTY sample
(identity `pty-fixture`, major 136, profile `telemetry-echo-v1`).

## Suite results (development box, final tree)

| Command (dev box, `AGENTOS_OFFLINE_TEST=1`, `AGENTOS_V01_ROOT`=real v0.1 build of `7cd2bbe`, `AGENTOS_UPGRADE_SOURCE`=copy of the live v0.2 workspace) | Result |
|---|---|
| `pnpm build`; `tsc -p packages/web --noEmit`; `protocol-vectors.mjs --check`; `export-contracts.mjs --check` | pass |
| `vitest --project unit` (v0.1/v0.2 unit + v0.3 contracts, review regressions) | 72/72 |
| `vitest --project recovery` (v0.1 16 + v0.2 13 incl. V2-O01 real v0.1 copy and V2-O03 offline restore + v0.3 upgrade 2) | 31/31 |
| `vitest --project sandbox` (v0.2 suites + `v03-system` 18 + v0.3 regressions, real rootless Podman, opt-in offline test included) | 56/56 |
| `vitest --project native` (installed root broker and workers) | 21/21 |
| `vitest --project broker-recovery` (broker-kill 12, host-crash 5, zz-restore 5) | 22/22 |
| `vitest --project telemetry` (host unavailable path + guest eBPF via QEMU) | 6/6 |
| `playwright test` (v0.1/v0.2 specs + `v03-system.spec.ts`, Chromium) | 7/7 |
| `pnpm smoke:v0.3-real` (run 4) | E01–E03 pass |

An earlier full pass on the same tree failed 2 recovery and 23 sandbox tests only because the box's 3.9 GB `/tmp` tmpfs had
filled with test temp directories ("less than 256 MiB free … new builds are refused"); after cleaning `/tmp` all passed.
Fixes made during the final passes: telemetry/refresh timers no longer touch a closed store after shutdown (unhandled
rejection in unit), V2-A05 expects the v3 tool set, G02 treats a broker that closes before the client writes as a refusal.

## Matrix (§26)

| ID | Evidence | Status |
|---|---|---|
| V3-C01 | v0.1/v0.2 regressions (`tests/integration/v02-contracts.test.ts` frozen v1 hash `sha256:428df8c7…332d5`, v2 fixture hash, records rules) in the unit/recovery/sandbox runs | pass |
| V3-C02 | `tests/sandbox/v03-system.test.ts` C02/G03: system-console v3 app builds and runs on ABI 2; wrong ABI / v3 fields in old formats refused (`tests/integration` contract tests) | pass — real sandbox |
| V3-C03 | v03-system C03: mutations + effect, other capability, several effects refused | pass |
| V3-C04 | `scripts/protocol-vectors.mjs --check` + `native/crates/protocol/tests/vectors.rs`: same canonical JSON, numeric ranges, depth limits, unknown fields and domain hashes in TS and Rust | pass |
| V3-C05 | `tests/native/native-providers.test.ts` C05: shell, unit text, raw messages, script/bytecode paths refused by TS and the broker | pass — real native |
| V3-C06 | v03-system C06: forged, expired, cross-call, cross-run, wrong-generation observations refused; same-run tool observation accepted | pass |
| V3-C07 | `tests/recovery/v03-upgrade.test.ts` C07 + V3-O01 old code app still runs on its ABI-1 lock | pass |
| V3-G01 | native G01: over-cap grant refused by the broker from its root policy | pass — real native |
| V3-G02 | native G02: self-reported UID, wrong peer, wrong installId/incarnation refused (SO_PEERCRED) | pass — real native |
| V3-G03 | v03-system C02/G03: wrong app/revision/alias/resource version refused; v1/v2 apps get no system bindings (also O01) | pass |
| V3-G04 | v03-system G04 + broker-recovery G04: pending grant admits nothing; the same grant intent re-sent does not widen | pass — real native |
| V3-G05 | `tests/broker-recovery/broker-kill.test.ts` G05: revocation committed first blocks dispatch; confirmed durably by the broker | pass — real native |
| V3-G06 | v03-system G06 + `tests/broker-recovery/host-crash.test.ts` G06: broker down → host blocks at once, shows 授权撤销中, broker confirms after reconnect | pass — real native |
| V3-G07 | v03-system G07: preview/candidate instances and records commands never read real provider state | pass |
| V3-G08 | v03-system G08: version switch voids provider grants; switching back does not revive them | pass |
| V3-F01 | native F01: traversal, symlinks, magic links, foreign mounts, swap races refused (openat2 RESOLVE_BENEATH/NO_MAGICLINKS/NO_XDEV) | pass — real native |
| V3-F02/F03 | native F02/F03: special files and hard links refused; read-only roots read with the user's permissions; size/encoding/concurrent change reported, truncation explicit | pass — real native |
| V3-F04 | native F04: exclusive writer `agentos-file`; the host user and containers cannot write the managed parent or target | pass — real native |
| V3-F05 | native F05: expectedAbsent never overwrites; stale version refused | pass — real native |
| V3-F06 | broker-recovery F06: kills after temp write, after rename, worker before/after rename — never a third content | pass — real native |
| V3-F07 | v03-system F07: compensation restores only while the file still has the written version; history kept | pass — real native |
| V3-S01 | native S01: arbitrary unit/PID/ExecStart/env/manager requests refused | pass — real native |
| V3-S02/S03 | native S02/S03: job accepted ≠ success; real unit state read after; ensure no-op when satisfied, no unsafe restart | pass — real systemd |
| V3-S04 | native S04: cgroup `cpu.max`/`memory.max` equal the request; out-of-range refused; Podman cgroups untouched | pass — real systemd |
| V3-S05 | native S05: InvocationID/boot change → old identity not reused; runtime limits not replayed after restart | pass — real systemd |
| V3-S06 | v03-system S06: compensation conflicts when the current value differs; never claims to undo process effects | pass — real systemd |
| V3-N01/N03 | native N01/N03: only the lab namespace changes; host routes/DNS/SSH/global firewall unchanged; local-allow/local-deny proven with real TCP probes | pass — real netns/nftables |
| V3-N02 | native N02: raw nft, arbitrary tables/ranges refused; profile hashes from the install directory | pass |
| V3-N04 | native N04 + broker-recovery R05 (network): rule hash and probe reconciliation, no global flush or shell fallback | pass |
| V3-N05 | native N05: recreated namespace → new generation, old ifindex/generation cannot control it | pass |
| V3-D01/D05 | native D01/D05: PTY reconnect gives a new connection generation; old grants stop working; quarantine/re-grant | pass — **software PTY** |
| V3-D02 | native D02: unregistered device, raw frames, ioctl, out-of-range parameters refused | pass — software PTY |
| V3-D03 | native D03: request id, response, deadline and byte limits checked | pass — software PTY |
| V3-D04 | native D04: status never opens the port; lost response → unknown, quarantined, not resent | pass — software PTY |
| V3-D06 | native D04/D06: operator resolution keeps the original unknown fact (`operatorDecision`, `releaseQuarantine`); a new try is a new plan | pass — software PTY |
| V3-R01 | broker-recovery R01: same id/hash finds the same operation; different body refused | pass — real native |
| V3-R02/R03/R06 | host-crash: host SIGKILL at `system.after_outbox_commit`, `before_submit`, `after_submit_before_record`, `after_result_projection` → one broker operation with the original identity | pass — real native |
| V3-R03/R06 | broker-recovery R03/R06: broker killed after accepting / after committing the result | pass — real native |
| V3-R04 | broker-recovery R04: kill after the execution fence → reconciled by evidence | pass — real native |
| V3-R05 | broker-recovery R05: kill after the external effect for file, service, network and serial, each by its replay class | pass — real native |
| V3-R07 | broker-recovery R07: cancel tombstone blocks a late outbox | pass |
| V3-R08 | broker-recovery R08: cancel after admission → verified or unknown, never cancelled_no_effect | pass |
| V3-R09 | broker-recovery R09: old worker fenced before restart; quarantine/locks survive restarts and TTL | pass |
| V3-R10 | v03-system R10/U03/U04: an unknown serial result blocks a version switch and stays visible | pass |
| V3-R11 | broker-recovery R11: missing/corrupt log disables writes, no empty-log replay, diagnostics answer | pass |
| V3-R12 | broker-recovery R12: reconciliation budget → unknown, no endless retry | pass |
| V3-T01–T05 | `tests/telemetry/telemetry.test.ts` + `guest-telemetry.py` in the acceptance guest; evidence `docs/evidence/v0.3-telemetry-guest.json`: object loads (BTF), 4 exec/exit events of the registered workload, nothing from unregistered processes and no argv/env/content, 1514 kernel ring drops → `kernel_ring_drop` gap + re-read, cgroup reuse not mapped onto the new workload, detach → unavailable + `probe_lost` gap | pass — **real eBPF (guest)** |
| V3-T05/T06 (dev box) | telemetry.test.ts host case: collector unavailable (no BTF) reported separately; broker writes and app grants unaffected; events trigger no actions | pass — host has no BTF: eBPF itself is **not** claimed on this kernel |
| V3-A01 | v03-system A01/A02: real Pi + host tools, build vs system_plan tools mode-gated | pass — faux model |
| V3-A02 | v03-system A01/A02: prepared_action_id ≠ publication; the plan outlives the run and runs on a one-time action grant | pass — faux model |
| V3-A03/A04 | v03-system A03/A04: one plan per run, frozen body, budgets; resources not chosen cannot be read or planned | pass — faux model |
| V3-A05 | v03-system A05: identical replay finds the original plan, a different one is refused; cancelling a run leaves other actions | pass — faux model |
| V3-A06 | v03-system A06: no file content / device payload in model context or run records | pass — faux model |
| V3-U01 | v03-system U01 + e2e: the preview target/params come from the provider (`演示服务（agentos-demo.service）`), not app text | pass — real browser |
| V3-U02 | v03-system U02: standing grant inside bounds runs without dialog; outside bounds needs confirmation | pass |
| V3-U03/U04 | e2e `tests/e2e/v03-system.spec.ts`: 结果待确认 without a retry button, handled in the operation center; v03-system R10/U03/U04 | pass — real browser, software PTY |
| V3-U05 | v03-system U05 + e2e: expired plans, revoking, observation quality shown as such | pass |
| V3-O01 | `tests/recovery/v03-upgrade.test.ts`: copy of the box's live v0.2 workspace (service stopped for the copy) opened by v0.3: apps, revisions, records, epochs, service grants identical; old apps get no bindings; old code app answers | pass |
| V3-O02 | `tests/broker-recovery/zz-restore.test.ts` O02: quiesce, results synced, checkpoint/audit in the backup, broker resumes; broker.sqlite never in a workspace backup | pass — real native |
| V3-O03 | zz-restore O03: restored ready request fenced — one broker operation only; re-confirm does nothing; app grants void | pass |
| V3-O04 | zz-restore O04: restore killed at `restore.after_first_replace` keeps writes closed; rerun completes with exactly one incarnation step | pass |
| V3-O05 | zz-restore O05: effects after the backup happen once and stay visible after restoring the older workspace | pass |
| V3-O06 | zz-restore O06: `agentos-system-admin reinstall-log` → new machineInstallId; host refuses writes (identity mismatch); old plan cannot be confirmed; `agentos-admin rebind-broker --confirm-new-install` voids it (never executed) and new plans work | pass — real native |
| V3-O07 | v03-system O07 (≤4 waiting plans per app, refusal deletes nothing) + limits enforced in code (plan 256 KiB, provider reads 4/750 ms, observation/event caps) with unit coverage | pass |
| V3-O08 | `agentos-clean3`, README steps (`docs/evidence/v0.3-clean-install.log`): user host service, root broker/workers with their own users and permissions, protocol 1, `/api/state` ready + brokerReady, telemetry unavailable (no BTF) shown separately, 6 resources | pass (that run listed the telemetry *resource* as `available` while the collector was unavailable; fixed afterwards: `/api/system-resources` now takes telemetry status from the collector, checked in the final suites) |
| V3-E01 | `pnpm smoke:v0.3-real` run 4 (`docs/evidence/v0.3-smoke-real.json`): see below | pass — real model |
| V3-E02 | same run | pass — real model |
| V3-E03 | same run | pass — real model |
| V3-E04 | **not run: no serial hardware exists on any test machine.** All serial results above are from the software PTY sample and are labeled as such. | **not accepted** |

## Real model (V3-E01–E03)

Provider `openai-compatible` (TokenRhythm), model `qwen3.8-flash`, `AGENTOS_MODEL_REASONING_EFFORT=low`. The key never reached
the box: the host called a key-less relay on the box (`scripts/model-relay-box.mjs`), a forwarder in the development sandbox
added the key. Relay, public port and relay token were removed after the run.

| Run | Time (CST) | Result |
|---|---|---|
| 1 | 00:04–00:13 | E01 failed: the model spent its whole 16384-token output on reasoning (`stopReason: length`) after one relay timeout. Fix: `AGENTOS_MODEL_REASONING_EFFORT` (sent as OpenAI `reasoning_effort`); relay timeout raised. |
| 2 | 00:40–00:58 | E01 published a v3 app; file write and CPU limit verified, but its query never showed the connected state (it guessed field names and `quality`). E02 failed: the model sent `params` as a JSON string three times. Fixes: the prompt lists each read capability's visible fields, the `quality` values and path rules; `system_read`/`system_plan` decode JSON-string params; malformed JSON strings are answered with the parse position. |
| 3 | 01:10–01:28 | E01 query showed the service but `file.list` used path `"."` (refused) and a report plan cited a service observation (refused as "another resource"). Fixes: prompt states the root is `""`; plans may cite same-call observations of other bound resources as context (generation-checked). Two relay restarts lost requests in this period (relay bug: a poller dropped by the proxy could swallow a request) — fixed in the relay. |
| 4 | 01:30–01:34 | **all pass** (below) |

Run 4:

| Step | Requests | Tools | Checked |
|---|---|---|---|
| E01 workbench | 6 (1 stage diagnosed) | app_get, runtime_catalog, service_catalog, app_stage ×2, app_validate, app_prepare, app_activate | formatVersion 3, `isolated-code-v2`, health ready; before connecting: "尚未连接 Linux 资源"; after the user connected `service` and `root`: activeState `active`, CPU 30%, 74 files; report plan (preview: 替换 status-report.txt, sha256 from→to) confirmed → done, evidence `target_hash`; CPU plan (30% → 50%) confirmed → done, evidence `unit_property`, cgroup `cpu.max` = `50000 100000` |
| E02 system plan | 2 | system_resource_list, system_read, system_plan | plan "将「演示服务」的CPU 上限设为 40%"; nothing changed before confirmation; after confirmation done/verified, `cpu.max` = `40000 100000` |
| E03 model offline | 0 | — | host restarted with no model: app ready, query 200, app system action confirmed → done, `cpu.max` = `60000 100000`; revoke 202 → the app shows "演示服务未连接"; operation center lists 4 operations |

Usage (Pi session totals): after E01 input 20,424 / output 15,239 (reasoning 8,578) / cache read 82,944; after E02 22,765 /
16,056 / 129,792. Cost reported 0.

## External review of main@79377eb (user, 2026-10-28)

| # | Finding | Verdict | Fix | Test |
|---|---|---|---|---|
| 1 | deployment expiry marked failed then thrown inside the savepoint (rolled back) | confirmed (agent `app_activate` path) | `DeploymentService.expireIfDue()` commits the expiry in its own transaction before/after activation | `tests/sandbox/v03-regressions.test.ts` |
| 2 | a failed cancel permanently suppressed retries | confirmed | abort marker cleared after 1–30 s backoff; next pass retries | `tests/integration/review-regressions.test.ts` |
| 3 | delete+create at the record limit rejected | confirmed | limit checked on the final count of the whole plan | review-regressions (delete+create at 1000 ok; delete+2 creates refused) |
| 4 | App async detail/revisions requests race | confirmed | request sequence + current-selection guard; stale detail cleared on switch | e2e v03-system step 8 (slow response for the previous app never replaces the current one) |
| 5 | `item` binding declared but not resolved | partly: the schema type allows it but `checkSlotTree` always refused it, so no bundle could carry one | kept frozen (v1/v2 schemas are frozen), documented as reserved | review-regressions |

## §25 exit conditions

| Milestone | Status |
|---|---|
| M0 | v0.2 regressions pass; `pnpm native:doctor` lists each capability; D-Bus/file interfaces used on the real box; BPF object loaded on the acceptance guest kernel (the box kernel has no BTF/tracepoints — recorded, not simulated) |
| M1 | C01–C07 |
| M2 | R01–R12, G05, G06 |
| M3 | F01–F07, S01–S06, E01 |
| M4 | N01–N05, D01–D06 (software PTY only; hardware = E04 not accepted) |
| M5 | T01–T06 (real eBPF in the guest; host unavailable path) |
| M6 | U01–U05, A01–A06, E01–E03 |
| M7 | O01–O08 |

## §27 delivery checklist

| Item | Status |
|---|---|
| v0.2 workspace copy migration and full old regression | O01; unit/recovery/sandbox/e2e old suites in the final run |
| v3 bundle, SDK ABI 2, Slot Tree v2 beside the old runner; old hashes/locks kept | C01, C02, C07 |
| file/service/network/serial/telemetry in one contract with resource identity | `packages/contracts/src/v3`, docs/contracts, native tests |
| fixed native build; strict DTO and canonicalization identical in Rust/TS | rust-toolchain.toml, Cargo.lock `--locked`, C04 vectors |
| broker connection identity and root caps verified independently; generated code never on the privileged path | G01, G02, C05 |
| grant sync, revocation, execution fence, cancel tombstone, resource locks durable across processes | G04–G06, R07–R09 |
| replay classes, evidence, unknown results, conditional compensation tested | R04, R05, F07, S06, D04, D06 |
| exclusive writer, service scope, network namespace, device identity on real system facts | F04, S01, N01, D01 |
| eBPF filtering, drop counts, generations and re-reads; never a fact or permission | T01–T06 |
| build/system_plan permissions, budgets, completion; real-model main path | A01–A06, E01–E03 |
| coordinated cold backup, restore incarnation, broker history kept, no old outbox replay | O02–O06 |
| M0–M7 and the 80 items; missing hardware/kernel capability not simulated | this report; E04 not accepted; host eBPF not claimed |
| install, run, incident handling and scope reproducible from clean Linux | README v0.3 section, O08 |

## Known limits

- The BPF object is built with `-g`; its debug info embeds the checkout path, so the clean box (different path) built
  `67c032a0…c25a` instead of `03a2234a…a8`. The accepted object is the latter (dev box install and guest). Path-independent
  BPF builds are not done in v0.3.

- No serial hardware: V3-E04 is not accepted; the PTY sample is a software protocol test.
- The development and clean boxes have no BTF/tracepoints; telemetry there is reported unavailable. Real eBPF was accepted in
  the QEMU guest (kernel 6.12.113).
- The real model needed `reasoning_effort=low`; without it this model can spend its whole output budget reasoning.

## Commit

Implementation, tests and evidence: `7b31947`. All final suites above ran on that tree on the development box (the box checkout
was synced from it before the last pass). The clean box ran the README install on the same work before the last small fixes
(telemetry resource status, timer shutdown, test-only changes). This report was finalized in the next commit.
