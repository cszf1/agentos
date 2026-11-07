<#
.SYNOPSIS
  Start AgentOS from its ready-installed disk (agentos.qcow2) in QEMU with Windows Hypervisor Platform (WHPX).

.DESCRIPTION
  Nothing is installed: the disk already holds the whole system. On the very first boot AgentOS asks for one
  password (twice, on the VM's screen); it unlocks the disk at every boot and signs you in as "admin".
  The first time, this script makes a writable copy of the UEFI variables next to the disk; later runs reuse it.

  Needs: QEMU for Windows (https://qemu.weilnetz.de/w64/), and in "Turn Windows features on or off":
  "Windows Hypervisor Platform" (a reboot after enabling it). Without WHPX it falls back to TCG (very slow).

.EXAMPLE
  .\Start-AgentOS.ps1 -Disk D:\VMs\agentos.qcow2
  .\Start-AgentOS.ps1 -Disk .\agentos.qcow2 -MemoryMB 8192 -Cpus 4
#>
param(
  [string]$Disk = (Join-Path $PSScriptRoot "agentos.qcow2"),
  [string]$QemuDir = "C:\Program Files\qemu",
  [int]$MemoryMB = 6144,
  [int]$Cpus = 2,
  [switch]$NoWhpx
)
$ErrorActionPreference = "Stop"

$qemu = Join-Path $QemuDir "qemu-system-x86_64.exe"
if (-not (Test-Path $qemu)) { throw "QEMU not found at $qemu (install QEMU for Windows or pass -QemuDir)" }
if (-not (Test-Path $Disk)) { throw "disk not found: $Disk (download agentos.qcow2 first)" }
if ($MemoryMB -lt 3072) { throw "AgentOS needs at least 3072 MiB of memory" }
if ($Cpus -lt 2) { throw "AgentOS needs at least 2 vCPUs" }

# UEFI firmware shipped with QEMU for Windows; the variables file must be a writable copy per VM
$code = Join-Path $QemuDir "share\edk2-x86_64-code.fd"
$varsTemplate = Join-Path $QemuDir "share\edk2-i386-vars.fd"
foreach ($f in @($code, $varsTemplate)) { if (-not (Test-Path $f)) { throw "UEFI firmware not found: $f" } }
$diskFull = (Resolve-Path $Disk).Path
$vars = [IO.Path]::ChangeExtension($diskFull, ".uefi-vars.fd")
if (-not (Test-Path $vars)) { Copy-Item $varsTemplate $vars }

$accel = if ($NoWhpx) { @("-accel", "tcg") } else { @("-accel", "whpx,kernel-irqchip=off", "-accel", "tcg") }
$qemuArgs = @(
  "-name", "AgentOS",
  "-machine", "q35"
) + $accel + @(
  "-m", "$MemoryMB", "-smp", "$Cpus",
  "-drive", "if=pflash,format=raw,unit=0,readonly=on,file=$code",
  "-drive", "if=pflash,format=raw,unit=1,file=$vars",
  "-drive", "file=$diskFull,if=virtio,format=qcow2,discard=unmap",
  "-vga", "none", "-device", "virtio-gpu-pci",      # 3D off: AgentOS renders on the CPU
  "-display", "sdl",
  "-device", "qemu-xhci", "-device", "usb-tablet",  # an absolute pointer that follows the host mouse
  "-nic", "user,model=virtio-net-pci",
  "-device", "virtio-rng-pci"
)
Write-Host "Starting AgentOS ($MemoryMB MiB, $Cpus vCPU) from $diskFull"
Write-Host "First boot: choose a password when asked (twice). Then sign in as 'admin'."
& $qemu @qemuArgs
