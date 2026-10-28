# v0.2 acceptance report (2026-10-28)

Baseline: [AGENTOS_MVP_V0.2.md](AGENTOS_MVP_V0.2.md) §24 (60 items) and §25. Every item below was run on real Linux with
real rootless Podman unless marked otherwise. Simulated items (faux model) are marked; real-model items are V2-E01–E03.

## Environments

| | Development box `agentos` | Clean box `agentos-clean` (README reproduction) |
|---|---|---|
| OS / kernel | Debian GNU/Linux 13 (trixie), 6.18.54-instabox, x86_64 | Debian GNU/Linux 13.7 (trixie), 6.18.54-instabox, x86_64, created empty for this run |
| CPU / RAM | 4 vCPU / 8 GiB | 4 vCPU / 8 GiB |
| Podman / OCI runtime | 5.4.2 rootless, crun 1.21 | 5.4.2 rootless, crun (Debian package) |
| cgroup | v2, systemd manager, controllers `cpu memory pids` delegated | v2, `cpuset cpu io memory pids` delegated via README drop-in |
| Security | seccomp on; AppArmor/SELinux not available on this kernel | same |
| subuid/subgid | `sandbox:100000:65536` | added by README step |
| Node / pnpm | 24.22.1 / 10 (packageManager) | 24.22.1 / 10 (corepack) |
| Source | working tree that became the v0.2 commit (see "Commit") | git bundle of the same tree, cloned as README step 3 |

Known environment quirk (both boxes): the VM overmounts `/proc/sys/kernel/random/boot_id`, which makes the kernel refuse a
fresh `/proc` inside a user namespace. `pnpm runtime:doctor` reports it (`no /proc overmounts` FAIL) with the fix; the README
troubleshooting row documents the umount + Podman boot-id cache reset. On the clean box: doctor FAIL → fix → `runtime:prefetch`
ok → doctor all ok → `deploy/install.sh` → `agentos-host` active, `/health/ready` = ready.

### Runtime catalog and images

| Lock | Base image (pinned) | Builder image | Runtime image |
|---|---|---|---|
| `core-v1@1` | `node:24.22.1-bookworm-slim` by platform digest (catalog.json) | `localhost/agentos-builder-core-v1:5509cf20d792a02d` | `localhost/agentos-runtime-core-v1:e4ddd24e84404ad1` |
| `data-v1@1` (papaparse 5.7.0, date-fns 4.4.0) | same | `localhost/agentos-builder-data-v1:42f9cdd47f1f0fad` | `localhost/agentos-runtime-data-v1:08f69b54ea64d698` |

Local image IDs on the development box: runtime-core `sha256:e5f8ff04…ffd6fb`, runtime-data `sha256:8899ed14…5d720f`,
builder-data `sha256:4dc0f1b7…6e9e`, builder-core `sha256:f69d7b41…4653`. The clean box built the same tags (tag = recipe hash)
from the same recipes. v1 canonical hash of todo-v1 unchanged: `sha256:428df8c7…332d5`; v2 fixture hash
`sha256:91a9f594…d56cd2`.

## Suite results (development box, final run)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck` | pass |
| `pnpm test` (unit project: contracts, data, services, Pi adapter with faux on real Durable + SQLite, HTTP) | 62/62 |
| `pnpm test:recovery` with `AGENTOS_OFFLINE_TEST=1 AGENTOS_V01_ROOT=/data/home/agentos` (real processes, SIGKILL, real Podman) | 29/29 (16 v0.1 + 13 v0.2) |
| `pnpm test:sandbox` with `AGENTOS_OFFLINE_TEST=1` (real rootless Podman) | 34/34 on an idle box. During the run that overlapped the real-model smoke, V2-I03/I04 hit the 3 s query timeout once under CPU load; rerun alone and in the full suite afterwards: pass |
| `pnpm test:e2e` (Chromium, same-origin production build, real Podman, no model for the v0.2 specs) | 6/6 |
| `pnpm runtime:doctor` / `runtime:prefetch` / `runtime:gc -- --dry-run` | exit 0 / exit 0 / exit 0 |
| `node scripts/export-contracts.mjs --check` (inside the unit suite) | docs/contracts match the validators |

