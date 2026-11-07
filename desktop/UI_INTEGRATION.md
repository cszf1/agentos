# Native QML UI integration

## Desktop structure

The Shell is a desktop, not a settings console. Principles: minimal, quiet and
restrained; warm neutrals, one ink accent, solid fills, no decoration that does not
carry state.

- **Top bar** (`TopBar.qml`): workspace selector (`workspaceSwitcher`, borderless)
  on the left, date and time in the centre, and on the right a health chip that
  only appears when something is wrong (`healthChip`), notifications (`bell`) and
  the control centre (`controlCenterButton`: appearance, scale, lock, settings,
  model). The right-most 20 px stay empty (the VM checks' focus click).
- **Desktop** (`HomePage.qml`): greeting, the composer (`intentInput`,
  `intentTarget`, `intentSubmit`), "connect a model" when none is available
  (`configureModel`), the run in progress, app tiles (`card:<appId>`; a tile opens
  the app, `cardMenu:<appId>` holds widget / pin / move / width) and live widgets
  (expanded cards render the real `AppViewModel`).
- **Dock** (`Dock.qml`): four places, `nav:home` 桌面, `nav:app` 应用, `nav:tasks`
  任务, `nav:settings` 设置. Its geometry is read by the VM pixel checks
  (`os/tests` `dock()`, regression `test_navigation_pixels.py`): white box, 1 px
  border, 6 px padding, 44 px places 4 px apart, current place filled `#EAEAE7`.
  Change both together.
- **Settings** (`SettingsPage.qml`): every system page in one window, entries
  `nav:<page>` for model, workspaces, login, proposals, policies, incidents,
  hardware, update, backup and diagnostics. `currentPage` keeps the old page ids.
- **Model** (`ModelPage.qml`, new): what the workspace Host runs
  (`ShellController.modelInfo`, from `/api/state` `model` and `agentDiagnostic`,
  never a key) and a form for an OpenAI-compatible endpoint. Saving sends the
  machine action `workspaces.modelCredential.set` with the key only in the plan's
  `secret` field (as Wi-Fi), through the trusted confirmation; machined writes the
  workspace's `model.env` (0600, outside `data/`) and restarts its Host. Owner only.

Icons are tinted from alpha masks in `icons-src/` by `icons-src/gen.py` into
`qml/icons/<name>_<tone>[_dark].png` (light and dark palettes, see `Theme.iconSource`).

## Origin

The supplied `agentos-ui-integration-candidate.zip` supplied the first page layouts,
Theme singleton, Chinese strings and raster icons. `shell.cmake` embeds all of
these in `/agentos/qml/`; no filesystem or data-URL loading is needed. The archive
contains no font binaries. The existing Nix package supplies Noto Sans CJK SC and
DejaVu Sans Mono through fontconfig; Theme uses those family names.

## Backend and behavior

`app/`, `models/`, `renderer/` and `transport/` C++ interfaces are unchanged. Main
uses the existing `shell` context property. Native Qt controls retain their type,
object names, keyboard handling and IME commit/discard behavior. Pages load only
while active. Slot/records rendering, URL restrictions and clipping stay native;
colors follow Theme, and List delegates charge/release their actual template cost
rather than an uninitialized readonly binding during delegate completion.

Workspace roles remain viewer/editor/owner. Machine account types user/admin are
separate from workspace roles. Trusted system confirmation starts on Cancel;
Enter cancels there and never accepts on the password or accept control. The
administrator enters their own password inside that layer. Password entry and
actions stay outside scrolling plan details. Application questions stay ordinary
dialogs below the trusted layer. Red actions retain the existing second-click
confirmation dialog; page/scope changes withdraw it.

Hardware reads session-agent audio/output state, uses `audio.volume.set`,
`audio.mute.set`, `display.mode.set`, the display keep/revert countdown, and
`power.poweroff`. Battery, owner background policy, Wi-Fi one-request secrets and
administrator account management remain available. There is no brightness
control, MultiEffect, ShaderEffect or blur.

## Missing backend data

No new backend property is required for the integrated functional pages. The
original mock-only data (`devListState`, `devOutcomeMode`, `triggerDemo*`, fake
app counts, pseudo-TPM actions, `currentGeneration`, `hasUpdate`) is not exported
by ShellController and is removed. Release/update, hardware and operational
status come from existing maps/models; unavailable capabilities are labelled
unavailable. There is no MockShell or fabricated release version.

## Validation

Build with Qt 6.5 or newer, including the VM-only native driver when required:

```sh
cmake -S desktop -B desktop/build -GNinja -DAGENTOS_E2E=ON
cmake --build desktop/build
ctest --test-dir desktop/build --output-on-failure
```

The existing desktop assertions are retained. The 1280×800 regression checks
the four dock places and every Settings entry, a long administrator plan, password
clearing and Enter behavior. The m5/m19/m20 pixel helpers find the dock and its
current place, retaining real clicks, page-state checks, zoom and lock assertions.
Their helper regression also checks that top-bar controls and the hover tint cannot
be mistaken for the dock or its current place.

Run software-rendered Wayland checks under Sway at 1280×800. KVM checks run only
in GitHub Actions, against the pushed main commit:

```sh
gh workflow run v1-vm-tests.yml -R cszf1/agentos --ref main -f test=all
```

The workflow has 31 jobs: plan plus the 30 checks in ALL. Retry only individual jobs affected by
cache HTTP 418/416/429; retain the successful jobs. The workflow run is the source
of VM results; local screenshots alone are not KVM evidence.
