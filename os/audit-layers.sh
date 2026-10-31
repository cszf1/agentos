#!/usr/bin/env bash
# Review F16: the release audit in four separately recorded layers (run from the repository root on a full clone):
#   1 closure  - file-level audit of the formal release closure (agentos-audit report.json, V1-B08)
#   2 history  - gitleaks over every commit object of every ref (git log --all), reviewed exceptions in .gitleaksignore
#   3 deps     - known-vulnerability review: pnpm audit (Node lockfile) and cargo audit (RustSec, native/Cargo.lock)
#   4 sigs     - release signature state: keyId of the built manifest; an unsigned candidate is reported as unsigned
#                (signing happens in the release environment), and verification is exercised with an ephemeral key
# Usage: os/audit-layers.sh <agentos-audit out> <agentos-release out> <outdir>. Writes <outdir>/audit-layers.json.
# Exit 1 when layer 1 or 2 has a finding or signature verification misbehaves; layer 3 is a review record (its
# advisories are listed, not hidden) and does not fail the job by itself.
set -uo pipefail
AUDIT=$1 REL=$2 OUT=$3
mkdir -p "$OUT"
fail=0

# 1 closure
c_ok=$(jq -r .ok "$AUDIT/report.json"); c_n=$(jq '.findings | length' "$AUDIT/report.json")
[ "$c_ok" = true ] || fail=1

# 2 history
commits=$(git rev-list --all --count)
gitleaks git --log-opts="--all" --report-format json --report-path "$OUT/gitleaks.json" --no-banner --exit-code 0 . >"$OUT/gitleaks.log" 2>&1
h_rc=$?
h_n=$(jq 'length' "$OUT/gitleaks.json" 2>/dev/null || echo -1)
[ "$h_rc" = 0 ] && [ "$h_n" = 0 ] || fail=1

# 3 deps (needs network for the advisory databases)
pnpm audit --prod --json >"$OUT/pnpm-audit.json" 2>"$OUT/pnpm-audit.err"; p_rc=$?
p_sum=$(jq -c '.metadata.vulnerabilities // {}' "$OUT/pnpm-audit.json" 2>/dev/null || echo '{"error":"no report"}')
p_list=$(jq -c '[.advisories // {} | to_entries[] | {module: .value.module_name, severity: .value.severity, id: .value.github_advisory_id, title: .value.title}]' "$OUT/pnpm-audit.json" 2>/dev/null || echo '[]')
cargo-audit audit -f native/Cargo.lock --json >"$OUT/cargo-audit.json" 2>"$OUT/cargo-audit.err"; r_rc=$?
r_n=$(jq '.vulnerabilities.count // -1' "$OUT/cargo-audit.json" 2>/dev/null || echo -1)
r_list=$(jq -c '[.vulnerabilities.list[]? | {crate: .package.name, version: .package.version, id: .advisory.id, title: .advisory.title}]' "$OUT/cargo-audit.json" 2>/dev/null || echo '[]')
r_warn=$(jq -c '[.warnings // {} | to_entries[] | {kind: .key, n: (.value | length)}]' "$OUT/cargo-audit.json" 2>/dev/null || echo '[]')

# 4 signatures
keyid=$(jq -r .keyId "$REL/manifest.json")
T=$(mktemp -d)
openssl genpkey -algorithm ed25519 -out "$T/k" 2>/dev/null && openssl pkey -in "$T/k" -pubout -out "$T/k.pub" 2>/dev/null
openssl pkeyutl -sign -inkey "$T/k" -rawin -in "$REL/manifest.json" -out "$T/sig" 2>/dev/null
good=$(openssl pkeyutl -verify -pubin -inkey "$T/k.pub" -rawin -in "$REL/manifest.json" -sigfile "$T/sig" >/dev/null 2>&1 && echo yes || echo no)
sed 's/"releaseSequence":/"releaseSequence":1/' "$REL/manifest.json" >"$T/m2"   # one changed byte sequence
bad=$(openssl pkeyutl -verify -pubin -inkey "$T/k.pub" -rawin -in "$T/m2" -sigfile "$T/sig" >/dev/null 2>&1 && echo accepted || echo refused)
rm -rf "$T"
[ "$good" = yes ] && [ "$bad" = refused ] || fail=1
sums=$(cd "$REL" && sha256sum -c SHA256SUMS >/dev/null 2>&1 && echo ok || echo mismatch)
[ "$sums" = ok ] || fail=1

jq -n --arg sha "$(git rev-parse HEAD)" --argjson c_n "$c_n" --arg c_ok "$c_ok" --argjson commits "$commits" --argjson h_n "$h_n" --argjson h_rc "$h_rc" \
  --argjson p_rc "$p_rc" --argjson p_sum "$p_sum" --argjson p_list "$p_list" --argjson r_rc "$r_rc" --argjson r_n "$r_n" --argjson r_list "$r_list" --argjson r_warn "$r_warn" \
  --arg keyid "$keyid" --arg good "$good" --arg bad "$bad" --arg sums "$sums" --argjson fail "$fail" '{
  commit: $sha, ok: ($fail == 0),
  closure: {ok: ($c_ok == "true"), findings: $c_n, report: "agentos-audit/report.json"},
  history: {tool: "gitleaks", scope: "git log --all", commitsScanned: $commits, findings: $h_n, exit: $h_rc, exceptions: ".gitleaksignore"},
  dependencies: {node: {tool: "pnpm audit --prod", exit: $p_rc, summary: $p_sum, advisories: $p_list}, rust: {tool: "cargo audit (RustSec)", exit: $r_rc, vulnerabilities: $r_n, list: $r_list, warnings: $r_warn}},
  signatures: {manifestKeyId: $keyid, signed: ($keyid != "unsigned"), note: "signing happens in the release environment; the candidate is unsigned", ephemeralKeyVerify: $good, tamperedManifest: $bad, sha256sums: $sums}
}' | tee "$OUT/audit-layers.json"
exit $fail
