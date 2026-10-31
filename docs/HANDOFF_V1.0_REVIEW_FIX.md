# AgentOS v1.0 外部审查修复 — 交接文档（2026-10-31 23:30 CST）

给接手的 AI：先完整读本文件，再读 `docs/V1.0_REVIEW_FIXES.md`、`docs/V1.0_PROGRESS.md`（决定 1–84）、`docs/HANDOFF_V1.0.md`、`docs/V1.0_VM_TESTS.md`、`docs/RELEASE_V1.0.md`。规格唯一基准是 `docs/AGENTOS_MVP_V1.0.md`。

## 0. 铁律（用户定的，必须遵守）

1. 规格里每一项都要做完；做不到的在验收报告里写明原因，不能跳过，不能写成通过。中途不要停下来只汇报半成品。
2. **规格文档 `docs/AGENTOS_MVP_V*.md` 禁止修改。**
3. 提交作者只用：`cszf1 <246938975+cszf1@users.noreply.github.com>`（`git config user.name cszf1; git config user.email 246938975+cszf1@users.noreply.github.com`）。
4. **只推 `v1.0` 分支，不动 `main`**（main 目前停在 2aaa004，审查修复全部完成并经用户同意后再快进）。
5. 仓库是公开的：推送前扫描密钥、token、私钥、内部地址/主机名（建议 `gitleaks detect` 或 `git diff | grep` 自查）。真实模型 API key 不得进入仓库、CI 或 VM；VM/CI 里模型一律用 faux。
6. 证据等级不能混用：KVM（GitHub Actions）、TCG、单元/集成、Host 级真实模型、实体机。**TCG 或单元结果不能写成 KVM 通过；需要实体硬件的项标“需实体机，未验收”。** 没有证据不能标通过。
7. 当前范围：**只做虚拟机/KVM 层面能完成的内容**，实体机和 WSL 版暂不做。
8. workflow 只做测试所需修改；给 ISO 加 artifact 上传、建 GitHub Release 尚未获用户授权。

## 1. 当前状态

- 仓库：https://github.com/cszf1/agentos ，分支 `v1.0`
- 最新代码提交：`961913b204e2b8933dc74e7cccd4d23569c61553`（本交接文档提交在其后，只加文档）
- 验收统计（ACCEPTANCE/CHECKLIST/HANDOFF 三处一致）：**69 通过 / 20 部分 / 11 未通过**
  - 审查降级的 8 项中已改回通过：I06、U05、R11
  - 已有 KVM 证据但**文档还没改**：I08（m3 run 41208150103）、U04（m7 run 41208171776）。改完应为 71/18/11。
  - U09：m7 部分已过，还差 m5。
- 审查修复清单原文：`docs/review/REVIEW_V1.0_EXTERNAL_2026-10-31.md`（F01–F16 + R2-1..R2-5）。逐项跟踪：`docs/V1.0_REVIEW_FIXES.md`。

### 各编号状态

| 编号 | 状态 | 证据 / 待办 |
|---|---|---|
| F01 qcow2 克隆共享卷密钥 | 代码完成（首启在线重加密），测试假阴性已修 | 等 m6-qcow2 结果（run 41208160898 停时仍在跑） |
| F02 真实 greetd/ReGreet 登录 | 代码完成 | m5 卡在截图：pngtopnm 输出灰度 P5，测试辅助只认 P6。**修 m5 与 m20 的截图函数兼容 P5**，重跑 |
| F03 / I06 | KVM 通过 | m10 run 41203693428 |
| F04 / I08 | KVM 通过 | m3 run 41208150103（F04a/F04b/I09）；**改文档** |
| F05 安装断电续作 | VM 部分 KVM 通过 | m6-install 41199835140、41201721418；真实盘部分需实体机 |
| F06 模型转发默认外部地址 | 单元通过 | — |
| F07 / R11 | KVM 通过 | m9 41206160753 |
| F08 锁屏/注销权限边界 | 代码完成，并入 m5 | 等 m5 |
| F09 qcow2 解密后内容比对 | 模板构建已归一化 Nix db 时间、shadow 顺序、/tmp/state | 等 build-repro（41208175425） |
| F10 machined/broker 沙箱 | KVM 通过（m2 41202745108 等） | 最终 test=all 再确认没改坏别的 |
| F11 最终 ISO 安装 | m19-iso 已写，串口启动项解析已修 | 等 m19（41211143889） |
| F12 真实 Wayland 关键旅程 | m20-sway 已写（真实 Sway + QMP 输入 + 像素） | 等 m20（41211147184），迭代到通过 |
| F13 版本号 | 单元/typecheck 通过 | — |
| F14 workflow 覆盖最终提交 | 已改 | 最终 test=all |
| F15 实体机 profile | build-physical 通过 | 实体部分需实体机 |
| F16 全历史密钥扫描 | build-audit 通过 | `.gitleaksignore` 有 1 条测试 UUID 误报 |
| R2-1 / U04 | KVM 通过 | m7 41208171776；**改文档** |
| R2-2 / U09 | 单元 + m7 通过 | 差 m5 |
| R2-3 / U05 | 已改回通过 | — |
| R2-4 / U06 | KVM 通过 | m16 41201709583 |
| R2-5 发行序号 | build-release 检查通过 | — |
| O09 | 已实现管理员无 root 路径 `agentosctl admin`（决定 80） | m18 41211149850 待看；仍为部分（“独立操作者”需人工） |

