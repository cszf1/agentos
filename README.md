# AgentOS v1.0 (branch `v1.0`, in acceptance)

**v1.0 is an installable operating system, not a runtime you add to Debian/Ubuntu.** It is a NixOS-based
distribution (x86_64 UEFI) that ships its own kernel, firmware list, greetd login, Sway session with the native Qt
Shell, LUKS2 + Btrfs disk layout, the privileged `machined` service and broker, offline OCI images, and A/B system
updates with rollback. You install it on an empty disk from its ISO; no host Linux is needed. The v0.4 runtime
described further down is now one layer inside it (the per-workspace Host).

| Build | Command |
|---|---|
| Installer ISO (offline, whole release closure on the medium) | `cd os && nix build .#agentos-iso` |
| VM template (same layout) | `cd os && nix build .#agentos-qcow2` |
| Release manifest, SBOM, firmware list, SHA256SUMS | `cd os && nix build .#agentos-release` |
| VM acceptance checks (needs KVM) | `cd os && nix build .#checks.x86_64-linux.<name>`, or the `v1-vm-tests` workflow |

- Install: boot the ISO and run `agentos-install inspect`, `plan --disk /dev/disk/by-id/X`, `confirm` (you type the
  disk serial or WWN) and `run`; it erases the whole target disk and refuses disks under 64 GiB. Dual boot, Secure Boot, NVIDIA proprietary drivers and ARM64 install are out of scope for v1.0
  (spec `docs/AGENTOS_MVP_V1.0.md`).
- Tested hardware: only the `qemu-virtio` profile (QEMU/KVM). Bare-metal GPU, displays, Wi-Fi, audio, suspend and
  physical disks are **not yet accepted**; see `docs/RELEASE_V1.0.md`.
- Status: **not a completed release** (V1-O10). Item-by-item evidence: `docs/ACCEPTANCE_V1.0.md`; checklist
  `docs/V1.0_CHECKLIST.md`; progress and design decisions `docs/V1.0_PROGRESS.md`; handoff `docs/HANDOFF_V1.0.md`.

---

## Earlier layer: AgentOS v0.4 runtime

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

v0.3 adds **Linux capabilities** without giving generated code any privilege. A `formatVersion: 3` app declares
resource **bindings** (a managed directory, a demo systemd unit, a lab network namespace, a serial device) and
**system actions**. It never touches Linux itself: its handler returns one frozen plan; the Shell shows a trusted
preview built by the provider from real state; only the user's confirmation (or a standing grant inside explicit
bounds) admits it. A small root broker (`native/`, Rust) executes fixed capabilities with a durable execution log,
fences, quarantine of unknown outcomes and evidence-based reconciliation; unprivileged workers do the actual file,
systemd, nftables and serial work; an eBPF collector reports exec/exit of registered workloads only. Pi gets a
`system_plan` mode that can read the resources the user chose and prepare ONE plan — it can never execute it.

v0.4 adds **parallel tasks and bounded maintenance**. Each task runs in its own Pi conversation (at most 2 foreground
tasks, a queue of 16; a new request is accepted as `202 queued`, never refused as busy) with a durable scheduler,
target leases and per-model budgets that always put foreground work first. A **task center** shows queued/running
work and its reasons; a **maintenance center** shows the policies you approved (exact template, target, automatic
actions, frequency, caps, expiry — never auto-renewed), jobs and their steps, incidents, reports and proposals.
Maintenance is template-based: app recovery and the demo unit `ensure-running` through the one runtime controller /
the broker (protocol 2 maintenance envelopes, root-side caps), online cache GC and log cleanup in batches, session
compaction, and model-backed **diagnosis** (a structured report over frozen, scrubbed evidence) and **optimisation**
(a candidate checked on platform fixtures that you publish yourself with its exact hash and app epoch). Nothing a
model suggests is installed, merged or published automatically.

