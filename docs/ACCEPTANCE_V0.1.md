# v0.1 acceptance report (2026-10-28)

Environment: Debian GNU/Linux 13 (trixie) on InstaBox microVM `agentos` (4 vCPU / 8 GiB), systemd, Node 24.22.1,
pnpm 10.34.9, Pi Durable / pi-ai / chord 1.4.0. Spec baseline is Ubuntu 24.04; nothing here is Debian-specific.

| Suite | Command | Result |
|---|---|---|
| typecheck | `pnpm typecheck` | pass |
| unit + integration (contracts, services, Pi adapter with faux model on real Durable + SQLite, HTTP on a real host process) | `pnpm test` | 30/30 |
| recovery (real child processes, SIGKILL fault points) | `pnpm test:recovery` | 14/14 |
| browser main path + error boundary (same-origin production build, faux) | `pnpm test:e2e` | 2/2 |
| real model (E01) | `pnpm smoke:real` | PASS (see below) |

## Matrix

| ID | Where | Status |
|---|---|---|
| C01–C05 | tests/integration/m1-data.test.ts | pass |
| D01–D07 | tests/integration/m1-data.test.ts | pass |
| A01–A05 | tests/integration/m3-agent.test.ts (faux through the formal adapter, real tools and databases) | pass — simulated |
| R01–R09, R11 | tests/recovery/recovery.test.ts | pass |
| R10, R12 | tests/integration/m4-runs.test.ts | pass |
| O01, O03, O04, O05 | tests/recovery/recovery.test.ts | pass |
| O02 | tests/integration/http.test.ts, e2e | pass |
| U01 | e2e (refresh + host restarts), http tests | pass |
| U02 | e2e (payload corrupted in transit → boundary, shell and versions stay usable) | pass |
| U03 | tests/integration/http.test.ts | pass |
| L01 | tests/integration/http.test.ts | pass |
| E01 | `pnpm smoke:real` | pass — real model |

## E01 real-model run

Provider `openai-compatible` (TokenRhythm, `https://tokenrhythm.studio/v1`), model `qwen3.8-flash`, run from the
development sandbox (the deployment box holds no model key). Two consecutive runs:

| Run | create | upgrade | result |
|---|---|---|---|
| 1 | succeeded, 4 model requests, 1 stage, 22 s; fields title, done | succeeded, 4 requests, 18 s; + priority enum (default 中), filter added; existing record backfilled | PASS |
| 2 | succeeded, 4 requests, 15 s; fields task_title, done | succeeded, 4 requests, 15 s; + priority | PASS |

An earlier run (before the prompt said "build only what was asked" and "always end with a publish") produced a
richer first version and then ended the upgrade without publishing; the run was reported as
`NO_APPLICATION_PUBLISHED` and the old version kept working, as specified. Token use for one create + upgrade was
about 32k total tokens (≈8k input, 1.9k output, 22k cache reads).
