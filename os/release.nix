# agentos-release (spec §19.1, §20.1): the UNSIGNED ReleaseManifest for the base system closure, the closure's
# content hashes (NAR sha256 of every store path), an SBOM of the closure, and checksums. Signing happens in the
# release environment with the private key; no key is part of this build or repository.
{ pkgs, toplevel, oci ? null, rev, lastModified, nixpkgsRev, flakeLockHash, version ? "1.0.0" }:
let
  info = pkgs.closureInfo { rootPaths = [ toplevel ]; };
in
pkgs.runCommand "agentos-release-${version}" { nativeBuildInputs = [ pkgs.python3 ]; } ''
  mkdir -p $out
  python3 ${./release.py} ${info}/registration ${toplevel} '${rev}' ${toString lastModified} '${nixpkgsRev}' '${flakeLockHash}' '${version}' \
    ${toplevel}/kernel ${toplevel}/initrd "$(cat ${toplevel}/kernel-version 2>/dev/null || basename $(readlink -f ${toplevel}/kernel))" $out ${if oci == null then "" else "${oci}/index.json"}
''
