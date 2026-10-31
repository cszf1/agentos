# agentos-release (spec §19.1, §20.1): the UNSIGNED ReleaseManifest for the base system closure, the closure's
# content hashes (NAR sha256 of every store path), an SBOM of the closure, and checksums. Signing happens in the
# release environment with the private key; no key is part of this build or repository.
# releaseSequence (review R2-5): null = the source commit time (lastModified, seconds); the signing environment may set
# it explicitly. previousManifest: the last published manifest; the build refuses a sequence that is not above it.
{ pkgs, toplevel, oci ? null, rev, lastModified, nixpkgsRev, flakeLockHash, version ? "1.0.0", releaseSequence ? null, previousManifest ? null }:
let
  info = pkgs.closureInfo { rootPaths = [ toplevel ]; };
in
pkgs.runCommand "agentos-release-${version}" { nativeBuildInputs = [ pkgs.python3 ]; } ''
  mkdir -p $out
  ${pkgs.lib.optionalString (releaseSequence != null) "export AGENTOS_RELEASE_SEQUENCE=${toString releaseSequence}"}
  ${pkgs.lib.optionalString (previousManifest != null) "export AGENTOS_PREVIOUS_MANIFEST=${previousManifest}"}
  python3 ${./release.py} ${info}/registration ${toplevel} '${rev}' ${toString lastModified} '${nixpkgsRev}' '${flakeLockHash}' '${version}' \
    ${toplevel}/kernel ${toplevel}/initrd "$(cat ${toplevel}/kernel-version 2>/dev/null || basename $(readlink -f ${toplevel}/kernel))" $out ${if oci == null then "" else "${oci}/index.json"}
''
