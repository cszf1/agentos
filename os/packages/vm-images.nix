# agentos-vm-images: the three hypervisor images with one SHA256SUMS, built only if each image has the right format,
# the qcow2's nominal size (at least 64 GiB), passes `qemu-img check`, and converts back to a raw disk byte-identical
# to the raw disk converted from agentos-qcow2.
{ runCommand, qemu, jq, diffutils, qcow2, images }:
runCommand "agentos-vm-images" { nativeBuildInputs = [ qemu jq diffutils ]; } ''
  set -euo pipefail
  mkdir -p $out
  src=${qcow2}/agentos.qcow2
  size=$(qemu-img info --output=json "$src" | jq '."virtual-size"')
  test "$size" -ge $((64 * 1024 * 1024 * 1024))
  qemu-img convert -f qcow2 -O raw "$src" ref.raw
  verify() {
    local fmt=$1 dir=$2 f=$2/agentos.$1
    qemu-img info --output=json "$f" | tee info.json
    test "$(jq -r .format info.json)" = "$fmt"
    test "$(jq '."virtual-size"' info.json)" = "$size"
    qemu-img check -f "$fmt" "$f"
    qemu-img convert -f "$fmt" -O raw "$f" back.raw
    cmp ref.raw back.raw
    rm back.raw
    ln -s "$f" $out/agentos.$fmt
    cat "$dir/SHA256SUMS" >> $out/SHA256SUMS
    echo "$fmt ok: nominal $size bytes, file $(stat -c %s "$f") bytes, raw identical to agentos-qcow2" | tee -a $out/report.txt
  }
  verify vdi ${images.vdi}
  verify vmdk ${images.vmdk}
  verify vhdx ${images.vhdx}
''