Clean box (README reproduction): `pnpm install --frozen-lockfile`, `pnpm build`, `runtime:doctor` (FAIL on the VM /proc overmount → README fix → after
`runtime:prefetch` 18/18 ok, "runtime ready"), `deploy/install.sh` → service active and ready, `pnpm test` 61/61,
`pnpm test:sandbox` 33/33 + 1 opt-in skipped, Playwright Chromium installed per Playwright's own `install-deps`, `pnpm test:e2e`
6/6. See "Commit" for the tree used.

## Matrix (§24)

| ID | Test | Status |
|---|---|---|
| V2-C01–C06 | tests/integration/v02-contracts.test.ts (v1 frozen hash, CodeBundle structure, paths/sizes, references and schemas, runtime locks, content identity) | pass |
| V2-D01–D04, D07 | tests/integration/v02-data.test.ts | pass |
| V2-D05, D06 | tests/sandbox/v02-security.test.ts (real instances: concurrent record change → conflict; version switch mid-command → late result cannot commit) | pass |
| V2-D08 | tests/recovery/v02-recovery.test.ts (crash before commit re-executes within budget; after commit only replays) | pass |
| V2-S01–S07 | tests/sandbox/v02-security.test.ts (host files/socket/egress, infinite loop timeout, OOM → APP_RESOURCE_LIMIT, pids, tmpfs and log flood, forged principals/stale lease/DATA_EPOCH_STALE, SANDBOX_UNAVAILABLE without fallback) | pass |
| V2-B01–B03 | tests/sandbox/v02-build-ipc.test.ts | pass |
| V2-B04 | tests/sandbox/v02-ops.test.ts (engine with network blocked: build from cached images, roll back, uncached image fails explicitly) | pass |
| V2-P01, P07, P11, P12 | tests/sandbox/v02-ops.test.ts | pass |
| V2-P02–P06, P08 | tests/recovery/v02-recovery.test.ts (separate host processes, SIGKILL fault points) | pass |
| V2-P09, P10 | tests/sandbox/v02-agent.test.ts (cancel during prepare publishes nothing; publish first → ALREADY_APPLIED; same revision → no-op) | pass — faux model |
| V2-I01–I05 | tests/sandbox/v02-build-ipc.test.ts | pass |
| V2-A01, A02, A04 | tests/sandbox/v02-agent.test.ts (real Pi Durable, SQLite, builder and runtime containers; faux model) | pass — faux model |
| V2-A03, A05 | tests/recovery/v02-recovery.test.ts | pass |
| V2-U01, U03, U04 | tests/e2e/v02-main.spec.ts | pass |
| V2-U02 | tests/e2e/v02-main.spec.ts (HTML/script in data shown as text, no dialog) + C04 (UI schema rejects HTML/expressions/external resources) | pass |
| V2-U05 | tests/e2e/v02-main.spec.ts runs with no model configured: apps, atomic commands, history switches; services in v02-build-ipc need no model | pass |
| V2-O01 | tests/recovery/v02-recovery.test.ts: workspace written by the real v0.1 host (commit 7cd2bbe, /data/home/agentos) copied and upgraded; revisions (ids = v1 hashes) and bundle bytes, records, receipts, store UUID identical; original copy untouched; generation continues | pass |
| V2-O02, O04 | tests/recovery/v02-recovery.test.ts | pass |
| V2-O03 | tests/recovery/v02-recovery.test.ts (engine offline, platform images removed; restore imports them; code version runs, rolls back and forward; old session 401) | pass |
| V2-O05, O06 | tests/sandbox/v02-ops.test.ts | pass |
| V2-O07 | tests/recovery/v02-recovery.test.ts | pass |
| V2-E01–E03 | `pnpm smoke:v0.2-real`, see below | pass — real model |

## Real model (V2-E01–E03)

Provider `openai-compatible` (TokenRhythm, `https://tokenrhythm.studio/v1`), model `qwen3.8-flash`. The key never reached the
box: the box host called a key-less relay on 127.0.0.1 (scripts/model-relay-box.mjs); a forwarder on the development machine
(scripts/model-relay-forward.mjs) reached the relay through a private SSH port-forward and added the key on its side.

Four runs; runs 1 and 4 passed, runs 2 and 3 exposed a platform issue that was then fixed.

