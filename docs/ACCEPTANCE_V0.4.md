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

## External review of d41d3b0 (2026-10-29) and fixes

An external review of the pushed `d41d3b0` against this spec reproduced 6 logic defects and 1 delivery defect, with 6
spec assertions that failed on `d41d3b0`. A parallel branch (`cursor/v04-review-fixes-899e`, `bd5ce54`) fixed 6 further
issues and was merged first. All are fixed on `main`; the new regression tests fail on `d41d3b0` (checked by running them
against the old core: 6/6 failed) and pass now.

| # | Finding | Fix | Test |
|---|---|---|---|
| F1 (P1) | pausing a policy with an enabled v1 and a newer draft v2 paused only v2 (`require(id)` = newest) | `pause` closes every version still able to admit (enabled, syncing, pending, needs review) and registers broker revocation for each synced version; `pauseTargetInTx` uses the same path | `F1 pausing a policy …` (maintenance) |
| F2 (P1) | the model-analysis branch ran before the observe branch: an observe policy started a background model run | observe ends before any model branch (§13.1); the model permit re-checks the job mode | `F2 an observe-only policy …` |
| F3 (P1) | background analysis took the app lease; a user change waited for it while foreground priority blocked the background model request | background runs no longer take the app change lease (they read a frozen snapshot); a background run does not start while a user task on the app runs or waits; admitting a user change closes a background optimisation of that app (`target_changed`); candidate writes refuse while a user task on the app is open | `F3 background analysis holds no app lease …` |
| F4 (P2) | `POST /api/conversations/:id/compactions` created the job before the gateway checked the client epoch: 409 with a job left behind | request split into read-only `prepare` (async Pi reads) and `createInTx` inside the gateway write (epoch, key, hash first, facts re-checked); cancel likewise ends the job inside the write and aborts Pi after it | HTTP test: stale epoch → 409 `CLIENT_EPOCH_STALE`, 0 jobs, then 202 + replay + placed |
| F5 (P2) | global pause did not cover queued compactions; they later got a model request | the compaction scheduler and its binding transaction refuse while paused; pause cancels open compactions whose request is not out; the permit refuses background requests while paused | `F5 a global pause …`, `F5/F6 the model permit …` |
| F6 (P1) | cancelling a diagnosing job left its queued run dispatchable | cancel closes the run's fence and model route in the same transaction; `finishAnalysis` ends a cancel-requested job as `cancelled`, keeping any report/proposal already saved; the permit refuses a cancelled job's run | `F6 cancelling an analysing job …` |
| F7 (P2) | `pnpm typecheck` failed with 36 diagnostics in tests/config | tests project: JSX + DOM lib + web's React types, the web source loaded dynamically (type-checked by its own project), explicit `CodeBundleV2` fixtures, envelope defaults before overrides, removed an unknown vitest option, a deliberately partial label typed as such; no test excluded | `pnpm typecheck` exit 0 |

Merged branch `bd5ce54`: a user stop during verification is no longer a failed recovery (no circuit open); cancelled
queued tasks no longer fill the 16-deep queue; background run and compaction share the single background slot; a passed
candidate check is not re-run, and a catalog change forces a new check; a compaction request on another route epoch is
refused; a job ending in `needs_attention` releases its lease while `indeterminate` stays fenced.

### Rerun on the fixed tree (`a539498` + test fixes, 2026-10-29 21:30–22:30 CST)

Full regression `/data/home/full3.sh` (native release build, install, build, `pnpm typecheck`, every suite, opt-in old-version
tests, real smoke):

