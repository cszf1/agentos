# AgentOS v0.2

A single-user application runtime for Linux. You describe an app in natural language; a Pi Durable agent builds it
through host tools; the host validates, prepares, health-checks and publishes it; a trusted React renderer shows it;
records live in local SQLite. Apps keep working without a model, every version is immutable, you can switch back and
forth, and data survives restarts and crashes.

v0.2 adds a second app runner. Two kinds of app run side by side:

- **`declarative-v1`** (v0.1): a record collection with list/form/search/filters, rendered by the trusted shell.
- **`isolated-code-v1`** (new): TypeScript business logic (queries and atomic commands) compiled by the platform in a
  no-network builder and run in a **rootless Podman container** per app (no network, read-only rootfs, no
  capabilities, `no_new_privs`, seccomp, cgroup memory/CPU/pids limits, tmpfs quota). Its UI is a **Slot Tree**: data
  describing fixed components (Stack, Grid, Tabs, Text, Alert, Metric, Table, Kanban, Form, inputs, Button, bar/line
  charts) that the shell renders. Apps never ship HTML or JavaScript to the browser.

A code app only reads and writes its own records through a host-checked **mutation plan** (create/update/delete,
all-or-nothing, at most once). Apps can expose read-only **services** to each other; one app reads another only after
the user connects them, for an exact pair of versions. Publishing goes through **Prepare → Activate → Reconcile**:
the candidate is built, started and checked with platform fixtures (never your real records) before one short
transaction switches the version.

Baseline: [docs/AGENTOS_MVP_V0.2.md](docs/AGENTOS_MVP_V0.2.md) (M0–M6). Acceptance report:
[docs/ACCEPTANCE_V0.2.md](docs/ACCEPTANCE_V0.2.md). Contracts: [docs/contracts/](docs/contracts/).

## Layout

```
packages/contracts       v1 AppBundle (frozen), v2 CodeBundle, Slot Tree, RPC schema subset, runner ABI/frames,
                         runtime catalog types, DTOs, error codes, limits
packages/core            os.sqlite migrations, apps/records/runs, capability gateway, builds (BuildService,
                         ArtifactStore, GC), runtime (InstanceHost, AppRuntimeService, Reconciler, RuntimeSystem),
                         deployments, invocations (queries/commands), inter-app services
packages/runtime-podman  RuntimeDriver over the Podman REST API on the user socket; image recipes
packages/app-runner      the in-container runner and the in-builder compile step (tsc + esbuild, fixed options)
packages/app-sdk         @agentos/app-sdk types apps compile against (defineQueries/defineCommands, ctx)
packages/agent-pi        the only package importing Pi Durable: tools (v2 tool set), prompt, budgets, faux model
packages/host            config, flock, Fastify API + static shell, startup/shutdown, backup/restore, runtime ops
packages/web             browser shell (React 19, Vite 7) with the Slot Renderer
runtime/                 runtime catalog (catalog.json: locks core-v1@1, data-v1@1), image recipes
bin/                     agentos-host, agentos-admin (backup/restore/gc under host.lock), agentos-runtime
deploy/                  systemd user unit and install script
tests/                   integration, recovery (real processes, SIGKILL), sandbox (real Podman), e2e (Playwright)
fixtures/                todo-v1/v2 (v0.1) and v0.2 code fixtures (kanban, hours, overview, CSV, fault lab, ...)
```

## Requirements

- Linux x86_64 (or arm64) with systemd; cgroup v2; a local filesystem for the data dir (≥ 12 GiB free recommended:
  the build cache budget is 10 GiB)
- util-linux `flock` ≥ 2.38
- Node.js **24.22.1** (`.node-version`), pnpm 10
- **Podman ≥ 5** running rootless for the same user, with `crun`, user namespaces, subuid/subgid, and cgroup v2
  delegation of `cpu`, `memory` and `pids` to the user. Without it the host still runs declarative apps; code apps
  answer `SANDBOX_UNAVAILABLE` (there is no fallback to plain processes).

Verified on Debian 13 (kernel 6.18, Podman 5.4.2, crun) and Ubuntu 24.04.5 for v0.1; see the acceptance report for the
exact environment of the v0.2 run.

## Install from a clean machine

As an admin (once), then as the user who will run AgentOS (not root):

