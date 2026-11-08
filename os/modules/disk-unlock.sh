set -eu
umask 077
[ "$(findmnt -n -o FSTYPE --target /run)" = tmpfs ] || exit 1
dev=/dev/disk/by-partlabel/agentos-luks
key=/run/agentos-disk-unlock/key
handoff=/run/agentos-first-setup/password
install -d -m 0700 /run/agentos-disk-unlock
ok=0
trap '[ "$ok" = 1 ] || rm -f "$key" "$handoff"' EXIT
rm -f "$handoff"
if cryptsetup open --test-passphrase --key-file=/etc/agentos-template-disk.key "$dev" 2>/dev/null; then
  cp /etc/agentos-template-disk.key "$key"
  ok=1
  exit 0
fi
for i in 1 2 3 4 5; do
  a=$(systemd-ask-password --timeout=0 --no-tty "Please enter passphrase for disk AgentOS:") || continue
  printf '%s' "$a" > "$key"
  a=""
  if cryptsetup open --test-passphrase --key-file="$key" "$dev" 2>/dev/null; then
    if [ -e /etc/agentos-first-setup-handoff ]; then
      install -d -m 0700 /run/agentos-first-setup
      cp "$key" "$handoff"
    fi
    ok=1
    exit 0
  fi
  echo "agentos: that passphrase does not open the disk"
done
exit 1