| Run | Time (CST) | Result |
|---|---|---|
| 1 | 16:40–17:15 | E01 create, E01 modify + version switch, E02, E03 all succeeded. The script's record-count path used the declarative records API, which code apps do not have; the counts were then read from the run's os.sqlite: todo app 3 records kept through both switches; CSV app 3 → 3 (bad row refused whole) → 3 (101 rows refused whole) → 103, data_epoch unchanged by the two refusals. Script fixed to read counts from os.sqlite. |
| 2 | 17:17–17:24 | E01 failed: the model sent `bundle` as a JSON-encoded string three times; `app_stage` answered "must be object" each time and the 3-stage budget ended the run (BUDGET_EXCEEDED, nothing published). |
| 3 | 17:26–17:36 | E01 passed, E01 modify failed the same way. |
| fix | | `app_stage` decodes a string argument that parses to a JSON object (`decodeBundleArg`, unit-tested); anything else still fails schema validation. |
| 4 | 17:41–18:02 | all pass, every assertion in-script (test-results/smoke-v02-real.json) |

Run 4 details (model requests per run ≤ 12, stage attempts ≤ 3):

| Step | Requests / stages | Tools | Checked |
|---|---|---|---|
| E01 create code kanban | 8 / 3 | system_info, app_get, runtime_catalog, app_stage ×3 (2 diagnosed), app_validate, app_prepare, app_activate | `isolated-code-v1`, health ready, 3 tasks created by command, batch completion succeeded |
| E01 modify (hours + summary service) | 6 / 2 | app_get, app_stage ×2, app_validate, app_prepare, app_activate | field `estimate_minutes`, export `summary`, 3 records kept; switched back to the first code version and forward again, records 3 → 3 |
| E02 overview app | 5 / 1 | app_get, service_catalog, app_stage, app_validate, app_prepare, app_activate | before the grant it shows "not connected" and no numbers; after the user grant its numbers equal the service's; after revoke it fails again |
| E03 CSV import (data-v1) | 5 / 2 | … app_stage ×2, app_validate, app_prepare, app_activate | lock `data-v1@1`, imports `papaparse`; 3 rows committed; a bad row and 101 rows refused whole (records stay 3); 100 rows committed in one batch (103) |

Usage (Pi session totals reported by the provider, cumulative over the session): after E01 input 34,311 / output 27,811 /
cache read 131,328 tokens; after E01 modify 58,160 / 44,223 / 395,776; after E03 91,245 / 70,219 / 1,064,960 (total
1,226,424). The provider reported cost 0 through this endpoint.

## §25 delivery checklist

| Item | Status |
|---|---|
| v0.1 regression and real workspace copy upgrade, old hashes and the store pair kept | v0.1 suites included in the runs above; V2-O01 |
| strict schemas + semantic checks for v2 bundle, RPC, SDK, Slot Tree, queries/commands, services | C01–C06, docs/contracts generated from the validators |
| rootless OCI runner passes real isolation/resource/no-network/fault tests | S01–S07, B01–B04 |
| two runtime profiles exactly locked; builds run no user config or install scripts | C05, B01, catalog.json |
| artifacts separate from source identity; cache, history references, failure cleanup | C06, B02, B03, O05 |
| Prepare / Activate / Reconcile wired; publication facts separate from health | P01–P12 |
| InvocationService at-most-once, conflicts, defaults, hidden fields | D01–D08 |
| Slot Tree components, app errors do not affect the Shell | U01–U04 |
| two-app queries, exact grants, revoke, one hop | I01–I05, E02 |
| Pi tools, frozen budgets, cancel, diagnostic repair, post-publish fence | A01–A05, P09, P10 |
| M0–M6 and §24 with environment and traceable report | this document |
| cold backup with everything needed; offline and interrupted restore | O02–O04 |
| README reproducible on clean Linux; scope and limits accurate | clean box run above |

## Commit

Implementation and tests: `3c87ce5` ("complete AgentOS v0.2 implementation and acceptance"). The development-box final
suites ran on that tree. The clean box first ran an earlier snapshot of the same work (results above), then was updated to
`3c87ce5` itself: `pnpm install --frozen-lockfile`, `pnpm build`, `runtime:doctor` exit 0, service restarted and ready,
`pnpm test` 62/62, `pnpm test:sandbox` 33/33 + 1 opt-in skipped, `pnpm test:e2e` 6/6. This report was finalized in the next commit.
