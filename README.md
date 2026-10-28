# AgentOS v0.1

A single-user application runtime for Linux. You describe an app in natural language; a Pi Durable agent
builds a **declarative AppBundle** through host tools; the host validates and activates it; a trusted React
renderer runs it; records live in local SQLite. Apps keep working without a model. Every app version is
immutable, you can switch back and forth, and data survives restarts and crashes.

The implementation follows [docs/AGENTOS_MVP_V0.1.md](docs/AGENTOS_MVP_V0.1.md) (M1–M4). Scope is v0.1 only:
no generated code, no app processes, no file/device writes, one record collection per app.

## Layout

```
packages/contracts   AppBundle schema, semantic + compatibility checks, canonical hash, DTOs, error codes
packages/core        os.sqlite migrations, AppService, RecordService, RunService/RunCoordinator,
                     capability gateway (principals, policy, idempotency receipts), system.info provider
packages/agent-pi    the only package importing Pi Durable: adapter, agentos-app-builder tools, prompt,
                     provider budget gate, faux builder model
packages/host        config, flock check, Fastify API + static shell, auth, startup/shutdown, backup/restore
packages/web         browser shell (React 19, Vite 7)
bin/                 agentos-host (flock --no-fork → node), agentos-admin (backup/restore under the same lock)
deploy/              systemd user unit and install script
tests/               integration (unit project), recovery (real processes + SIGKILL), e2e (Playwright)
fixtures/ docs/      todo-v1/v2 bundles, schema, spec
```

## Requirements

- Linux with systemd and util-linux `flock` (≥ 2.38, for `--no-fork`); data dir on a local filesystem
- Node.js **24.22.1** (`.node-version`), pnpm 10 (`corepack enable` or `npm i -g pnpm@10`)

## Install from a clean machine

```bash
git clone https://github.com/cszf1/agentos.git ~/agentos && cd ~/agentos
pnpm install --frozen-lockfile
pnpm build
deploy/install.sh              # writes ~/.config/agentos/agentos.env (0600), enables the user unit
loginctl enable-linger "$USER" # only if it must run without an open login session
```

Configuration (`~/.config/agentos/agentos.env`, see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `AGENTOS_DATA_DIR` | `~/.local/share/agentos` | os.sqlite, agent.sqlite, auth-token, logs (dir 0700) |
| `AGENTOS_HOST` / `AGENTOS_PORT` | `127.0.0.1` / `4317` | loopback only |
| `AGENTOS_MODEL_MODE` | `real` | `faux` = deterministic acceptance model (no network) |
| `AGENTOS_MODEL_PROVIDER` / `AGENTOS_MODEL_ID` | unset | a pi-ai provider id (`openai`, `anthropic`, `deepseek`, …) or `openai-compatible` |
| `AGENTOS_MODEL_BASE_URL` | – | only for `openai-compatible` |
| key | – | the provider's own variable (`OPENAI_API_KEY`, …) or `AGENTOS_MODEL_API_KEY` for `openai-compatible` |

Without provider/model the host still starts; apps work, generation shows "model unavailable". Nothing picks a
paid model for you.

## Daily use

```bash
systemctl --user status agentos-host
journalctl --user -u agentos-host -f        # also ~/.local/share/agentos/logs/host.log (10 MiB × 5)
systemctl --user restart agentos-host
systemctl --user stop agentos-host
cat ~/.local/share/agentos/auth-token        # one-time login token for the shell
```

Open `http://127.0.0.1:4317/` in a browser on the machine. From another computer keep the service on loopback
and forward the port: `ssh -L 4317:127.0.0.1:4317 user@host` (or `instabox port-forward <box> 4317`), then open
`http://localhost:4317/`.

In the shell: create an app ("做一个待办应用"), add records, select the app and modify it ("增加优先级和优先级筛选"),
switch versions in the right panel, cancel or retry a generation. Deleting a record is permanent; switching
versions never restores deleted records (restore a backup for that).

## Backup and restore (cold)

```bash
systemctl --user stop agentos-host
pnpm backup -- --output ~/agentos-backups/2026-10-28      # both databases + WAL + manifest with hashes
pnpm restore -- --backup ~/agentos-backups/2026-10-28     # saves the current set first, then restores
systemctl --user start agentos-host
```

Both commands take the same `host.lock`, so they refuse to run while the host runs. A restore rewinds the whole
workspace to the backup time, bumps the client epoch (old pages get 409/401) and rotates the auth token. An
interrupted restore leaves `restore-in-progress`; the host refuses to start until `pnpm restore` is re-run.

## Development and tests

```bash
pnpm dev               # tsc + host (through the lock script, data in .data/dev) + Vite on :5173
pnpm typecheck
pnpm test              # build + contracts/services/Pi adapter (faux, real Durable+SQLite)/HTTP integration
pnpm test:recovery     # real child processes, SIGKILL fault points, two-store reconciliation, backup/restore
pnpm test:e2e          # Playwright against the same-origin production build, faux mode
pnpm smoke:real        # E01: needs a configured real provider; prints provider/model/usage, exit code = result
```

Fault injection points exist only when `NODE_ENV=test` and `AGENTOS_FAULTS=1`.

## Known scope (v0.1)

- One local user, one workspace, one host writer, one generation at a time.
- Declarative record apps only (string/boolean/integer/enum fields, list/form/search/filters).
- Process-crash recovery is verified; Pi's agent.sqlite uses `synchronous=NORMAL` (the newest Pi commit can be lost
  on power failure), os.sqlite uses `FULL`.
- The browser shell is the development window; the OS image, Wayland session and further Linux providers are
  later versions.
