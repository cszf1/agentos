# 在虚拟机里使用 AgentOS（快速开始）

有两种方式，装出来是同一个系统，第一次开机都只需**设置一个密码**（输入两次），用户名是 `admin`：

- **ISO 自动安装**（VMware、VirtualBox、Hyper-V 都可以）：新建虚拟机、挂上 ISO、开机，什么都不用按。
- **现成的虚拟磁盘**：不经过安装，直接把磁盘挂给虚拟机（见第 1 节起）。

这个密码同时用于：每次开机解锁磁盘、登录、锁屏解锁和系统确认（管理员身份）。至少 8 个字符，请牢记，
忘记后无法找回磁盘里的数据。

## ISO 自动安装（以 VMware Workstation 为例）

1. 获取 ISO：GitHub Actions `v1-vm-tests` 选 `build-iso` 并勾选 `upload_iso`，在运行页底部 Artifacts 下载
   `agentos-test-iso`（内含 `agentos-test.iso` 和 `SHA256SUMS`）；或 `nix build .#agentos-iso`。
2. 新建虚拟机：“典型” → “安装程序光盘映像文件”选这个 ISO → 客户机操作系统选 Linux、版本“其他 Linux 6.x 内核 64 位”。
3. 磁盘：**至少 64 GB**（VMware 默认的 20 GB 不够），只建这一块盘。内存至少 3 GB，推荐 6 GB；2 核以上。
4. 建好后先别开机：虚拟机设置 → 选项 → 高级 → 固件类型选 **UEFI**，不勾选“启用安全引导”。
   显示器里关闭“加速 3D 图形”。
5. 开机。启动菜单会自动选第一项；屏幕出现 `AgentOS installer`、要安装的磁盘和 10 秒倒数
   （`Press any key to cancel`）。**什么都不按**，倒数结束就开始安装；想取消就按任意键，磁盘不会被改动。
6. 安装几分钟，屏幕上滚动的进度行是正常的。装完后虚拟机自动重启，从硬盘启动。
   如果又回到了安装程序，它会提示“AgentOS is already installed”而不会重装：在设置里断开 CD/DVD 后重启即可。
7. 之后按下面“第一次开机”设置密码。

安装程序只在**恰好一块空磁盘**时自动安装。没有磁盘、磁盘小于 64 GB、挂了多块磁盘、或者磁盘上已有数据时，
它只在屏幕上说明原因并停下，什么都不改；这时可以按屏幕提示用 `sudo agentos-install` 手动安装。
在内核命令行加 `agentos.autoinstall=0` 可以关掉自动安装。

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

两种方式装出来是同一个系统，第一次开机的过程也一样。ISO 自动安装用的是这台虚拟机自己的磁盘标识；
虚拟磁盘镜像是一份现成的模板，第一次开机时换成这台机器自己的加密密钥。
