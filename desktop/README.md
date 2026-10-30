# agentos-shell — native Qt 6 Shell (AgentOS v1.0)

The Shell is a Qt Quick application without any browser engine (no WebEngine/WebView; `no_webengine` ctest
inspects the binary). It talks only to the session gateway over `native-rpc/1` (spec §9.2) and renders apps
from their bundles with a fixed, data-only renderer (spec §10). Pages follow spec §11/§12.

```
desktop/
  transport/  jvalue (JSON value, strict parser), frame_codec (4-byte BE length + UTF-8 JSON, ≤4 MiB),
              rpc_client (worker-thread UDS client: ≤32 in flight, idempotent queue, retry by requestId,
              30 s → status query by requestId, per-workspace eventSeq cursor, EVENT_GAP, bounded UI backlog),
              native_rpc (canonical JSON / domain hash vectors shared with Rust/TS)
  renderer/   json_schema + slot_validator (C++ port of checkSlotTree), slot_runtime (bindings, visibleWhen,
              forms, selection, commands, render snapshot), records_view (formatVersion 1), shell_actions
              (route-ID request builders = packages/contracts shell actions), error_policy (53 codes),
              routes (native/write/forward routes), app_view (per-app view model), chart_item (QPainter charts)
              slot-schemas.json / error-policy.json / routes.json are embedded copies, checked against
              fixtures/v1.0/slot-vectors by the slot_vectors test.
  models/     JsonListModel, SlotItem/SlotTableModel/SlotListModel (stable QObject tree), InstanceBudget (4096),
              CanvasModel (appId/position/size/versioned prefs only; ≤4 expanded)
  app/        ShellController (single state owner), qml_guard (URL interceptor, no network, no disk cache),
              ime_guard (preedit commit/discard), health_canvas, main.cpp
  qml/        fixed QML compiled into qrc (:/agentos/qml); never loads QML/JS/URLs/HTML/CSS/paths from data
  tests/      QTest suites + fake native-rpc/1 peer; screenshots in tests/out/
```

## Build and test

```
nix-shell desktop/shell.nix --run 'cmake -S desktop -B desktop/build -G Ninja && ninja -C desktop/build && \
  (cd desktop/build && ctest --output-on-failure)'
nix-build desktop -A package          # builds with cmake, runs ctest in checkPhase
```

The nixpkgs pin is the one in `os/flake.nix` (6f06d204d8f2d8761d9da78778745974a3216381). Tests run under
`QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software`.

| ctest | covers |
|---|---|
| v1_vectors | canonical JSON / domain hash / frame vectors (fixtures/v1.0/protocol) |
| slot_vectors | semantic vectors from `scripts/slot-vectors.mjs` (TS contracts): validation verdicts, pointers, text/number rules, scenarios (bindings, forms, clicks, requests, notices, busy, version switch), records view, shell actions, error policy |
| transport_test | framing, 4 MiB both directions, 32 in flight, slow reader, reconnect + retry by requestId, 30 s status query (shortened), reply scope check, write needs key |
| events_test | cursor, duplicates, gap → full re-read, `EVENT_GAP` reply, `event.gap`, reconnect resubscribe from cursor, slow UI reader bounded without losing revocations, acks |
| gui_test | offscreen render of every fixture (+ PNGs), records/unsupported/invalid bundles, injection as plain text, URL guard, Accessible names, List budget/lazy creation, chart limits, Tab/focus/zoom, IME preedit, trusted confirmation layer, lock clearing |
| flows_test | whole Shell against a scripted socket peer: every page, D08 actions to reconciled state, machine plan → trusted confirmation → confirm, display 15 s revert, stale plan, SystemActionButton plan only, lock, workspace switch drops late replies, degraded Host/model/broker/disconnect, EVENT_GAP snapshot-then-subscribe, layout privacy |
| health_canvas | `agentos-shell --health-canvas` frame + keyboard input, exit 0 |
| first_frame_within_5s | `agentos-shell --first-frame-probe` without a gateway |
| no_webengine | binary/link check |

## Runtime

* `AGENTOS_GATEWAY_SOCKET` (default `/run/agentos/gateway.sock`).
* `QT_IM_MODULE=fcitx` from the trusted session for Chinese input; the Shell commits an uncommitted
  composition into its own field on focus change and discards it on workspace switch / lock / logout.
* `agentos-shell --health-canvas`: fixed canvas, no gateway, no user data; prints one JSON line and exits 0 when a
  non-blank frame was rendered and synthetic key input reached the field.
* `--first-frame-probe` prints the time to the first frame and exits (restart ≤ 5 s check).

## Wire shapes the Shell relies on

Requests: `{requestId, workspaceId, clientEpoch, sessionEpoch, methodId, params, body, idempotencyKey?}`; machine-level
calls before a workspace is attached use workspaceId `00000000-0000-0000-0000-000000000000`. Responses echo
`requestId/workspaceId/clientEpoch` (a mismatch is dropped) with `status` and `body` or `error:{code,message}`.
Events are `{workspaceId, eventSeq, type, data}`. Reply bodies read by the Shell: `session.bind/status`
`{userId,userName,role,sessionEpoch,locked}`, `workspaces.attach` `{clientEpoch,storeUUID,cursor}`,
`events.subscribe` `{cursor}`, `machine.status` `{release,components:{host,model,broker},setup}`,
`machine.capabilities` `{hardware:{network,audio,brightness,battery,time,display,power,session:{available,…}}}`,
`machine.actions.plan` `{operationId,planHash,ticket,state,summary:{resource,effect,version,permissionChange}}`.
These follow spec §16.1; where the gateway returns other field names the mapping lives in
`app/shell_controller.cpp` only.
