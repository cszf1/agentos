# Native QML UI integration

The supplied `agentos-ui-integration-candidate.zip` supplies the new page layouts,
Theme singleton, Chinese strings and 175 raster icons. `shell.cmake` embeds all of
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

The existing desktop assertions are retained. A new 1280×800 regression checks
all 12 navigation controls, a long administrator plan, password clearing and
Enter behavior. The m5/m19/m20 pixel helpers follow the new palette, navigation
rails and page order, retaining real clicks, page-state checks, all 12 controls,
zoom and lock assertions. Their helper regression also checks that toolbar
controls cannot be mistaken for navigation.

Run software-rendered Wayland checks under Sway at 1280×800. KVM checks run only
in GitHub Actions, against the pushed main commit:

```sh
gh workflow run v1-vm-tests.yml -R cszf1/agentos --ref main -f test=all
```

The workflow has 29 jobs including plan. Retry only individual jobs affected by
cache HTTP 418/416/429; retain the successful jobs. The workflow run is the source
of VM results; local screenshots alone are not KVM evidence.
