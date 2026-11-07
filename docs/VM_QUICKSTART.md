# 在虚拟机里使用 AgentOS（快速开始）

AgentOS 的虚拟机磁盘镜像是**已经装好的系统**：不用运行安装程序，配好虚拟机、挂上磁盘、开机，
第一次开机时只需**设置一个密码**（输入两次），之后就进入登录界面，用户名是 `admin`。

这个密码同时用于：每次开机解锁磁盘、登录、锁屏解锁和系统确认（管理员身份）。至少 8 个字符，请牢记，
忘记后无法找回磁盘里的数据。

## 1. 获取磁盘

| 虚拟机 | 文件 | 构建 |
|---|---|---|
| QEMU（含 Windows + WHPX） | `agentos.qcow2` | `nix build .#agentos-qcow2`，或 GitHub Actions `v1-vm-tests` 选 `build-qcow2` 并勾选 `upload_vm_image` |
| VirtualBox 7 | `agentos.vdi` | `nix build .#agentos-vdi` |
| VMware | `agentos.vmdk` | `nix build .#agentos-vmdk` |
| Hyper-V（第 2 代） | `agentos.vhdx` | `nix build .#agentos-vhdx` |

先用随附的 `SHA256SUMS` 校验文件。磁盘名义大小 64 GiB（实际只占已写入的部分）。

## 2. 配好虚拟机参数

| 项目 | 取值 |
|---|---|
| 固件 | **UEFI**，关闭安全启动（Secure Boot） |
| CPU / 内存 | 至少 2 核 / 3072 MiB，推荐 2–4 核 / 6144 MiB |
| 显卡 | 关闭 3D 加速（AgentOS 用 CPU 渲染） |
| 磁盘 | 上面那个文件作为**已有磁盘**挂上；想更大就先把虚拟磁盘扩容，首次开机会自动占满 |
| 网络 | NAT 即可 |

各虚拟机的控制器和显卡型号见 [OPERATIONS.md 的“Virtual machine settings”](OPERATIONS.md#virtual-machine-settings)。

### Windows + QEMU（WHPX）一条命令

1. 安装 [QEMU for Windows](https://qemu.weilnetz.de/w64/)。
2. 在“启用或关闭 Windows 功能”里勾选 **Windows 虚拟机监控程序平台（Windows Hypervisor Platform）**，重启。
3. 把 `agentos.qcow2` 和 `deploy/windows/Start-AgentOS.ps1` 放在同一个文件夹，在 PowerShell 里运行：

   ```powershell
   .\Start-AgentOS.ps1                       # 默认 6144 MiB、2 核
   .\Start-AgentOS.ps1 -MemoryMB 8192 -Cpus 4
   ```

   脚本会用 WHPX 加速（不可用时退回很慢的 TCG），UEFI 变量文件放在磁盘旁边，下次直接复用。

## 3. 第一次开机

1. 屏幕显示 `Choose your AgentOS password (at least 8 characters)`：输入密码，回车；
   `Repeat the password`：再输入一次。（输入时屏幕不显示字符。）
2. 系统会给磁盘换上新的加密密钥并扩容到整块磁盘，然后自动创建管理员 `admin` 和工作区“我的工作区”。
   这一步通常一两分钟，不需要任何操作。
3. 登录界面出现，用户 `admin` 已选好，输入刚才的密码即可进入桌面。
4. 在桌面上点“连接模型”（或 设置 → 模型），填入 OpenAI 兼容接口地址、模型 ID 和密钥，就可以用一句话生成应用。

## 之后每次开机

先输入一次密码解锁磁盘，然后在登录界面再用同一个密码登录。

## 和 ISO 安装的区别

ISO 适合装到一块空磁盘上，会逐步询问安装目标、管理员名称和工作区名称；虚拟机镜像跳过这些，只问密码。
两者装出来的是同一个系统。