Baseline: [docs/AGENTOS_MVP_V0.4.md](docs/AGENTOS_MVP_V0.4.md) (M0–M8, 88 checks). Acceptance report:
[docs/ACCEPTANCE_V0.4.md](docs/ACCEPTANCE_V0.4.md). Earlier: v0.3 [docs/AGENTOS_MVP_V0.3.md](docs/AGENTOS_MVP_V0.3.md)
(M0–M7, 80 checks), report [docs/ACCEPTANCE_V0.3.md](docs/ACCEPTANCE_V0.3.md). Earlier: v0.2 [docs/AGENTOS_MVP_V0.2.md](docs/AGENTOS_MVP_V0.2.md) (M0–M6). Acceptance report:
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
fixtures/                todo-v1/v2 (v0.1) and v0.2 code fixtures (kanban, hours, overview, CSV, fault lab, ...),
                         v0.3 system-console (formatVersion 3) and protocol vectors
packages/broker-client   host ↔ broker protocol client (framing, canonical JSON, domain hashes, vectors)
native/                  Rust 1.91.0 workspace: protocol, broker (root), provider-user, provider-workers
                         (file/service/net/serial), telemetry (eBPF collector); bpf/exec_exit.bpf.c (fixed object)
deploy/v0.3/             agentos-system-admin (install/inspect/reinstall-log/uninstall), unit templates
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
sudo apt-get install -y git curl xz-utils ca-certificates podman crun uidmap passt slirp4netns fuse-overlayfs
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
bash deploy/install-engine-env.sh                 # CVE-2026-57231 hardening: engine runs with an allowlisted env
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
pnpm runtime:prefetch          # pulls the pinned base image by digest and builds builder/runtime images per lock
pnpm runtime:doctor            # then every line must say ok; it starts a probe container with the real limits

# 5. user service
deploy/install.sh              # writes ~/.config/agentos/agentos.env (0600) and enables the user unit
systemctl --user status agentos-host
curl -s http://127.0.0.1:4317/health/ready     # {"status":"ready"}
cat ~/.local/share/agentos/auth-token           # paste into the login page
```

The shell shows "代码运行环境 就绪" when the sandbox is usable. After `runtime:prefetch` everything needed for builds and
runs is local: builders and apps never use the network, so the machine can be offline (V2-B04).

### Privileged side (administrator, once; v0.4 adds maintenance)

The host itself still runs as your user. The privileged part is installed by root from a build you made:

```bash
# build prerequisites (Debian 13 / Ubuntu 24.04)
sudo apt-get install -y build-essential pkg-config clang llvm libbpf-dev libelf-dev zlib1g-dev \
  libnftables-dev libudev-dev libsystemd-dev libpam0g-dev nftables iproute2 polkitd python3
curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain none   # rust-toolchain.toml pins 1.91.0
pnpm native:build              # cargo build --release --locked + the fixed BPF object; prints versions and sha256s
# register this user and its workspace store with the broker (store UUID: meta.store_uuid of os.sqlite, printed by doctor)
STORE=$(node -e 'console.log(new (require("node:sqlite").DatabaseSync)(process.argv[1],{readOnly:true}).prepare("SELECT store_uuid FROM meta").get().store_uuid)' ~/.local/share/agentos/os.sqlite)
sudo bash deploy/v0.4/agentos-system-admin install --host-user "$USER" --store-uuid "$STORE" --serial-pty
#   add --serial-udev /dev/ttyUSB0:VID:PID:SERIAL for a real serial device; --test-mode only on test machines
sudo bash deploy/v0.4/agentos-system-admin inspect     # registration, caps, maintenance caps, log version, quarantines, unknown ops
pnpm native:doctor             # openat2/systemd/cgroup/broker identity/policy/network/serial/BPF, item by item
pnpm agents:doctor             # v0.4 read-only: Pi version, tool set, conversations/bindings, routes, budgets, queue
pnpm maintenance:doctor        # v0.4 read-only: policies, jobs, outbox, broker protocol 2 and maintenance caps
systemctl --user restart agentos-host                  # the shell now shows "系统执行服务 就绪"
```

Installed: root-owned binaries in `/usr/lib/agentos`, `/etc/agentos/broker/policy.json` (the only source of caps),
the broker log `/var/lib/agentos-broker/broker.sqlite` (0700/0600, never part of a workspace backup), the managed
directory `/var/lib/agentos-managed/<store>/exports`, the demo unit `agentos-demo.service`, the lab namespace
`agentos-lab` with its peer, and, with `--serial-pty`, a **software** PTY serial sample (labeled as such everywhere).
v0.4 adds the root-side maintenance caps for `agentos-demo.service` (2 recoveries per hour, 3 per 24 h, 600 s
cooldown; user policies can only be narrower) and broker log schema 3 (maintenance state per workspace incarnation).
Telemetry needs a kernel with BTF (`/sys/kernel/btf/vmlinux`) and tracepoints; without them it reports
"不可用" and nothing else changes. If the broker log is ever lost: `sudo bash deploy/v0.4/agentos-system-admin
reinstall-log` (new machineInstallId; `deploy/v0.3/agentos-system-admin` is the same installer with the v0.3 profile), then `bin/agentos-admin rebind-broker --confirm-new-install` with the host
stopped; old plans, grants and outbox entries are void and never replayed.

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
| `AGENTOS_MODEL_ALLOWED_HOSTS` | unset | developer relay forwarder only (`scripts/model-relay-forward.mjs`): the https upstream host must be named here; no default upstream, redirects refused |

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

### Podman CVE-2026-57231 (Debian 13 / Podman 5.4.2)

Podman 1.8.1–5.8.3 copies variables of the engine process's own environment into a container when the image config
has an `Env` entry without `=` (`"TOKEN"`, or `"*"` for everything). Debian 13 ships 5.4.2 with no fix yet (fixed
upstream in 5.8.4 / 6.0.0). AgentOS mitigates it on any engine version:

- The driver refuses any image whose `Env` is not strictly `KEY=VALUE` (HTTP 422, `CVE-2026-57231` in the message)
  before every container create, on `ensureImage` (existing and freshly built images), and on `importImage` — a
  backup restore deletes such an image and fails. AgentOS only runs its own locally built platform images, so this is
  defence in depth against a tampered base image or backup archive.
- `deploy/install-engine-env.sh` (run by `deploy/install.sh`) adds a `podman.service` drop-in that starts the API
  service through `podman-clean-env`: the engine gets only `HOME USER LOGNAME PATH LANG XDG_RUNTIME_DIR
  DBUS_SESSION_BUS_ADDRESS` (+ systemd socket-activation `LISTEN_*`), not the session/agent/proxy variables of the
  systemd user manager. Undo: `rm -r ~/.config/systemd/user/podman.service.d/10-agentos-clean-env.conf
  ~/.local/libexec/agentos && systemctl --user daemon-reload && systemctl --user stop podman.service`.
- `pnpm runtime:doctor` reports `engine env (CVE-2026-57231)`: ok when the engine is fixed, or when it is affected and
  the service runs (or is configured to run) with the clean environment. The host logs a warning at boot on an
  affected engine. Never put secrets in the user manager environment (`systemctl --user set-environment`).
- Tests: `tests/integration/image-env-cve.test.ts` (driver paths, fake engine) and
  `tests/sandbox/cve-2026-57231.test.ts` (real engine: hand-built malicious OCI image, positive control, create and
  import refused).

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
| `invalid image env ... CVE-2026-57231` (422) | the image's config has an `Env` entry without `=`; it is refused on purpose. Rebuild the platform image (`pnpm runtime:prefetch`) or restore from a trusted backup |
| doctor: `engine env (CVE-2026-57231)` FAIL | run `bash deploy/install-engine-env.sh`, then `pnpm runtime:doctor` again |

### Upgrade from v0.3 to v0.4

All tasks must be finished (the host refuses the Pi tool-set upgrade while a v0.3 run is open). Your workspace is
migrated in place, once; apps, versions, records, grants and run history are kept, and `agent.sqlite` keeps its
pairing and old conversations (readable, never written again).

```bash
systemctl --user stop agentos-host
pnpm backup -- --output ~/agentos-backups/before-v0.4   # cold backup first
#   v0.3's backup stops with "ENOENT ... before-v0.4/managed" when the managed export directory is empty (a v0.3 bug,
#   fixed in v0.4). Then keep a cold copy of the whole data directory instead (host stopped):
#   rm -rf ~/agentos-backups/before-v0.4 && cp -a ~/.local/share/agentos ~/agentos-backups/before-v0.4-data
git -C ~/agentos pull && cd ~/agentos && pnpm install --frozen-lockfile && pnpm build
#   update the tree with git, not by unpacking an archive over it: files with old mtimes make `tsc -b` keep the v0.3 dist/
pnpm native:build
sudo bash deploy/v0.4/agentos-system-admin install --host-user "$USER" --store-uuid "$STORE" --serial-pty
#   keeps the broker log and its history (schema 1/2 → 3, rows copied, nothing deleted)
systemctl --user start agentos-host
pnpm agents:doctor && pnpm maintenance:doctor && pnpm native:doctor
```

Maintenance starts with **no policy enabled**: open the maintenance center, review a template and approve it.
Restoring a backup puts every policy into `paused_needs_review`; nothing old acts again until you approve it.

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
pnpm test:native       # v0.3: real broker/providers/workers on the installed privileged side
pnpm test:broker-recovery   # SIGKILL of broker/workers/host around every fence; coordinated backup/restore
pnpm test:telemetry    # host: unavailable path; QEMU guest with BTF: real eBPF (AGENTOS_TELEMETRY_GUEST=ssh target)
pnpm smoke:v0.3-real   # V3-E01–E03 with a real model (AGENTOS_MODEL_REASONING_EFFORT=low recommended)
pnpm test:agents       # v0.4: Pi multi-conversation prototype, scheduler, leases, budgets, roles
pnpm test:maintenance  # v0.4: policies, triggers, jobs, recovery, incidents, proposals (in-process, manual clock)
pnpm test:maintenance-recovery   # v0.4: SIGKILL inside maintenance jobs/outbox
pnpm test:gc-online    # v0.4: online GC batches, reference protection, intents
pnpm test:compaction   # v0.4: per-conversation compaction, budgets, routes
pnpm smoke:v0.4-real   # V4-O01/O03 with a real model (parallel apps, candidate publish, diagnosis, compaction)
node scripts/export-contracts.mjs   # regenerate docs/contracts from the validators
```