```bash
# 0. system packages (admin)
sudo apt-get install -y git curl xz-utils ca-certificates podman crun uidmap slirp4netns fuse-overlayfs
#    subuid/subgid range for the user (admin; most distros add it on useradd)
grep "^$USER:" /etc/subuid /etc/subgid || sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"
#    cgroup v2 delegation of cpu/memory/pids to user sessions (admin; systemd ≥ 244 delegates memory+pids by default)
sudo mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
sudo systemctl daemon-reload
sudo loginctl enable-linger "$USER"     # user services (podman.socket, agentos-host) without a login session
#    log out and back in (or reboot) so the delegation applies

# 1. rootless Podman API socket for this user
systemctl --user enable --now podman.socket
ls -l /run/user/$(id -u)/podman/podman.sock      # srw------- owned by you
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers   # cpu ... memory pids

# 2. Node 24.22.1 at a fixed absolute path (the service uses this path)
mkdir -p ~/.local && cd ~/.local
curl -fsSLO https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz   # -arm64 on ARM
tar -xJf node-v24.22.1-linux-x64.tar.xz && mv node-v24.22.1-linux-x64 node24
export PATH="$HOME/.local/node24/bin:$PATH"     # add this line to ~/.profile
corepack enable --install-directory ~/.local/node24/bin

# 3. source, dependencies, build
git clone https://github.com/cszf1/agentos.git ~/agentos && cd ~/agentos
pnpm install --frozen-lockfile
pnpm build

# 4. check the sandbox environment and prefetch the approved images (needs network once)
pnpm runtime:doctor            # every line must say ok; it starts a probe container with the real limits
pnpm runtime:prefetch          # pulls the pinned base image by digest and builds builder/runtime images per lock

# 5. user service
deploy/install.sh              # writes ~/.config/agentos/agentos.env (0600) and enables the user unit
systemctl --user status agentos-host
curl -s http://127.0.0.1:4317/health/ready     # {"status":"ready"}
cat ~/.local/share/agentos/auth-token           # paste into the login page
```

The shell shows "代码运行环境 就绪" when the sandbox is usable. After `runtime:prefetch` everything needed for builds and
runs is local: builders and apps never use the network, so the machine can be offline (V2-B04).

### Approved runtime images

`runtime/catalog/catalog.json` pins two runtime locks. Each names a base image **by digest**, the exact compiler
versions (TypeScript, esbuild), the SDK/ABI version and, for `data-v1`, the approved libraries with version, license and
integrity:

| Lock | Contents |
|---|---|
| `core-v1@1` | Node 24 runner, `@agentos/app-sdk` |
| `data-v1@1` | `core-v1` plus `papaparse` 5.7.0 and `date-fns` 4.4.0 (exact, with transitive deps) |

Images are built locally from these recipes (`localhost/agentos-{builder,runtime}-<profile>:<recipe hash>`) and carry
the recipe hash as a label; a mismatch is refused, never silently replaced. Generated apps cannot choose versions or
add packages; an unapproved import fails the build with `DEPENDENCY_NOT_ALLOWED`.

### Real model

Edit `~/.config/agentos/agentos.env` (stays 0600), then `systemctl --user restart agentos-host`:

```bash
AGENTOS_MODEL_MODE=real
AGENTOS_MODEL_PROVIDER=openai-compatible
AGENTOS_MODEL_BASE_URL=https://your-endpoint.example/v1
AGENTOS_MODEL_ID=your-model-id
AGENTOS_MODEL_API_KEY=...
```

Behind an HTTP proxy also set `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY=...` and `NO_PROXY=127.0.0.1,localhost`. Without a
model the host starts; apps, commands, services and version switching work, generation shows "model unavailable".

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGENTOS_DATA_DIR` | `~/.local/share/agentos` | os.sqlite, agent.sqlite, artifacts/, auth-token, logs (0700) |
| `AGENTOS_HOST` / `AGENTOS_PORT` | `127.0.0.1` / `4317` | loopback only |
| `AGENTOS_RUNTIME` | `podman` | `off` disables code apps (declarative only) |
| `AGENTOS_PODMAN_SOCKET` | `/run/user/<uid>/podman/podman.sock` | rootless engine API socket |
| `AGENTOS_MODEL_MODE` | `real` | `faux` = deterministic acceptance model (no network) |
| `AGENTOS_MODEL_PROVIDER` / `AGENTOS_MODEL_ID` / `AGENTOS_MODEL_BASE_URL` / `AGENTOS_MODEL_API_KEY` | unset | real model |

## Daily use

```bash
systemctl --user status agentos-host
journalctl --user -u agentos-host -f        # also ~/.local/share/agentos/logs/host.log
systemctl --user restart agentos-host       # SIGTERM: stops accepting, drains ≤30 s, stops app containers
cat ~/.local/share/agentos/auth-token
```

Open `http://127.0.0.1:4317/`. From another computer forward the port: `ssh -L 4317:127.0.0.1:4317 user@host` (or
`instabox port-forward <box> 4317`).

In the shell: create an app ("做一个待办看板应用"), modify it ("增加预计工时并提供统计服务"), switch versions (each switch of a
code app prepares and checks the target first), start/stop/restart a code app, read its health and diagnostics, and
connect services ("服务连接": choose which app may read which service; revoke at any time). Deleting a record is
permanent; switching versions never restores deleted records.

