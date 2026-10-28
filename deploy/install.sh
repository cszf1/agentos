#!/usr/bin/env bash
# Install AgentOS v0.1 as a systemd user service for the current user.
#   deploy/install.sh            # build, write env file if missing, enable + start the user unit
# The checkout is expected at ~/agentos (or set AGENTOS_SRC). Node 24 must be on PATH or in AGENTOS_NODE.
set -euo pipefail
SRC="${AGENTOS_SRC:-$HOME/agentos}"
cd "$SRC"
NODE_BIN="${AGENTOS_NODE:-$(command -v node)}"
"$NODE_BIN" --version | grep -q '^v24\.' || { echo "Node 24 required (found $("$NODE_BIN" --version))" >&2; exit 1; }
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile
pnpm build
mkdir -p "$HOME/.config/agentos" "$HOME/.config/systemd/user"
chmod 700 "$HOME/.config/agentos"
if [[ ! -f "$HOME/.config/agentos/agentos.env" ]]; then
  {
    echo "AGENTOS_DATA_DIR=$HOME/.local/share/agentos"
    echo "AGENTOS_HOST=127.0.0.1"
    echo "AGENTOS_PORT=4317"
    echo "AGENTOS_NODE=$NODE_BIN"
    echo "AGENTOS_MODEL_MODE=real"
    echo "AGENTOS_MODEL_PROVIDER="
    echo "AGENTOS_MODEL_ID="
    echo "AGENTOS_LOG_LEVEL=info"
  } > "$HOME/.config/agentos/agentos.env"
fi
chmod 600 "$HOME/.config/agentos/agentos.env"
sed "s#%h/agentos#$SRC#g" deploy/agentos-host.service > "$HOME/.config/systemd/user/agentos-host.service"
systemctl --user daemon-reload
systemctl --user enable --now agentos-host
systemctl --user --no-pager status agentos-host | head -5
echo "Login token: $(grep AGENTOS_DATA_DIR "$HOME/.config/agentos/agentos.env" | cut -d= -f2)/auth-token"