Fault injection points exist only when `NODE_ENV=test` and `AGENTOS_FAULTS=1`. Opt-in tests: `AGENTOS_OFFLINE_TEST=1`
(engine without network: V2-B04/O03, it changes the user podman service environment and restores it) and
`AGENTOS_V01_ROOT=<v0.1 checkout>` (V2-O01 migration from a workspace written by the real v0.1 host),
`AGENTOS_V03_WORKSPACE=<stopped v0.3 data dir>` (V4-B02; make one with `node scripts/make-v03-workspace.mjs <v0.3
checkout> <dir>`), `AGENTOS_PERF_OUT=<file>` (V4-O05 raw latency samples).

## Known scope (v0.4)

- Automatic effects are limited to the approved templates: app recovery (re-converge through the runtime controller,
  never replaying commands or touching records), demo-unit ensure-running (broker protocol 2, root caps), cache GC of
  unreferenced build objects, log cleanup of closed files, session compaction. Everything else is a report or a
  proposal you decide on. There is no "whole machine self-maintenance".
- An unknown outcome is quarantined and never retried blindly; a higher control epoch the host did not write (for
  example a stop by the user) wins over automatic recovery.
- Telemetry stays non-authoritative: gaps, unavailable probes or identity changes are observed, never read as a fault.
- Real serial hardware (V3-E04) remains outside acceptance; the PTY sample is software; guest eBPF evidence comes
  from the QEMU guest with BTF.

## Known scope (v0.3)

- Fixed providers only: managed text files (atomic replace, one exclusive writer), the catalog's demo units
  (start/stop/restart, CPU/memory limits), one lab network namespace with two fixed profiles, serial devices from the
  catalog with fixed frames, exec/exit telemetry of registered workloads. No arbitrary path, unit, rule, device,
  command or argv.
- One plan per action; nothing is retried automatically when the outcome is unknown; the resource stays quarantined
  until the user records a resolution.
- The PTY serial sample is a software protocol test; real serial hardware (V3-E04) is not part of this acceptance.
- Telemetry is never a source of facts or permissions; it is unavailable on kernels without BTF/tracepoints.

## Known scope (v0.2)

- One local user, one workspace, one host writer, one generation at a time; at most 4 running code apps.
- Code apps: queries and commands only; no persistent timers, background side effects, external HTTP, files or
  devices; one record collection per app; services are read-only and one hop.
- UI is limited to the fixed Slot Tree components.
- os.sqlite uses `synchronous=FULL`; Pi's agent.sqlite uses `NORMAL` (the newest Pi commit can be lost on power
  failure; process crashes are recovered).
- The browser shell is the development window; Linux providers, the OS image and Wayland are later versions.