停下时仍在跑、尚未读结果的 run：m19 41211143889、m20 41211147184、m18 41211149850、m6-qcow2 41208160898、build-repro 41208175425。

## 2. 剩余工作（按顺序）

1. 读上面 5 个 run 的结果；失败就读日志修复，重跑到通过。
2. 修 m5 / m20 截图对 P5（灰度 PNM）的兼容，重跑 m5，拿 F02、F08、F12 与 U09 的证据。
3. 用 `docs/tools/v1doc.py` 改 I08、U04（以及拿到证据后的 U09、D01、W08 等）；用 `docs/tools/rfset.py` 填 REVIEW_FIXES 行；PROGRESS 从**决定 85** 起续写，同时追加 `docs/v1.0-decisions.tsv`。
4. m20-sway 迭代到通过后，按证据逐项改回 D02–D07、D09、D11、D12；D09 的“慢读端有界”在单图形用户 VM 里做不到就保持部分并写明原因。
5. 实现 m19 单 VM 连贯演练：ISO 安装 → v0.4 导入 → 升级失败回退 → 导出到第二台恢复，全部按 RELEASE 文档以管理员身份执行。
   - 已识别前提：安装后的系统没有 udisks，管理员无 root，没法挂 U 盘拷文件。计划**决定 85：启用 udisks2，USB 可移动介质由本地活动会话挂载**。
   - 升级回退：先 `update adopt-base` 登记正在运行的发行；候选版用同一闭包、更高序号的 manifest；只放 narinfo 的 `file://` 缓存；试启动时不做图形登录 → 健康门槛不过 → commit 被拒 → 重启回到已知可用版本。
   - 签名：`agentosctl update digest` 需要连 machined，driver 侧无法直接调用；需用 Python 复刻 canonical JSON + 域名哈希，或另想办法。
   - O09 的“独立操作者”部分写明需人工。
6. 最终提交派发 `test=all`，**全部 27 项通过才算完成**，报告里写完整 SHA。
7. 交付：更新 ACCEPTANCE/CHECKLIST/HANDOFF/PROGRESS/REVIEW_FIXES，统计三处一致；列出仍需实体机或人工的项。

## 3. 测试方式

### GitHub Actions（所有 KVM 证据都在这里）
- workflow：`.github/workflows/v1-vm-tests.yml`，公开仓库的 `ubuntu-latest`（4 vCPU / 16 GB / KVM，免费）。
- push 到 v1.0 时，除 `docs/**` 和 `*.md` 以外的改动会自动跑全套 27 项；为避免中途反复全量，可在提交信息加 `[skip ci]`，再手动派发单项：
  ```
  gh workflow run v1-vm-tests.yml -R cszf1/agentos --ref v1.0 -f test=m5-desktop
  gh run list -R cszf1/agentos --workflow v1-vm-tests.yml -L 10
  gh run view <run-id> -R cszf1/agentos --log-failed
  ```
