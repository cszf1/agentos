# agentos-oci (spec §19.1, V1-U01/B04/M04): the approved OCI images of the catalog, built OFFLINE at release time
# from fixed inputs, so a device never downloads a base image or npm package.
#  - base: the catalog's base image at its exact platform-manifest digest, fetched once as a fixed-output `dir:`
#    copy (manifest bytes kept, so containers-storage records the same digest the recipes name).
#  - npm: one fixed-output npm cache per overlay lockfile (fetchNpmDeps, integrity-checked by npm).
#  - images: in a build VM, rootful Podman runs `podman build` on the SAME recipe contexts the Host would send
#    (scripts/release-image-contexts.mjs checks every recipe hash against the catalog) with --network=none; npm
#    reads only the fixed cache. All images go into one multi-image docker-archive (shared base layers) plus an
#    index that the Host's driver reads before it would build.
{ lib, pkgs, vmTools, nodejs_24, agentos-node, src, platform ? "linux/amd64" }:
let
  base = {
    reference = "docker.io/library/node";
    digest = "sha256:e1582112fb9f152ed38eefcd712efc93fee1becb519fdfa57574d5e07eaa5e7d"; # node:24.22.1-bookworm-slim amd64
  };
  baseDir = pkgs.runCommand "oci-base-node-24.22.1-amd64" {
    nativeBuildInputs = [ pkgs.skopeo ];
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-bUYu8G7rkGXwmvRsnMcHe+YqXHkcjoDTCXjrFuKj/Wg=";
    SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
    impureEnvVars = lib.fetchers.proxyImpureEnvVars;
  } ''
    skopeo --insecure-policy --tmpdir=$TMPDIR copy --preserve-digests --override-os linux --override-arch amd64 \
      docker://${base.reference}@${base.digest} dir:$out
    test "sha256:$(sha256sum $out/manifest.json | cut -d' ' -f1)" = "${base.digest}"
    rm -f $out/version.tmp
  '';
  overlays = {
    "core-v1/builder" = "sha256-kul08C8+oM93TgJSGO2RQ3rKKfaOSv9Ty57ZH/m9xvM=";
    "core-v1/runtime" = null; # no dependencies: npm ci needs no cache
    "data-v1/builder" = "sha256-FNJ3Chu2HJ53ndV0cwf2yG1UzP+nX5K9jHFis+bZYS8=";
    "data-v1/runtime" = "sha256-o7u5N7m9hjix0pFDHswnIJh+tQnKtI+FaDBxQtuUZHs=";
    "core-v2/builder" = "sha256-B/5nB2yyisAD4S4iFBVda4lZiBTNhCGHp59FPUsbdr8=";
    "core-v2/runtime" = null; # no dependencies: npm ci needs no cache
    "data-v2/builder" = "sha256-ZUSCyeGKEgvWYapyz6ADPjzzpS/hbNFPm9dbrLeiKyU=";
    "data-v2/runtime" = "sha256-sQeNM7ESUaQR5uqwdtJEmD0eWiiLZ6wMNOc/TugkvDc=";
  };
  emptyCache = pkgs.runCommand "npm-cache-empty" { } "mkdir -p $out/_cacache";
  npmCache = o: hash: if hash == null then emptyCache else pkgs.fetchNpmDeps {
    name = "npm-cache-${builtins.replaceStrings [ "/" ] [ "-" ] o}";
    src = "${src}/runtime/overlays/${o}";
    inherit hash;
  };
  caches = lib.mapAttrs npmCache overlays;
  contexts = pkgs.runCommand "agentos-oci-contexts" { nativeBuildInputs = [ nodejs_24 ]; } ''
    mkdir -p $out
    node ${src}/scripts/release-image-contexts.mjs ${agentos-node}/lib/agentos ${platform} $out > $out/list.json
  '';
  cacheMap = pkgs.writeText "npm-caches.json" (builtins.toJSON caches);
  vm = vmTools.override { rootModules = [ "virtio_pci" "virtio_mmio" "virtio_blk" "virtio_balloon" "virtio_rng" "ext4" "virtiofs" "crc32c" "overlay" "veth" ]; };
  podmanConf = pkgs.writeText "containers.conf" ''
    [engine]
    cgroup_manager = "cgroupfs"
    events_logger = "none"
    [network]
    default_rootless_network_cmd = "slirp4netns"
  '';
  policy = pkgs.writeText "policy.json" ''{"default":[{"type":"insecureAcceptAnything"}]}'';
  storageConf = pkgs.writeText "storage.conf" ''
    [storage]
    driver = "vfs"
    graphroot = "/tmp/oci/graph"
    runroot = "/tmp/oci/run"
  '';
