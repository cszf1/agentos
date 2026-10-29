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

__RESULTS__
