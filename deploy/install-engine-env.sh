#!/usr/bin/env bash
# Install the podman.service drop-in that starts the rootless engine through deploy/podman-clean-env
# (CVE-2026-57231 hardening). Idempotent; safe to re-run. Undo: rm the drop-in and the wrapper, daemon-reload.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
LIBEXEC="$HOME/.local/libexec/agentos"
DROPIN="$HOME/.config/systemd/user/podman.service.d"
install -d -m 700 "$LIBEXEC"
install -m 755 "$SRC/deploy/podman-clean-env" "$LIBEXEC/podman-clean-env"
install -d "$DROPIN"
cat > "$DROPIN/10-agentos-clean-env.conf" <<UNIT
# Installed by AgentOS deploy/install-engine-env.sh (CVE-2026-57231): allowlisted engine environment.
[Service]
ExecStart=
ExecStart=$LIBEXEC/podman-clean-env
UNIT
systemctl --user daemon-reload
# The service is socket-activated; stop the running instance so the next API call starts the wrapped one.
systemctl --user stop podman.service 2>/dev/null || true
systemctl --user enable --now podman.socket >/dev/null
echo "podman.service now starts via $LIBEXEC/podman-clean-env"