in
vm.runInLinuxVM (pkgs.runCommand "agentos-oci" {
  memSize = 4096;
  preVM = ''
    mkdir -p $out
    diskImage=$out/scratch.qcow2
    ${pkgs.qemu-utils}/bin/qemu-img create -f qcow2 $diskImage 24G
  '';
  postVM = "rm -f $out/scratch.qcow2";
  nativeBuildInputs = [ pkgs.podman pkgs.skopeo pkgs.jq pkgs.coreutils pkgs.util-linux pkgs.crun pkgs.conmon pkgs.iptables pkgs.netavark pkgs.aardvark-dns ];
  passthru = { inherit baseDir caches contexts base; };
} ''
  set -euo pipefail
  mkdir -p /etc/containers /tmp/oci /run /var/tmp /sys/fs/cgroup /dev/shm /dev/pts
  # the build VM has no init: give the OCI runtime what systemd would have mounted
  mountpoint -q /sys/fs/cgroup || mount -t cgroup2 cgroup2 /sys/fs/cgroup
  mountpoint -q /dev/shm || mount -t tmpfs -o mode=1777 tmpfs /dev/shm
  mountpoint -q /dev/pts || mount -t devpts -o mode=620,ptmxmode=666 devpts /dev/pts
  echo "+cpu +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control || true
  cp ${podmanConf} /etc/containers/containers.conf
  cp ${policy} /etc/containers/policy.json
  cp ${storageConf} /etc/containers/storage.conf
  echo 'unqualified-search-registries = []' > /etc/containers/registries.conf
  ${pkgs.e2fsprogs}/bin/mkfs.ext4 -q /dev/vda
  mount /dev/vda /tmp/oci
  export TMPDIR=/var/tmp CONTAINERS_CONF=/etc/containers/containers.conf
  P="podman --runtime ${pkgs.crun}/bin/crun --conmon ${pkgs.conmon}/bin/conmon --cgroup-manager cgroupfs --events-backend none"
  # base image under its digested name, so FROM <reference>@<digest> resolves locally (pull policy never)
  skopeo --insecure-policy copy --preserve-digests dir:${baseDir} containers-storage:${base.reference}@${base.digest}
  $P image inspect ${base.reference}@${base.digest} --format '{{.Digest}}' | grep -qx '${base.digest}'
  names=()
  i=0
  while [ -f ${contexts}/$i/meta.json ]; do
    m=${contexts}/$i/meta.json
    name=$(jq -r .name $m); overlay=$(jq -r .overlay $m)
    cache=$(jq -r --arg o "$overlay" '.[$o]' ${cacheMap})
    rm -rf /tmp/oci/npm && cp -r "$cache" /tmp/oci/npm && chmod -R u+w /tmp/oci/npm
    printf 'cache=/npmcache\noffline=true\naudit=false\nfund=false\nupdate-notifier=false\n' > /tmp/oci/npmrc
    labels=$(jq -r '.labels | to_entries[] | "--label=\(.key)=\(.value)"' $m)
    # --timestamp 0: image config "created" and every layer file mtime fixed, so two clean builds give the same archive
    # (build-repro run 41116526465 found images.tar differing between two builds of the same inputs).
    # The Nix builder exports SOURCE_DATE_EPOCH and Podman refuses it together with --timestamp
    # ("timestamp and source-date-epoch would be ambiguous", m5/m12 run 41124923054 build VM panic), so drop it here.
    env -u SOURCE_DATE_EPOCH $P build --network=none --pull=never --layers=false --rm --force-rm --timestamp 0 \
      --build-arg BASE="$(jq -r .base $m)" $labels -t "$name" \
      -v /tmp/oci/npm:/npmcache:rw -v /tmp/oci/npmrc:/usr/local/etc/npmrc:ro \
      -f ${contexts}/$i/Containerfile ${contexts}/$i
    test "$($P image inspect "$name" --format '{{index .Labels "agentos.recipe"}}')" = "$(jq -r .recipeHash $m)"
    names+=("$name")
    i=$((i+1))
  done
  test "$i" -gt 0
  $P save --format docker-archive -m -o $out/images.tar "''${names[@]}"
  for n in "''${names[@]}"; do $P image inspect "$n" --format '{{.Id}}'; done > $out/ids.txt
  jq -n --slurpfile imgs ${contexts}/images.json --rawfile ids $out/ids.txt \
    '{formatVersion: 1, archive: "images.tar", platform: "${platform}", base: "${base.reference}@${base.digest}",
      images: [ range(0; $imgs[0]|length) as $k | $imgs[0][$k] + {imageId: ("sha256:" + (($ids|split("\n"))[$k]))} ]}' > $out/index.json
  (cd $out && sha256sum images.tar > images.tar.sha256)
  rm $out/ids.txt
'')
