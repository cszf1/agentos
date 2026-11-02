# agentos-vdi, agentos-vmdk, agentos-vhdx: the agentos-qcow2 template disk converted for VirtualBox, VMware and
# Hyper-V. The content is the qcow2's, block for block (agentos-vm-images proves it), so first boot still runs
# agentos-disk-rekey: operator passphrase, fresh volume key, growth to the whole disk. Each format stores only the
# blocks the template wrote, so the files stay far below the 64 GiB nominal size.
{ runCommand, qemu, qcow2, format }:
let
  options = {
    vdi = "static=off";
    vmdk = "subformat=streamOptimized,adapter_type=lsilogic";
    vhdx = "subformat=dynamic";
  }.${format};
in
runCommand "agentos-${format}" { nativeBuildInputs = [ qemu ]; } ''
  mkdir -p $out
  qemu-img convert -f qcow2 -O ${format} -o ${options} ${qcow2}/agentos.qcow2 $out/agentos.${format}
  (cd $out && sha256sum agentos.${format} > SHA256SUMS)
''
