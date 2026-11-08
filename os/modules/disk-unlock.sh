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
valid_account_password() {
  [ -n "$1" ] && [ "$(printf '%s' "$1" | wc -c)" -le 511 ] || return 1
  case "$1" in *$'\n'*) return 1 ;; esac
}
for i in 1 2 3 4 5; do
  a=$(systemd-ask-password --timeout=0 --no-tty "Please enter passphrase for disk AgentOS (maximum 511 UTF-8 bytes):") || continue
  valid_account_password "$a" || { a=""; echo "agentos: password must be 1..511 UTF-8 bytes without newline"; continue; }
  printf '%s' "$a" > "$key"
  a=""
  if cryptsetup open --test-passphrase --key-file="$key" "$dev" 2>/dev/null; then
    # Hand the password to first setup only on a quick-start disk (its LUKS label is set by the first-boot re-key).
    # A disk the installer wrote has no label and its administrator is created by hand on the console (m19-iso,
    # run 42451921917: the handoff made every installed graphical disk create "admin" with the disk password).
    dump=$(cryptsetup luksDump "$dev" 2>/dev/null || true)
    label=""
    case "$dump" in *Label:*) label=${dump#*Label:}; label=${label%%$'\n'*}; label=${label//[[:space:]]/} ;; esac
    case "$label" in agentos-rekey-*|agentos-luks) quick=1 ;; *) quick=0 ;; esac
    if [ "$quick" = 1 ] && [ -e /etc/agentos-first-setup-handoff ]; then
      install -d -m 0700 /run/agentos-first-setup
      cp "$key" "$handoff"
    fi
    ok=1
    exit 0
  fi
  echo "agentos: that passphrase does not open the disk"
done
exit 1