- 检查名：m2-identity m3-members m5-desktop m6-install m6-qcow2 m7-update m8-backup m9-restore m10-sched m11-ops m12-clone m13-native m14-create m15-wifi m16-fetch m17-shared m18-o09 m19-iso m20-sway build-release build-audit build-iso build-qcow2 build-shell build-oci build-repro build-physical，或 `all`。
- 偶发失败：magic-nix-cache 返回 418 属于缓存限流，直接重派。

### InstaBox 构建机 `agentos-v1`（只做编译和单元测试，没有 KVM）
- 账号：InstaBox 用户的第二个账号（Google 登录，账号由用户提供）。`instabox ssh agentos-v1` 进入；闲置 30 分钟自动休眠，`instabox start agentos-v1` 唤醒。
- Debian 13 + Nix，4 vCPU / 8 GB，`/data` 20 GB，**当前已用 87%，做 Nix 构建前先 `nix-collect-garbage -d` 清理**。
- 仓库副本：`/data/home/agentos-v1`（当前停在 ce8e204，落后于 961913b，先 `git fetch && git reset --hard origin/v1.0` 或重新 clone）。
- Rust 单元测试：`bash /data/home/rt.sh <日志名> -p agentos-machine`（后台跑用 `setsid nohup ... &`），结果写到 `/data/home/<日志名>`。
- 注意：长任务用 setsid 后台；不要用 `pkill -f` 匹配到自己的命令行；`/tmp` 是内存盘，跑前清 `/tmp/agentos-*`。机器上没有 KVM，QEMU 只能 TCG，**TCG 结果不能当 KVM 证据**。
- `/data/home/README.md`、`MACHINE.md` 有更多机器说明。

### 本地
- Node 24 用于 Host/前端单元测试与 typecheck；Rust/Nix 编译建议放到构建机或你本地有 Nix 的 Linux。

## 4. 文档工具（已放进仓库）

- `python3 docs/tools/v1doc.py stats` — 重算 ACCEPTANCE 与 HANDOFF 的统计并核对 CHECKLIST 一致。
- `echo "新证据说明" | python3 docs/tools/v1doc.py set V1-I08 通过 'KVM VM（Actions）' '检查说明'` — 改一项状态（ID 形如 `V1-I08`）。
- `python3 docs/tools/rfset.py F04 '状态' '提交' '证据' '剩余'` — 改 REVIEW_FIXES 一行。
- 改完务必跑一次 `v1doc.py stats`，确认输出里 `checklist mismatch: []`。

## 5. 本次审查修复中顺带修掉的产品问题（已在决定 72–84）

- 锁屏/注销按钮与 Ctrl+Alt+L 发送 machined 不认识的动作，一直被拒 → 改走登录会话自己的 agent。
- 新装系统 root 锁定，没法建第一个账户 → 新增 `agentos-first-setup`（tty1，登录界面前）。
- ReGreet 给没见过的用户起普通 shell → AgentOS 成为唯一会话，greeter 前脚本映射所有本地账户。
- 管理员无 root/sudo，无法按 RELEASE 文档做导入/备份/恢复 → `agentosctl admin <命令>`：经 gateway 计划固定 `admin.*` 动作、PAM 口令认证、60 秒一次性 ticket，machined 以临时 systemd 单元运行固定 root helper（决定 80）。
- Host 重启后重复登记 control、待发写入被永久拒绝（决定 81）。
- machined 沙箱里 rename 跨挂载 EXDEV，broker 日志没进 lost 目录 → 复制+fsync+删除（决定 82）。
- 记录表单每输入一个字符就重建字段、丢焦点（m20 设计时发现，`recordFormNames` 修复）。

## 6. 不在当前范围（以后再说）

- 实体机验收（显卡/显示器热插拔、Wi-Fi、音频亮度、休眠唤醒、电池、不支持硬件提示、真实硬盘序列号/WWN、真实断电、性能）。候选测试机：用户的旧 Lenovo ThinkCentre 一体机，或新买迷你主机。
- 人工项：独立操作者按文档完整演练（O09）、桌面手感与中文输入法、真实模型接入 —— 建议在本地 QEMU 里由人做。
- AgentOS 的 WSL 版本（未授权开发）。
- NixOS 26.05 维护期到 2026-12-31，正式发布若晚于此需先升级底座并重跑全套验收。
- InstaBox 新出的 CI（`runs-on: instabox-medium`）实测没有 `/dev/kvm`，不能跑这里的 VM 测试。
