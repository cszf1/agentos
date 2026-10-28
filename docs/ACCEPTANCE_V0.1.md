# v0.1 acceptance report (2026-10-28, rev 2)

Two environments, same commit:

| | Debian 13 box | Ubuntu 24.04 LTS (spec baseline) |
|---|---|---|
| Machine | InstaBox microVM `agentos`, 4 vCPU / 8 GiB, systemd | clean `ubuntu:24.04` container with systemd as PID 1 on the same box, new user, nothing preinstalled |
| Install | existing checkout, `pnpm install --frozen-lockfile` | README "Install from a clean machine" step by step: apt packages, Node 24.22.1 tarball at `~/.local/node24`, corepack pnpm, `git clone`, `pnpm install --frozen-lockfile`, `pnpm build`, `deploy/install.sh`, `loginctl enable-linger` |
| `pnpm typecheck` | pass | pass |
| `pnpm test` (contracts, services, Pi adapter with faux on real Durable + SQLite, HTTP on a real host process) | 32/32 | 32/32 |
| `pnpm test:recovery` (real child processes, SIGKILL fault points, backup/restore) | 16/16 | 16/16 |
| `pnpm test:e2e` (same-origin production build, Chromium) | 3/3 | 3/3 |
| systemd user service | active, `127.0.0.1:4317`, ready | active after install.sh, ready; restart/stop/start; env file 0600, data dir 0700, auth-token 0600, `AGENTOS_NODE` absolute |
| `pnpm dev` | – | dev host on 4318 + Vite 5173 while the installed service keeps 4317; login and state through the Vite proxy |
| `pnpm smoke:real` (E01) | not run: the box holds no model key | – (run from the development machine, see below) |

The Ubuntu clone came from a git bundle of the pushed commit (the GitHub repository is private and the container
has no GitHub credentials); everything else followed the README literally. `USER` had to be exported because
`docker exec` sets no login environment.

## Matrix

| ID | Where | Status |
|---|---|---|
| C01–C05 | tests/integration/m1-data.test.ts | pass |
| D01–D07 | tests/integration/m1-data.test.ts | pass |
| M2 exit | tests/e2e/fixture-shell.spec.ts: fixtures seeded through the test-only `agentos-admin seed` (refused unless NODE_ENV=test), **no model configured**; CRUD, search, filters, v1→v2→v1→v2, restart keeps data, a stale page's write gets 409 RECORD_VERSION_STALE with input kept | pass |
| A01–A05 | tests/integration/m3-agent.test.ts (faux through the formal adapter, real tools and databases) | pass — simulated |
| A02 deadline | m3-agent A02c (controllable clock: 299 s still running, 301 s DEADLINE_EXCEEDED), A02d (host down past the deadline → failed on restart) | pass |
| R01–R09, R11 | tests/recovery/recovery.test.ts; R09 covers both the Pi restart limit and R09b a Pi task whose definition is missing after restart (task kind renamed in agent.sqlite → `missing_task` → run blocked, RUN_BUSY, no writes, cancellable) | pass |
| R10 | tests/integration/m4-runs.test.ts | pass |
| R12 | m4-runs: blocking compaction only, counted in its run; then cancel a run on the compacted conversation → next run is RUN_BUSY until Pi converges, then succeeds; the cancelled run wrote no revision | pass |
| O01, O03, O04, O05 | tests/recovery/recovery.test.ts | pass |
| O06 (restore version check) | recovery O06: manifest with schema 99 or another pi-durable version is refused before any file is touched | pass |
| O02 | tests/integration/http.test.ts, both e2e specs | pass |
| U01 | e2e (refresh + host restarts), http tests | pass |
| U02 | e2e (payload corrupted in transit → boundary, shell and versions stay usable) | pass |
| U03 | tests/integration/http.test.ts | pass |
| L01 | tests/integration/http.test.ts | pass |
| E01 | `pnpm smoke:real` | pass — real model |

## Spec points closed in rev 2

- `app_validate` returns `{valid, errors:[{path,code,message}]}`; `app_stage` returns `{revisionId, valid, errors}`.
- Durable settings are exactly §10: `stream {maxRetries:0, transport:"sse"}`, `retry {enabled:true, maxRetries:2}`,
  `compaction {enabled:true, backgroundTokens:0}`, `toolExecution:"sequential"`.
- Only the validated real provider (`openai-compatible`, pi-ai openai-completions over SSE) is enabled; any other
  provider id reports `modelAvailable=false` with a diagnostic. Key: `AGENTOS_MODEL_API_KEY` or pi-ai's `OPENAI_API_KEY`.
- Logs (§15): one JSON line per HTTP request (requestId, method, route, status, durationMs, appId/runId/recordId,
  operationKey); one per agent tool execution (tool, piTaskId, runId, operationKey, revisionId, status, code,
  durationMs); slow business transactions (≥100 ms) with their duration. No tokens, cookies, prompts, records or
  model output.
- Restore checks the manifest's schema and pi-durable versions before touching anything, and the restored schema after.
- The builder prompt no longer carries a todo-specific example; it keeps the generic "fewest fields that serve the
  request" rule plus every item §10 lists.
- `pnpm dev` runs its own host (127.0.0.1:4318, `.data/dev`, same lock script) and Vite on 5173 proxying only to it.
- README starts from a clean Linux machine (apt packages, Node path, pnpm, clone, install, service, token, logs,
  port forwarding, model configuration).

## E01 real-model run

Provider `openai-compatible` (TokenRhythm, `https://tokenrhythm.studio/v1`), model `qwen3.8-flash`, run from the
development machine with this commit (the deployment box holds no model key). Two consecutive runs:

| Run | create | upgrade | tokens | result |
|---|---|---|---|---|
| 1 | succeeded, 4 model requests, 1 stage, 27 s; fields task, done; filter done | succeeded, 4 requests, 1 stage, 22 s; + priority enum (default 中), filter priority; existing record backfilled | 32.5k total (8.8k in, 1.6k out, 22k cache read) | PASS |
| 2 | succeeded, 4 requests, 1 stage, 23 s; fields task, notes, priority, done | succeeded, 4 requests, 1 stage, 20 s; the first version already had priority, so it was kept | 31.8k total | PASS |

Run 2 shows the model adding fields the request did not name now that the prompt has no todo example; the run
still publishes valid, compatible versions and the old record keeps its values.
