# v0.4 fixtures (spec §25)

The v0.4 scenarios are built by the tests themselves from the v0.1–v0.3 fixtures plus deterministic faux-model
behaviour, so each one is reproducible without a model. Where each scenario lives:

| Scenario | Source |
|---|---|
| Two apps generated concurrently | `tests/agents/v4-agents.test.ts` (S01–S05, faux `[faux:slow:N]` timing), `scripts/smoke-v04-real.mjs` (real model) |
| Failing service / crash-looping app | `deploy/v0.4/agentos-system-admin` demo units `agentos-demo.service`, `agentos-demo2.service` (test installs); `tests/sandbox/v04-offline-real.test.ts` (real container killed until degraded) |
| Optimisation candidate | `packages/agent-pi/src/faux.ts` maintenance-refactor flow over `fixtures/v0.2/todo-kanban`; checked on the platform preview fixtures (`preview-fixtures-v1`) |
| Long context for compaction | `AGENTOS_TEST_FAUX_CONTEXT` / `AGENTOS_COMPACTION_KEEP_RECENT_TOKENS` with real task conversations (`tests/compaction/`, `tests/integration/http.test.ts`) |
| GC racing builds / backups / pins | `tests/gc-online/` (staging owners, pins, delete intents, batch limits) |
| Real v0.3 workspace | `scripts/make-v03-workspace.mjs` (made with the real v0.3 build), `tests/recovery/v04-upgrade.test.ts` |