| Command | Result |
|---|---|
| `cargo build --release`; `pnpm build`; `pnpm typecheck`; `tsc --noEmit` core/host/agent-pi/web | all exit 0 |
| unit / agents / maintenance / maintenance-recovery / gc-online / compaction | 80 / 24 / 33 / 4 / 7 / 6, all pass |
| `vitest --project recovery` (perf excluded) | 32/32 + 3 skipped (opt-in, rerun below) |
| `vitest --project sandbox` | 60/60 + 1 skipped (opt-in V2-B04, rerun below) |
| `vitest --project native` | 21/21 |
| `vitest --project broker-recovery` | first 31/32: V3-R08 cancelled while the broker was still observing the device (before the port opened), and the broker then correctly answered `cancelled_no_effect`/`not_dispatched`. The test only waited for `running`; it now waits until the device simulator has seen the request, which is the case R08 is about. Broker code unchanged. Rerun 3 × 12/12 (broker-kill) |
| `vitest --project telemetry` | first 1 + 5 skipped (the acceptance guest had hung, so T01–T05 skipped); guest rebooted, rerun 6/6 |
| `playwright test` | 8/8 |
| `cargo fmt --check`; Rust warnings | 0; 0 |
| opt-in: recovery v02-recovery + v03-upgrade with real v0.1 build and live v0.2 workspace copy; sandbox v02-ops offline | 15/15; 7/7 |
| V4-O05 perf (corrected test) | 8/8 on the fixed tree, ratio 0.967–1.206; see Performance (V4-O05) |

Real model on the fixed tree: run 14 failed at O01 (the code-app run used its 3 `app_stage` attempts on invalid bundles:
RPC schema strings without `maxLength`, then a bundle without `formatVersion`/`manifest`); run 15 passed every step
(`docs/evidence/v0.4-smoke-real.run15.json`, 21:48–21:52 CST): O01 parallel 152 s overlapped (reading list 5 requests;
番茄钟 code app 9 requests, one refused `app_stage` corrected inside the budget); O03 compaction `placed` (entry 92, cutoff 57,
one background attempt, 552 in / 575 out tokens); background optimisation `awaiting_approval` (target_app_get,
candidate_stage, candidate_check, proposal_submit); publication 202 → deployment `committed`, epoch 1 → 2; diagnosis job
`succeeded` (maintenance_context, incident_get, maintenance_report). Relay, port 4501 and relay token removed afterwards.

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

Final-tree reruns (`/data/home/aff.sh`, commit `d8de568`):

| Command | Result |
|---|---|
| `pnpm build` | exit 0 |
| `vitest --project unit` | 80/80 |
| `vitest --project agents` (adds the trailing-bracket decoding tests) | 23/23 |
| `vitest --project maintenance` (E08 extended: unlisted recommendedTemplate refused) | 21/21 |
| `vitest --project compaction` | 6/6 |
| `vitest --project sandbox tests/sandbox/v04-proposals.test.ts` (faux refactor now sends `files`; candidate differs from the base only in that file) | 3/3 |

Opt-in old-version tests rerun on the final tree with their real sources (`/data/home/optin.sh`):

| Command | Result |
|---|---|
| `AGENTOS_OFFLINE_TEST=1 AGENTOS_V01_ROOT=<real v0.1 build 7cd2bbe> AGENTOS_UPGRADE_SOURCE=<copy of the live v0.2 workspace> vitest --project recovery v02-recovery v03-upgrade` (V2-O01, V2-O03, V3-O01 included) | 15/15 (V3-O01 first failed only on its stale `hostVersion` expectation `0.3.0`; updated to the current host) |
| `AGENTOS_OFFLINE_TEST=1 vitest --project sandbox tests/sandbox/v02-ops.test.ts` (V2-B04 offline included) | 7/7 |
| `vitest --project agents` after the report-schema change | 24/24 |

## Real model (V4-O01, V4-O03)

`pnpm smoke:v0.4-real` (`scripts/smoke-v04-real.mjs`) on the dev box against a fresh workspace. Provider
`openai-compatible` (TokenRhythm), model `qwen3.8-flash`, `AGENTOS_MODEL_REASONING_EFFORT=low`,
`AGENTOS_COMPACTION_KEEP_RECENT_TOKENS` default 2000. The key never reached the box: the host called the key-less relay
`scripts/model-relay-box.mjs` on the box, and a forwarder in the development sandbox added the key. Each run starts a new
host with a new data directory under `/data/home/smoke-v04`; every report is kept (`test-results/smoke-v04-real.runN.json`).