## Operations

```bash
pnpm runtime:doctor                 # environment checks (rootless, cgroup controllers, seccomp, probe limits, no network)
pnpm runtime:prefetch               # pull/build the pinned images; reports offlineReady per lock
pnpm runtime:gc -- --dry-run        # what the cache GC would remove (host stopped)
pnpm runtime:gc                     # remove unreferenced artifacts and staging dirs of this workspace
pnpm runtime:gc -- --include-images # also platform images no catalog of any workspace on this engine claims
pnpm test:sandbox                   # isolation/limits/build/IPC/agent tests on real Podman
```

GC never removes artifacts of activated (history) revisions, open deployments, live instances or running builds, never
runs during a backup (both hold `host.lock`), and never touches containers or images of another workspace (each workspace records the images it
uses under `~/.local/share/agentos/image-claims/`). Builds are refused with a clear error when the cache is over its
budget after cleanup or the data disk has less than 256 MiB free.

### Backup and restore (cold)

```bash
systemctl --user stop agentos-host
pnpm backup -- --output ~/agentos-backups/2026-10-28    # both DBs, artifacts, catalog, OCI image archives, manifest
pnpm restore -- --backup ~/agentos-backups/2026-10-28   # verifies every hash first, saves the current set, restores
systemctl --user start agentos-host
```

The manifest records store UUID, product/schema/ABI/policy versions, source commit, pi-durable version, catalog hash
and a SHA-256 for every file and image archive. A damaged or incompatible backup is refused before anything changes. A
restore imports the image archives (works offline), rewinds the workspace to the backup time, bumps the client epoch,
rotates the auth token and invalidates every old instance lease. An interrupted restore leaves
`restore-in-progress`; the host refuses to start until `pnpm restore` is re-run.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `runtime:doctor`: engine socket FAIL | `systemctl --user enable --now podman.socket`; `XDG_RUNTIME_DIR` must be `/run/user/<uid>` |
| cgroup v2 controllers missing cpu/pids | add the `Delegate=` drop-in above, re-login |
| subuid/subgid FAIL | add a range in `/etc/subuid` and `/etc/subgid`, then `podman system migrate` |
| doctor: `no /proc overmounts` FAIL, or `crun: mount proc to proc: Operation not permitted` | something overmounts a file under `/proc` (seen on some VMs at `/proc/sys/kernel/random/boot_id`). `sudo umount /proc/sys/kernel/random/boot_id`, then Podman sees a new boot id: `rm -rf /run/user/$(id -u)/containers /run/user/$(id -u)/libpod/tmp && systemctl --user reset-failed podman.socket podman.service && systemctl --user restart podman.socket`. The overmount comes back after a VM restart. |
| `IMAGE_UNAVAILABLE` offline | run `pnpm runtime:prefetch` while online; nothing substitutes another image |
| code app `degraded` | it crashed more than twice in 5 minutes; read diagnostics in the app panel, fix or press 重启 |
| `APP_RESOURCE_LIMIT` on prepare | at most 4 code apps run at once; stop one |

## Development and tests

```bash
pnpm dev               # dev host on 127.0.0.1:4318 + Vite on :5173
pnpm typecheck
pnpm test              # build + contracts/data/services/Pi adapter/HTTP integration (no Podman needed)
pnpm test:recovery     # real child processes, SIGKILL fault points, v0.2 publish/command/restore recovery (Podman)
pnpm test:sandbox      # real rootless Podman: isolation, limits, builds, IPC, Pi code generation (faux)
pnpm test:e2e          # Playwright against the production build (Podman for the v0.2 specs)
pnpm smoke:real        # v0.1 E01 with a real model
pnpm smoke:v0.2-real   # V2-E01–E03 with a real model (writes test-results/smoke-v02-real.json)
node scripts/export-contracts.mjs   # regenerate docs/contracts from the validators
```

Fault injection points exist only when `NODE_ENV=test` and `AGENTOS_FAULTS=1`. Opt-in tests: `AGENTOS_OFFLINE_TEST=1`
(engine without network: V2-B04/O03, it changes the user podman service environment and restores it) and
`AGENTOS_V01_ROOT=<v0.1 checkout>` (V2-O01 migration from a workspace written by the real v0.1 host).

## Known scope (v0.2)

- One local user, one workspace, one host writer, one generation at a time; at most 4 running code apps.
- Code apps: queries and commands only; no persistent timers, background side effects, external HTTP, files or
  devices; one record collection per app; services are read-only and one hop.
- UI is limited to the fixed Slot Tree components.
- os.sqlite uses `synchronous=FULL`; Pi's agent.sqlite uses `NORMAL` (the newest Pi commit can be lost on power
  failure; process crashes are recovered).
- The browser shell is the development window; Linux providers, the OS image and Wayland are later versions.
