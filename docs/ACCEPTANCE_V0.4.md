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
| V4-O01 | 真实模型主线 |  | in-process | **open** |
| V4-O02 | 真维护且模型断网 | tests/sandbox/v04-offline-real.test.ts（box 真 podman，模型未配置）：容器反复被杀至 degraded → 自动 app-recovery 作业 succeeded（generation 2→5），在线 cache-gc no_change，无模型请求，记录不变 | real Podman | pass |
| V4-O03 | 真实模型压缩 |  | in-process | **open** |
| V4-O04 | 干净安装与升级 | 新机 agentos-clean4（Debian 13，空机）按 README 安装通过：runtime:doctor 全 ok、broker protocol 1/2、testMode=false、agents/maintenance doctor 全 ✓；agentos-clean3（v0.3 安装）按 README 升级：记录哈希不变、schema 3→4、doctors 通过，暴露并修复空 managed 目录备份失败，修复后备份+恢复（incarnation 2）通过；native:build 在 dev box 与 clean4 六个产物 sha256 完全一致 | real native, clean box | pass |
| V4-O05 | 前台性能 | tests/recovery/v04-perf.test.ts（box，A/B 交替 3+3 轮×200 次 CRUD/查询）：基线 p95 1.333 ms，后台批处理期间 1.473 ms，比值 1.105；原始数据 docs/evidence/perf-v04-o05.json | real process | pass |
| V4-O06 | 压力与空间 | tests/maintenance/v4-maintenance.test.ts（作业队列 64 上限拒绝新工作不丢旧事实；低于安全落账空间 64 MiB 不启动新效果、作业带原因等待、receipt/作业不删除，空间恢复后继续；诊断证据 ≤64 KiB）+ 既有 queue/compaction/proposal 上限测试 | faux model | pass |
| V4-O07 | 关键 API 门槛 | packages/agent-pi/test/m0-pi-prototype.test.ts（固定 Pi 1.4.0 实测：两会话路由并发、按会话 abort、原子会话目录、原子压缩登记、重启重建），无替代路径 | in-process | pass |
| V4-O08 | 证据与遗留项 |  | in-process | **open** |

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