| Run | Result | Cause / change |
|---|---|---|
| 1–4 | failed | mostly at O01: the code app's `app_stage` bundle arrived as a JSON string with broken closing brackets; one run reached optimisation and had no checked candidate. O03 compaction was already placed in one of these runs (`entryId 90`, cutoff 61) |
| 5 | parallel, code app, compaction, optimisation pass; publication check failed | smoke script bug: accept is queued (202) and the script read the app before the `proposal_accept` deployment ended → script now waits for the deployment's terminal state |
| 6 | failed at optimisation | four `candidate_stage` calls failed on stringified-bundle brackets (two inside Pi's argument parser) → `candidate_stage` accepts `files` (replaced code files; complete bundle rebuilt from the frozen target and validated as before); trailing-only bracket repair |
| 7 | failed at optimisation | candidate staged, validated and checked (`passed`), but the refactor budget of 6 model requests ran out before `proposal_submit` → `candidate_check` waits for the result in the tool (V4-S09), prompt says staging already validates |
| 8 | failed (infrastructure) | the sandbox forwarder process died; no model requests reached the provider |
| 9, 10 | failed at O01 parallel | code-app run of the "看板" intent failed within its 3 stage attempts (bracket error, then RPC schema strings without `maxLength`); the other app succeeded both times |
| 11 | **all steps pass** | code intent set via `SMOKE_CODE_INTENT` to an explicit code app (番茄钟记录) |
| 12 | parallel, code app, compaction, optimisation, publication pass; diagnosis failed | the analyst prompt asked for an `explanation` field and `hypotheses[].summary` that the report service does not accept; the refused call used the one report attempt → prompt now states the exact report fields, and the tool's argument schema is closed so Pi refuses a malformed report before the host counts it |
| 13 | **all steps pass** | final code tree (`4783155`; the later commit only changes a test expectation) |

Run 13 — final tree (`docs/evidence/v0.4-smoke-real.run13.json`, 2026-10-29 17:45–17:49 CST, same intents as run 11):

| Step | Evidence |
|---|---|
| O01 two foreground apps in parallel | both `succeeded` in separate conversations (9, 18), runs overlapped, 98 s. Reading list: 5 requests, 879 output tokens, no tool error. 番茄钟 code app (formatVersion 2): 9 requests, 6183 output tokens; one `app_stage` refusal and one failed Prepare were corrected by new revisions inside the stage budget, then app_activate |
| O03 compaction | conversation 9: `placed`, summary entry 92, source cutoff 57, scope = that conversation and run, providerContentConsent false, crossConversation false; one background attempt, input 554 / output 741 (reasoning 269) tokens, route `2b3198ed…` |
| O01 background optimisation | maintenance_refactor run, 4 requests: target_app_get, candidate_stage (`files`), candidate_check, proposal_submit; job `awaiting_approval`; proposal check: baseline `6b2d84b2…`, candidate `94735faf…`, `preview-fixtures-v1`, container timing p50 0.113 → 0.052 ms on the fixture |
| O01 user publication | exact hash + expectedAppEpoch 1 → 202; `proposal_accept` deployment `committed`; epoch 1 → 2; active revision `421baf6d…` → `43114602…` |
| O01 background diagnosis | real crash loop (memory limit) → incident → `app-diagnose` `succeeded`; maintenance_diagnose run, 2 requests: incident_get, maintenance_context, maintenance_report; 4 hypotheses (high/medium/low/low), evidence refs only from the job's frozen ids, recommendedTemplate `app-recovery` (a listed template) |

Run 11 (`docs/evidence/v0.4-smoke-real.run11.json`, 2026-10-29 17:28–17:31 CST):

| Step | Evidence |
|---|---|
| O01 two foreground apps in parallel | reading-list app (declarative) and 番茄钟 code app (formatVersion 2) submitted together; both `succeeded`, conversations 9 and 18, runs overlapped (`started_at`/`updated_at` intersect), 38 s total. Tools: app_get, app_stage (1 schema refusal, fixed), app_validate, app_prepare, app_activate; code app also runtime_catalog. Foreground attempts 6 and 5, output tokens 1716 and 2119 |
| O03 compaction | conversation 9 compacted in the background: state `placed` (摘要已生成并放置（原始记录保留）), summary entry 80, source cutoff 71, scope bound to that conversation/run, providerContentConsent false, no cross-conversation input; one background attempt, input 969 / output 706 (reasoning 83) tokens, route `76ff0f61…` |
| O01 background optimisation | `app-optimize` job → maintenance_refactor run (background, 4 model requests): target_app_get, candidate_stage (`files`), candidate_check, proposal_submit; job `awaiting_approval`. Proposal pins baseline hash `b5279a04…1c63`, candidate hash `3b24eb5c…135c`, fixture set `preview-fixtures-v1`, real container timings (baseline p50 0.158 ms, candidate 0.050 ms; fixture-only claim) |
| O01 user publication | accept with exact proposalHash + expectedAppEpoch 1 → 202; deployment `proposal_accept` → `committed`; app epoch 1 → 2, active revision `62b6486c…` → `4f4c36c1…` (the candidate) |
| O01 background diagnosis | real crash loop of the code app (memory limit) → incident → `app-diagnose` job `succeeded`; maintenance_diagnose run (2 requests): maintenance_context, incident_get, maintenance_report. Report lists 3 hypotheses with confidence, evidence refs only from the job's frozen ids, missing evidence; labeled "diagnosis (hypothesis, not a repair)" |

Finding from run 11: the report carried `recommendedTemplate: "memory_resource_exhaustion"`, which is not a maintenance
template — the prompt had said "one of the listed templates" without listing them, and the service stored any string.
Fixed: the prompt lists the 8 template ids and the service refuses any other value (V4-E08 test extended).

## Performance (V4-O05)

**Pass (re-audited 2026-10-29).** The earlier result for `d41d3b0` (ratio 1.105, `docs/evidence/perf-v04-o05.json`) came
from a test that was found defective while re-checking the review fixes; it is replaced by the result below.

Defects of the old test (A B A B A B, 200 ops per round, create + query):

1. The background loop refilled only when no job was open, and log-cleanup ends `awaiting_approval` (open), so only the
   first batch of 3 jobs ever ran; later "background" rounds were mostly idle.
2. Jobs started in a B round kept running into the following A round, so baselines were not free of background work.
3. The first round of each side ran slower (warm-up), and at 200 samples the p95 of a ~1 ms request moved by ±0.2 ms
   between identical runs: the fixed tree gave 0.93–1.33 over 13 runs (2 above 1.25), the pre-fix tree 0.94–1.24 over 6.

A CPU profile of the host during a run showed the maintenance/compaction code itself too small to appear among the top entries (host busy ~3.7 s of 8.4 s, almost all in HTTP handlers);
the time is the foreground requests, SQLite reads and GC, i.e. the spread was measurement noise, not background load.

Corrected test (`tests/recovery/v04-perf.test.ts`; threshold 1.25 unchanged): two warm-up rounds discarded; 12 rounds of
300 operations (create / query / delete / query, so the app stays under its 1000-record limit) in ABBA order; every
baseline round starts only after open jobs and compactions have ended; background rounds keep submitting batches
(awaiting-approval checks are cancelled) and one conversation compaction (faux); the test asserts more than one batch.

| tree | runs (interleaved) | ratio | above 1.25 | background jobs per run |
|---|---|---|---|---|
| fixed (`a539498` + test fixes) | 8 | 0.967–1.206 | 0 | 18–24 |
| pre-fix `39df919` | 4 | 0.957–1.169 | 0 | 18–21 |

Raw samples of the fixed-tree run with the highest ratio (baseline p95 0.893 ms, with background p95 1.077 ms, ratio
1.206, 21 jobs, 1800 samples a side): `docs/evidence/perf-v04-o05.fix.json`.

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

| ID | Scenario | Evidence | Ran on | Status |
|---|---|---|---|---|
| V4-B01 | 旧格式与日常运行 | box 全量回归 2026-10-29：unit 79、recovery 31（v0.1/v0.2/v0.3 旧用例按 v0.4 排队语义更新后复跑全过）、sandbox 59、native 21、broker-recovery 32、e2e 8（v0.1/v0.2/v0.3/v0.4 规格）、telemetry 6 | real native, real browser | pass |
| V4-B02 | 真实 v0.3 升级 | tests/recovery/v04-upgrade.test.ts：真实 v0.3 构建（git 7b31947）经 scripts/make-v03-workspace.mjs 生成的工作区 → v0.4：应用/版本/记录/run/部署/操作不变，新任务成功，代码应用运行时 ready、查询 200（box） | real process | pass |
| V4-B03 | Pi 多会话能力 | packages/agent-pi/test/m0-pi-prototype.test.ts（固定 Pi 1.4.0：两会话别名路由并发、按会话 abort、原子压缩登记、重启重建路由） | in-process | pass |
| V4-B04 | 会话创建原子性 | v4-agents.test.ts | faux model | pass |
| V4-B05 | 会话与任务绑定 | v4-agents.test.ts | faux model | pass |
| V4-B06 | 旧 root 与配对 | v4-agents.test.ts | faux model | pass |
| V4-B07 | 数据迁移约束 | tests/integration/v04-migration.test.ts（v0.3 库→v0.4：单槽位索引移除、target 可空、CHECK 扩展、行/触发器保留；未结束 run 拒绝升级） | in-process | pass |
| V4-B08 | Broker 协议兼容 | tests/broker-recovery/maintenance-v2.test.ts（真实 broker：v=1 拒绝协议 2 方法、v1 envelope 不能带维护字段）；host-maintenance.test.ts（真实宿主+broker，两处 SIGKILL 点） | real native | pass |
| V4-S01 | 双前台真实重叠 | v4-agents.test.ts | faux model | pass |
| V4-S02 | 同应用竞争 | v4-agents.test.ts | faux model | pass |
| V4-S03 | 排队与超限 | v4-agents.test.ts | faux model | pass |
| V4-S04 | 取消隔离 | v4-agents.test.ts | faux model | pass |
| V4-S05 | 完成判据 | v4-agents.test.ts | faux model | pass |
| V4-S06 | 前台优先 | tests/compaction/v4-compaction.test.ts（前台排队时后台摘要请求等待；判据在 core 统一） | faux model | pass |
| V4-S07 | 构建资源队列 | v4-agents.test.ts | faux model | pass |
| V4-S08 | 模型总并发 | tests/compaction/v4-compaction.test.ts（生成+摘要并发 ≤2） | faux model | pass |
| V4-S09 | 等待行为 | v4-agents.test.ts | faux model | pass |
| V4-S10 | 局部与全局故障 | v4-agents.test.ts | faux model | pass |
| V4-P01 | 工具身份攻击 | v4-agents.test.ts | faux model | pass |
| V4-P02 | 角色越权 | packages/agent-pi/test/v4-roles.test.ts（各角色工具集精确；维护角色无 grant/exec/spawn/激活/数据入口；compaction 无工具） | faux model | pass |
| V4-P03 | 模型预算归属 | v4-agents.test.ts | faux model | pass |
| V4-P04 | 预算持久性 | v4-agents.test.ts | faux model | pass |
| V4-P05 | 用户批准范围 | v4-maintenance.test.ts | in-process | pass |
| V4-P06 | 根侧上限 | maintenance-v2.test.ts（超出安装上限/未登记资源/超一年均拒绝）；host-maintenance.test.ts（真实宿主+broker，两处 SIGKILL 点） | real native | pass |
| V4-P07 | 旧执行代次 | maintenance-v2.test.ts（暂停、旧 epoch、撤销、过期、墓碑）；host-maintenance.test.ts（真实宿主+broker，两处 SIGKILL 点） | real native | pass |
| V4-P08 | 主体区分 | maintenance-v2.test.ts（policy 不能当 grant，grant 不能当 policy）；host-maintenance.test.ts（真实宿主+broker，两处 SIGKILL 点） | real native | pass |
| V4-J01 | 调度事务 | v4-maintenance-recovery.test.ts, v4-maintenance.test.ts | real process | pass |
| V4-J02 | 离线漏触发 | v4-maintenance.test.ts | in-process | pass |
| V4-J03 | 时钟与睡眠 | v4-maintenance.test.ts | in-process | pass |
| V4-J04 | 事件风暴 | v4-maintenance.test.ts | in-process | pass |
| V4-J05 | 取消与派发竞争 | v4-maintenance.test.ts | in-process | pass |
| V4-J06 | 策略变更 | v4-maintenance.test.ts | in-process | pass |
| V4-J07 | 步骤恢复 | v4-maintenance-recovery.test.ts, v4-maintenance.test.ts | real process | pass |
| V4-J08 | 全局暂停 | maintenance-v2.test.ts, v4-maintenance.test.ts | real native | pass |
| V4-H01 | 唯一运行控制器 | v4-maintenance-recovery.test.ts, v4-maintenance.test.ts | real process | pass |
| V4-H02 | 用户停止优先 | maintenance-v2.test.ts（更新的 target control epoch 拒绝排队中的维护请求）；host-maintenance.test.ts（真实宿主+broker，两处 SIGKILL 点） | real native | pass |
| V4-H03 | 实例身份 | v4-maintenance.test.ts | in-process | pass |
| V4-H04 | 恢复健康证据 | tests/maintenance/v4-maintenance.test.ts（短暂拉起再退出不算恢复；需握手、重启后探测与完整观察窗） | in-process | pass |
| V4-H05 | crash-loop 熔断 | v4-maintenance.test.ts | in-process | pass |
| V4-H06 | 服务真实恢复 | maintenance-v2.test.ts（真实 systemd 停止后 ensure-running 拉起 agentos-demo）；host-maintenance.test.ts（真实宿主+broker，两处 SIGKILL 点） | real native | pass |
| V4-H07 | 根侧次数与冷却 | maintenance-v2.test.ts（准入即预留、新 jobId/新版本不重置、冷却、after_accept 崩溃只计一次）；host-maintenance.test.ts（真实宿主+broker，两处 SIGKILL 点） | real native | pass |
| V4-H08 | 未知与遥测降级 | tests/maintenance/v4-maintenance.test.ts（gap/探测失败/身份变化不当作停止；不清除 quarantine） | in-process | pass |
| V4-G01 | 活跃引用保护 | v4-gc-online.test.ts | in-process | pass |
| V4-G02 | 标记/新引用竞争 | v4-gc-online.test.ts | in-process | pass |
| V4-G03 | Staging 身份 | v4-gc-online.test.ts | in-process | pass |
| V4-G04 | 删除中断 | v4-gc-online.test.ts | in-process | pass |
| V4-G05 | 文件范围 | v4-gc-online.test.ts | in-process | pass |
| V4-G06 | 批次与真实空间 | v4-gc-online.test.ts | in-process | pass |
| V4-G07 | 日志轮转 | v4-gc-online.test.ts | in-process | pass |
| V4-G08 | 不可删事实 | v4-gc-online.test.ts | in-process | pass |
| V4-E01 | 候选能力边界 | v4-maintenance.test.ts | in-process | pass |
| V4-E02 | 候选验证 | tests/sandbox/v04-proposals.test.ts（box 真容器：检查通过、基线/候选 hash 与 fixture 固定） | real Podman | pass |
| V4-E03 | 前台改变基线 | tests/sandbox/v04-proposals.test.ts（前台新版本使候选 stale，接受返回 409） | real Podman | pass |
| V4-E04 | 用户接受候选 | tests/sandbox/v04-proposals.test.ts（错 hash/epoch 409 且标记 stale；正确对经 proposal_accept 正式部署；重放不重复） | real Podman | pass |
| V4-E05 | 发布回执丢失 | tests/sandbox/v04-proposals.test.ts（proposal.after_publish_projection SIGKILL 后重启补齐，单次激活） | real Podman | pass |
| V4-E06 | 归档竞争 | v4-maintenance.test.ts | in-process | pass |
| V4-E07 | 恢复归档 | v4-maintenance.test.ts | in-process | pass |
| V4-E08 | 建议不越界 | tests/maintenance/v4-maintenance.test.ts（报告建议只为文本，不触发优化/安装/合并/发布；重复与夹带字段被拒） | in-process | pass |
| V4-C01 | 压缩输入范围 | v03-system.test.ts, v4-compaction.test.ts, v4-maintenance.test.ts | faux model | pass |
| V4-C02 | 压缩预算与路由 | v4-compaction.test.ts | faux model | pass |
| V4-C03 | 压缩创建恢复 | v4-compaction.test.ts | faux model | pass |
| V4-C04 | 摘要 stale | v4-compaction.test.ts | faux model | pass |
| V4-C05 | 压缩并发与取消 | v4-compaction.test.ts | faux model | pass |
| V4-C06 | 原始事实保留 | v4-compaction.test.ts | faux model | pass |
| V4-U01 | 多任务界面 | tests/e2e/v04-centers.spec.ts（box 真浏览器：两槽、排队第 1 位、独立取消、维护暂停本地/执行端分开） | real browser | pass |
| V4-U02 | 策略确认 | tests/e2e/v04-centers.spec.ts（待批准卡片显示真实目标/自动动作/频率/额度/期限，批准走精确 hash） | real browser | pass |
| V4-U03 | 结果真实性 | tests/e2e/v04-centers.spec.ts（202 显示为排队/运行，不显示成功） | real browser | pass |
| V4-U04 | 通知合并 | v4-maintenance.test.ts | in-process | pass |
| V4-U05 | 模型离线 | tests/recovery/v04-offline.test.ts（无模型：应用、确定性维护、暂停/恢复、策略暂停、查询可用） | real process | pass |
| V4-U06 | 数据与提示注入 | tests/maintenance/v4-maintenance.test.ts（证据脱敏、不含记录/其他任务、注入文本只作数据） | in-process | pass |
| V4-R01 | 接受/会话/提交断点 | v4-maintenance-recovery.test.ts | real process | pass |
| V4-R02 | 取消/终结断点 | v4-maintenance-recovery.test.ts | real process | pass |
| V4-R03 | 效果后执行日志前中断 | v4-maintenance-recovery.test.ts | real process | pass |
| V4-R04 | 日志后业务投影前中断 | v4-maintenance-recovery.test.ts | real process | pass |
| V4-R05 | worker 与锁恢复 | tests/maintenance/v4-maintenance.test.ts（过期租约仅在所有者确认停止后回收并升 epoch；unknown 不按时间释放） | in-process | pass |
| V4-R06 | 多会话冷备份 | tests/recovery/v04-restore.test.ts（box：备份 manifest v04 事实） | real process | pass |
| V4-R07 | 旧计划恢复 | tests/recovery/v04-restore.test.ts（新 scheduler/maintenance epoch，策略 paused_needs_review，旧作业/outbox 不执行） | real process | pass |
| V4-R08 | 外部历史保留 | tests/recovery/v04-restore.test.ts（备份后的事实不回灌；历史 transcript 可查）；broker schema 3 按 incarnation 保留 | real process | pass |
| V4-R09 | 恢复后的缓存状态 | tests/recovery/v04-restore.test.ts（无 deleting/marked 残留） | real process | pass |
| V4-R10 | 不完整/损坏恢复 | tests/recovery/v04-restore.test.ts（两库不配对：业务可读、agent 写关闭、两库均未被清空） | real process | pass |
| V4-O01 | 真实模型主线 | `pnpm smoke:v0.4-real` run 13（docs/evidence/v0.4-smoke-real.run13.json，qwen3.8-flash，reasoning low，最终代码树）：两前台应用真实并行（会话 9/18 重叠）、后台优化候选（files）→ 平台检查 → 用户精确 hash/epoch 接受 → proposal_accept committed、真实崩溃循环 → 后台诊断报告；run 11 同样全过；失败的 run 1–10、12 及原因全部记录在 ACCEPTANCE_V0.4.md | real model | pass |
| V4-O02 | 真维护且模型断网 | tests/sandbox/v04-offline-real.test.ts（box 真 podman，模型未配置）：容器反复被杀至 degraded → 自动 app-recovery 作业 succeeded（generation 2→5），在线 cache-gc no_change，无模型请求，记录不变 | real Podman | pass |
| V4-O03 | 真实模型压缩 | 同一 smoke run 13：会话 9 摘要真实生成并放置（entry 92，cutoff 57，原始记录保留），后台 1 次请求，用量与 route 记录；run 11 entry 80 / cutoff 71 | real model | pass |
| V4-O04 | 干净安装与升级 | 新机 agentos-clean4（Debian 13，空机）按 README 安装通过：runtime:doctor 全 ok、broker protocol 1/2、testMode=false、agents/maintenance doctor 全 ✓；agentos-clean3（v0.3 安装）按 README 升级：记录哈希不变、schema 3→4、doctors 通过，暴露并修复空 managed 目录备份失败，修复后备份+恢复（incarnation 2）通过；native:build 在 dev box 与 clean4 六个产物 sha256 完全一致 | real native, clean box | pass |
| V4-O05 | 前台性能 | 修正后的测试（ABBA 12 轮×300 次 CRUD/查询，基线前等后台排空，后台批次重复）：修复树 8 次比值 0.967–1.206 全部 ≤1.25；原始数据 docs/evidence/perf-v04-o05.fix.json | real process | pass |
| V4-O06 | 压力与空间 | tests/maintenance/v4-maintenance.test.ts（作业队列 64 上限拒绝新工作不丢旧事实；低于安全落账空间 64 MiB 不启动新效果、作业带原因等待、receipt/作业不删除，空间恢复后继续；诊断证据 ≤64 KiB）+ 既有 queue/compaction/proposal 上限测试 | faux model | pass |
| V4-O07 | 关键 API 门槛 | packages/agent-pi/test/m0-pi-prototype.test.ts（固定 Pi 1.4.0 实测：两会话路由并发、按会话 abort、原子会话目录、原子压缩登记、重启重建），无替代路径 | in-process | pass |
| V4-O08 | 证据与遗留项 | ACCEPTANCE_V0.4.md「Scope and what is not claimed」：自动/建议范围、V3-E04 未验收（无串口硬件）、PTY 与 guest eBPF 分列、单一模型、无“全机零维护”结论 | report (separates static, faux, software PTY, guest eBPF, real native, real model) | pass |

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
| M8 | real-model mainline (O01/O03 run 13; fixed tree run 15), native recovery (broker-recovery, host-maintenance), online pressure/UI/offline (O02, O05, O06, e2e), reproducible native build, clean install/upgrade (O04, B02), this 88-item report; V3-E04 still not accepted (no serial hardware) |

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

