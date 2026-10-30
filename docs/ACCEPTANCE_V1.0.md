# AgentOS v1.0 验收报告

本文件逐项记录规格 docs/AGENTOS_MVP_V1.0.md §32 的 100 项验收、各自的**证据等级**和结论。**v1.0 未达到发布完成条件（V1-O10）**：下面“部分/未通过”的项目都没有被当作通过。

- 分支 `v1.0`，最终提交见文末“提交与 CI”。固定输入：nixpkgs nixos-26.05 @ 6f06d204d8f2d8761d9da78778745974a3216381，rust-overlay @ 96a0986b0486341fbc163fa2fabc6d3b44cdcbf1（os/flake.lock）。
- 结论取值：**通过**＝该等级的证据覆盖了规格这一行的全部内容；**部分**＝有证据但只覆盖一部分（原因写在行内）；**未通过**＝没有可用证据或尚未实现。
- 证据等级（互不替代，不把低等级写成高等级）：
  - **KVM VM（Actions）**：GitHub Actions ubuntu-latest runner 上 `/dev/kvm` 加速的 NixOS VM 测试（.github/workflows/v1-vm-tests.yml，一项一个 job，docs/V1.0_VM_TESTS.md 有说明与本地跑法）。没有真实 GPU/显示/输入法/实体盘/串口/Wi-Fi。
  - **TCG VM**：开发沙箱（InstaBox，无 KVM）上的软件模拟 VM，单 vCPU，只用于冒烟。本报告没有任何一行以 TCG 作为通过依据。
  - **单元/集成**：vitest（开发树在 v0.4 验收机 Debian 上运行）、cargo test（agentos-v1 构建机）、Qt ctest（offscreen，nix 构建 checkPhase）。
  - **真实旧备份（v0.4 验收机）**：从冻结 v0.4 实例做的真实冷备份导入。
  - **需实体机，未验收**：只能在实体硬件或固定参考机上完成，本轮没有该硬件；文末给出跑法。
- 真实模型：只允许在开发沙箱使用保险箱中的 TokenRhythm 密钥，密钥不上机器、不进 CI。本轮未完成真实模型相关项（O01、O02），没有以 faux 结果替代。


## 基线与契约

| 编号 | 名称 | 结论 | 证据等级 | 证据 / 原因 |
|---|---|---|---|---|
| V1-B01 | 已修复 | 部分 | 单元/集成 | 开发树在 v0.4 验收机上：contracts、unit 88、identity 9、machine 7、migration-v1 5、agents 24、maintenance 35、maintenance-recovery 4、gc-online 7、compaction 6 全过；recovery 套件仍有偶发失败（见 R08 记录与“回归”一节）；telemetry 的 eBPF 部分见 O 行与“回归”一节。 |
| V1-B02 | 应用/ABI | 通过 | 单元/集成 | tests/integration/v02-contracts.test.ts：formatVersion 1/2/3、ABI 1/2、catalog 与冻结 bundle hash（fixtures/todo-v1.json sha256:428df8c7…）不变。 |
| V1-B03 | 三语言协议 | 通过 | 单元/集成 | fixtures/v1.0/protocol/vectors.json 在 TS（scripts/v1-vectors.mjs --check）、Rust（agentos-protocol v1_vectors/vectors）、C++（desktop v1_vectors，含于 Shell ctest）结果一致。 |
| V1-B04 | 发行依赖冻结 | 部分 | KVM VM（Actions） | os/flake.lock 固定 nixpkgs nixos-26.05@6f06d204（2026-10-29，26.05 支持期至 2026-12-31）与 rust-overlay@96a0986b；pnpm 依赖为固定输出哈希；仓库与 Nix 文件无 latest。离线 OCI（决定 18）：agentos-oci 在构建 VM 里 --network=none --pull=never 构建 8 个 catalog 镜像，基础镜像为固定输出 skopeo 副本，release manifest ociDigests 填入；build-oci 在 Actions（run 41080892538）构建通过。**未满足**：m5 在发行镜像里启动应用容器失败（crun: readlink ``，OCI runtime 调用的命令未找到），固件清单未单列。 |
| V1-B05 | 单写者和双库 | 部分 | KVM VM（Actions）＋单元/集成 | machined 在旧实例进程仍在时拒绝再次启动（WORKSPACE_FENCED，m8-backup 曾因此暴露并修复 podman 残留）；tests/machine/directory.test.ts 拒绝重复 storeUUID。Pi marker 不匹配阻断新任务未在 v1.0 VM 中重跑。 |
| V1-B06 | 实施证据边界 | 通过 | 本报告 | 每行标注证据等级；TCG/KVM/单元/实体机分列；继承的 V3-E04 串口仍为未验收。 |
| V1-B07 | schema | 部分 | 单元/集成 | tests/migration/schema5.test.ts 保留 schema 4→5 旧收据与 v0.1 bundle hash；broker db::tests 保留 schema 3→4 effect 行。崩溃中途写入未做。 |
| V1-B08 | 默认配置 | 部分 | KVM VM（Actions） | 发行模块：broker policy testMode=false、root 口令 "!"、无 sshd、无 TCP 监听（m2/m6 断言 `ss -ltn` 为空）、AGENTOS_MODEL_MODE=real、无预置 token/私钥；安装器在校验阶段拒绝任何有口令/空口令账户（m6 在测试变体上实际触发过“root has an empty password”）。qcow2 模板 LUKS 用公开模板密钥，首启强制替换（见 U03）。完整正式镜像的逐文件审计未做。 |

## 登录、成员与撤权

| 编号 | 名称 | 结论 | 证据等级 | 证据 / 原因 |
|---|---|---|---|---|
| V1-I01 | 真实登录绑定 | 通过 | KVM VM（Actions） | os/tests/m2-identity.py：tty1 真实 PAM 登录后由内核对端 PID/UID + logind session/seat 绑定；伪造字段（principal、URL）被拒。 |
| V1-I02 | 非登录进程 | 通过 | KVM VM（Actions） | m2-identity：无 logind 会话的 root 进程 session.bind → 401 SESSION_REQUIRED。 |
| V1-I03 | 用户不可见数据 | 通过 | KVM VM（Actions） | m2-identity：B 列不到 A 的工作区，get/forward A 的 ID 统一 404 NOT_FOUND_OR_FORBIDDEN；m3-members 中机器管理员对非成员工作区同样 404。 |
| V1-I04 | 角色矩阵 | 通过 | KVM VM（Actions）＋单元/集成 | tests/identity/access.test.ts 角色×动作全矩阵；m3-members：viewer 读 200、写/成员管理 404，editor 写入但 owner 动作（maintenance.control）被 Host 矩阵拒绝，owner 可执行，机器管理员无数据入口。 CI：run 41088865318 中 I04/I03/W04/I06/I08 通过，I09 子测试失败——禁用 bob 被 machined 以 CONFLICT 拒绝（bob 是工作区 “Bob” 的唯一 owner，须先转移所有权），属正确行为、断言有误；已改为断言该拒绝并禁用一个不拥有工作区的新用户，重跑 run 41090308175，I09/I10/W07/I11 CI 待结果。 |
| V1-I05 | 自身任务和共享任务 | 部分 | 单元/集成（VM 已写，CI 待结果） | access.test.ts 覆盖自身/他人任务的读取与取消判定。m11-ops I05：editor 读不到/取消不了 owner 的 run transcript，能读并取消自己的；owner 能取消 editor 的 run。 m11-ops（os/tests/m11-ops.py，两个真实 Host + 本地保持端点）已写，run 41089329164，CI 待结果。 |
| V1-I06 | 撤销与写提交竞争 | 通过 | KVM VM（Actions） | m3-members：Host 运行中撤销 → 被撤销者的读写立即被拒；revocations 只有在 gateway/host/broker 三方 ack 后才变 revoked。写提交与撤销的精确竞争窗口与 UI 结果一致性未做。 KVM 通过（run 41088865318）：根因是此前测试等待语句的 sqlite 查询三重转义、从未被解析，并非缺 ack。 |
| V1-I07 | 撤销与模型派发 | 部分 | 单元/集成 | directory.test.ts / admitPermit：等待中的 permit 在 memberVersion 变化后被撤；Rust 单元（本轮在 agentos-v1 cargo test 通过）：native/crates/machine/src/tests.rs s04_final_check_after_waiting_member_version_revocation_and_stop。 m10-sched：run 41088879793 中 S01/S02 子测试失败——测试先连发 A 的两个 run，A 在 B 尚无等待时取得第二个 permit，这是 §13.2 允许的（“无其它等待者可临时使用第二个”），断言有误；已改为交错提交，重跑中，CI 待结果。 |
| V1-I08 | 撤销时 | 通过 | KVM VM（Actions） | m3-members：Host 停止时撤销，gateway 立即拒绝，root 侧保持 revoking ≥8 秒，Host 重新启动并 ack 后才 revoked。broker 失联与执行者 fence 未单独做。 KVM 通过（run 41088865318）：根因是此前测试等待语句的 sqlite 查询三重转义、从未被解析，并非缺 ack。 |
| V1-I09 | owner | 部分 | KVM VM（Actions） | m3-members：最后 owner 不能被移除/降级；禁用账户后该账户无法再绑定会话。旧批准策略暂停与 transferOwner 双边确认未在 VM 中断言。 CI：run 41088865318 中 I04/I03/W04/I06/I08 通过，I09 子测试失败——禁用 bob 被 machined 以 CONFLICT 拒绝（bob 是工作区 “Bob” 的唯一 owner，须先转移所有权），属正确行为、断言有误；已改为断言该拒绝并禁用一个不拥有工作区的新用户，重跑 run 41090308175，I09/I10/W07/I11 CI 待结果。 |
| V1-I10 | 锁屏/注销后的请求 | 部分 | KVM VM（Actions） | m3-members：过期 sessionEpoch 被拒；session.end 后同连接不能继续；logind LockedHint=yes 时不能绑定，解锁后可以。已授权持久 run 在原 scope 内继续未在 VM 中做。 CI：run 41088865318 中 I04/I03/W04/I06/I08 通过，I09 子测试失败——禁用 bob 被 machined 以 CONFLICT 拒绝（bob 是工作区 “Bob” 的唯一 owner，须先转移所有权），属正确行为、断言有误；已改为断言该拒绝并禁用一个不拥有工作区的新用户，重跑 run 41090308175，I09/I10/W07/I11 CI 待结果。 |
| V1-I11 | 秘密不外泄 | 部分 | KVM VM（Actions） | m3-members：创建账户期间每 50ms 采样全部进程 argv，四个 PAM 口令均不出现在 argv、journal、/var/lib/agentos*、/var/log、/run/agentos。provider/Wi-Fi 秘密、诊断包、会话备份与 Nix store 未扫描。 CI：run 41088865318 中 I04/I03/W04/I06/I08 通过，I09 子测试失败——禁用 bob 被 machined 以 CONFLICT 拒绝（bob 是工作区 “Bob” 的唯一 owner，须先转移所有权），属正确行为、断言有误；已改为断言该拒绝并禁用一个不拥有工作区的新用户，重跑 run 41090308175，I09/I10/W07/I11 CI 待结果。 |
| V1-I12 | 多版本/旧主体绕过 | 部分 | KVM VM（Actions）＋单元/集成 | m2-identity：forward 携带 principal/URL 被拒；access.test.ts 与 Rust：protocol 1 在 minWriteProtocol=3 后被拒。旧 memberVersion/旧 plan 在 VM 中未单独做。 |

## 工作区隔离

| 编号 | 名称 | 结论 | 证据等级 | 证据 / 原因 |
|---|---|---|---|---|
| V1-W01 | 真实 | 通过 | KVM VM（Actions） | m2-identity：两工作区不同执行 UID、各自 subuid 段与 0700 数据目录；双方 UID 与登录用户都不能读对方 os.sqlite。 |
| V1-W02 | 容器逃逸入口 | 未通过 | 未验收 | VM 中未启动应用容器，Wayland/session bus/machine/gateway/Nix socket 不可见性未测。 |
| V1-W03 | 创建断点 | 部分 | 单元/集成 | directory.test.ts：半创建工作区不可见；VM 中各断点强杀未做。 |
| V1-W04 | 两工作区并行 | 通过 | KVM VM（Actions） | m3-members：两个 Host 在不同 UID 下并行；SIGKILL A 的 Host 后 B 仍正常应答，A 由 systemd 重启后恢复。 CI：run 41088865318 中 I04/I03/W04/I06/I08 通过，I09 子测试失败——禁用 bob 被 machined 以 CONFLICT 拒绝（bob 是工作区 “Bob” 的唯一 owner，须先转移所有权），属正确行为、断言有误；已改为断言该拒绝并禁用一个不拥有工作区的新用户，重跑 run 41090308175，I09/I10/W07/I11 CI 待结果。 |
| V1-W05 | 切换与迟到响应 | 未通过 | 未验收 | Shell 快速切换与迟到响应过滤只有 offscreen ctest 的部分断言，未在 VM 会话中做。 |
| V1-W06 | 接受后切换 | 未通过 | 未验收 | m11-ops W06：已接受 run 后切到 B，同幂等键重试回到 A 得到同一 runId，B 的 runs.list/runs.get 不含该 run，A 中只有一份。 m11-ops（os/tests/m11-ops.py，两个真实 Host + 本地保持端点）已写，run 41089329164，CI 待结果。 |
| V1-W07 | 停止/归档 | 部分 | KVM VM（Actions） | m3-members：stop 后无 Host/Podman 进程且 os.sqlite/agent.sqlite 保留；archive 后数据保留、attach 被拒。归档恢复未做。 CI：run 41088865318 中 I04/I03/W04/I06/I08 通过，I09 子测试失败——禁用 bob 被 machined 以 CONFLICT 拒绝（bob 是工作区 “Bob” 的唯一 owner，须先转移所有权），属正确行为、断言有误；已改为断言该拒绝并禁用一个不拥有工作区的新用户，重跑 run 41090308175，I09/I10/W07/I11 CI 待结果。 |
| V1-W08 | 后台与注销 | 通过 | KVM VM（Actions）＋单元/集成 | Rust 单元（本轮在 agentos-v1 通过）：native/crates/machine/src/tests.rs w08_run_when_logged_out_default_off_owner_only_and_machine_quota：默认关闭、仅 owner、机器限额 ≤ 运行工作区上限。§16.1 没有设置类 route（原测试调用的 workspaces.setRunWhenLoggedOut 被 gateway 以 unknown method 拒绝），改为固定机器动作 workspaces.runWhenLoggedOut（plan→confirm，plan 与 dispatch 两次核对 owner）；m10-sched W08 子测试改为走该动作，KVM 通过（run 41088879793）：默认 0、editor 计划被拒且值不变、owner 开/关均 succeeded 并读回。锁屏/注销不扩大维护范围未单独断言。 |
| V1-W09 | 资源共享冲突 | 未通过 | 未验收 | 两工作区共享物理资源的 broker 全局 fence 未在 v1.0 VM 中测（发行镜像不登记资源）。 |
| V1-W10 | 重复导入与删除 | 部分 | 单元/集成 | directory.test.ts 拒绝重复 storeUUID；删除核对与身份 tombstone 未测。 |

## 原生桌面

| 编号 | 名称 | 结论 | 证据等级 | 证据 / 原因 |
|---|---|---|---|---|
| V1-D01 | 原生主链 | 通过 | KVM VM（Actions） | os/tests/m5-desktop.py：PAM VT 登录后 Sway + agentos-shell 启动，进程映射中无浏览器/WebEngine（Actions run 41085222091，8df4a6a，子测试 D01 通过）。 |
| V1-D02 | 旧声明式应用 | 部分 | 单元/集成 | desktop/tests 9 个 ctest 套件（Qt offscreen，nix 构建 checkPhase 中在 Actions 通过）覆盖渲染/绑定/纯数据/限额等规则；没有在真实会话中对 Host 完整流程验收。 |
| V1-D03 | 组件全集 | 部分 | 单元/集成 | desktop/tests 9 个 ctest 套件（Qt offscreen，nix 构建 checkPhase 中在 Actions 通过）覆盖渲染/绑定/纯数据/限额等规则；没有在真实会话中对 Host 完整流程验收。 |
| V1-D04 | 命令语义 | 部分 | 单元/集成 | desktop/tests 9 个 ctest 套件（Qt offscreen，nix 构建 checkPhase 中在 Actions 通过）覆盖渲染/绑定/纯数据/限额等规则；没有在真实会话中对 Host 完整流程验收。 |
| V1-D05 | 纯数据边界 | 部分 | 单元/集成 | desktop/tests 9 个 ctest 套件（Qt offscreen，nix 构建 checkPhase 中在 Actions 通过）覆盖渲染/绑定/纯数据/限额等规则；没有在真实会话中对 Host 完整流程验收。 |
| V1-D06 | 大列表与图表 | 部分 | 单元/集成 | desktop/tests 9 个 ctest 套件（Qt offscreen，nix 构建 checkPhase 中在 Actions 通过）覆盖渲染/绑定/纯数据/限额等规则；没有在真实会话中对 Host 完整流程验收。 |
| V1-D07 | 系统确认隔离 | 部分 | 单元/集成 | desktop/tests 9 个 ctest 套件（Qt offscreen，nix 构建 checkPhase 中在 Actions 通过）覆盖渲染/绑定/纯数据/限额等规则；没有在真实会话中对 Host 完整流程验收。 |
| V1-D08 | v0.4 | 未通过 | 未验收 | v0.4 全部页面在原生 UI 上的端到端流程未做。 |
| V1-D09 | 事件断线 | 部分 | 单元/集成 | desktop/tests 9 个 ctest 套件（Qt offscreen，nix 构建 checkPhase 中在 Actions 通过）覆盖渲染/绑定/纯数据/限额等规则；没有在真实会话中对 Host 完整流程验收。 |
| V1-D10 | 中文与键盘 | 未通过 | 需实体机，未验收 | 真实 Fcitx5 组合输入需要实体显示与输入法；跑法见文末。 |
| V1-D11 | 崩溃与降级 | 部分 | 单元/集成 | desktop/tests 9 个 ctest 套件（Qt offscreen，nix 构建 checkPhase 中在 Actions 通过）覆盖渲染/绑定/纯数据/限额等规则；没有在真实会话中对 Host 完整流程验收。 |
| V1-D12 | 隐私与布局 | 部分 | 单元/集成 | desktop/tests 9 个 ctest 套件（Qt offscreen，nix 构建 checkPhase 中在 Actions 通过）覆盖渲染/绑定/纯数据/限额等规则；没有在真实会话中对 Host 完整流程验收。 |

## 实体硬件

| 编号 | 名称 | 结论 | 证据等级 | 证据 / 原因 |
|---|---|---|---|---|
| V1-H01 | 真实图形设备 | 未通过 | 需实体机，未验收 | 需要实体设备，跑法见文末。 |
| V1-H02 | 显示模式与拔插 | 未通过 | 需实体机，未验收 | 需要实体设备，跑法见文末。 |
| V1-H03 | 真锁屏故障 | 部分 | KVM VM（Actions）（已写，CI 待结果）；真实显卡需实体机，未验收 | m5-desktop：锁屏只有 swaylock 成功后 LockedHint=yes；杀掉 swaylock 结束会话回 greeter。8df4a6a 轮 m5 在其前一个子测试（应用容器）失败，本子测试未执行到。真实显卡/输出故障需实体机。 |
| V1-H04 | 网络 | 未通过 | 需实体机，未验收 | 需要实体设备，跑法见文末。 |
| V1-H05 | 音频/亮度 | 未通过 | 需实体机，未验收 | 需要实体设备，跑法见文末。 |
| V1-H06 | 休眠唤醒 | 未通过 | 需实体机，未验收 | 需要实体设备，跑法见文末。 |
| V1-H07 | 电源排空 | 未通过 | 需实体机，未验收 | 需要实体设备，跑法见文末。 |
| V1-H08 | 不支持硬件 | 未通过 | 需实体机，未验收 | 需要实体设备，跑法见文末。 |

## 机器准入与调度

| 编号 | 名称 | 结论 | 证据等级 | 证据 / 原因 |
|---|---|---|---|---|
| V1-S01 | 两级额度 | 部分 | 单元/集成 | Rust 单元（本轮在 agentos-v1 cargo test 通过）：native/crates/machine/src/tests.rs s01_two_level_quota_total_two_background_one_and_day_budgets；directory.test.ts：两工作区总并发 ≤2 且一方不能占满。 m10-sched：run 41088879793 中 S01/S02 子测试失败——测试先连发 A 的两个 run，A 在 B 尚无等待时取得第二个 permit，这是 §13.2 允许的（“无其它等待者可临时使用第二个”），断言有误；已改为交错提交，重跑中，CI 待结果。 |
| V1-S02 | 前台公平性 | 部分 | 单元/集成 | Rust 单元（本轮在 agentos-v1 cargo test 通过）：native/crates/machine/src/tests.rs s02_foreground_round_robin_one_workspace_cannot_monopolise；directory.test.ts gives the waiting workspace the next slot。 m10-sched：run 41088879793 中 S01/S02 子测试失败——测试先连发 A 的两个 run，A 在 B 尚无等待时取得第二个 permit，这是 §13.2 允许的（“无其它等待者可临时使用第二个”），断言有误；已改为交错提交，重跑中，CI 待结果。 |
| V1-S03 | 无锁循环 | 未通过 | 未验收 | 未做。 |
| V1-S04 | 准入最终检查 | 部分 | 单元/集成 | Rust 单元（本轮在 agentos-v1 cargo test 通过）：native/crates/machine/src/tests.rs s04_final_check_after_waiting_member_version_revocation_and_stop。VM 未做。 |
| V1-S05 | permit | 部分 | 单元/集成 | Rust 单元（本轮在 agentos-v1 cargo test 通过）：native/crates/machine/src/tests.rs s05_s06_restart_never_frees_held_slots_until_the_holder_is_gone_unknown_is_charged；directory.test.ts：重启不释放已占槽。VM 中 reserved/in_use 各位置强杀未做。 |
| V1-S06 | 进程与未知用量 | 部分 | 单元/集成 | Rust 单元（本轮在 agentos-v1 cargo test 通过）：native/crates/machine/src/tests.rs s05_s06_restart_never_frees_held_slots_until_the_holder_is_gone_unknown_is_charged（unknown 按已用计费）。VM 未做。 |
| V1-S07 | 背景让行 | 部分 | 单元/集成 | Rust 单元（本轮在 agentos-v1 cargo test 通过）：native/crates/machine/src/tests.rs s07_background_yields_to_foreground。VM 未做。 |
| V1-S08 | 机器不可达 | 未通过 | 未验收 | m10-sched：run 41088879793 中 S01/S02 子测试失败——测试先连发 A 的两个 run，A 在 B 尚无等待时取得第二个 permit，这是 §13.2 允许的（“无其它等待者可临时使用第二个”），断言有误；已改为交错提交，重跑中，CI 待结果。 |

## 安装与更新

| 编号 | 名称 | 结论 | 证据等级 | 证据 / 原因 |
|---|---|---|---|---|
| V1-U01 | 离线空机安装 | 部分 | KVM VM（Actions）（已写，CI 待结果）；实盘需实体机，未验收 | m6-install：离线（无默认路由、无 substituter）安装到 virtio 盘，systemd-boot→LUKS2→Btrfs 启动，首启进入未登记机器。离线 OCI 已进发行闭包（build-oci 通过，见 B04），但发行镜像中应用容器启动在 m5 失败。5fd7da2 轮 m6-install（run 41080892538）仍在运行，CI 待结果。实体盘未测：跑法见文末。 |
| V1-U02 | 磁盘重验/中断 | 部分 | KVM VM（Actions）（已写，CI 待结果）；实盘需实体机，未验收 | m6-install：小盘/系统盘被拒、计划后磁盘变化被拒且不写入、复制中崩溃只在同一盘续作。5fd7da2 轮 m6-install 仍在运行，CI 待结果。真实 WWN/serial 需实体盘。 |
| V1-U03 | 首启身份 | 部分 | KVM VM（Actions）（已写，CI 待结果） | m6-qcow2：同一模板两个克隆各自替换模板磁盘密钥后首启，machineInstallId 不同；重启后要求新口令且身份保持；m6-install 同一盘重复 firstboot 被拒。5fd7da2 轮 m6-qcow2 与 build-qcow2（run 41080892538）仍在运行，CI 待结果。 |
| V1-U04 | 签名与内容 | 部分 | 单元/集成 | access.test.ts 发行准入：坏签名/过期/重放/破坏性迁移被拒；update-worker 单元测试校验内容 hash。篡改闭包/OCI 的端到端与 require-sigs 未在 VM 做（发行配置保持 require-sigs=true）。 |
| V1-U05 | 序列与密钥轮换 | 部分 | 单元/集成 | directory.test.ts：旧 sequence 被拒、known-good 回退不降高水位；密钥轮换未测。 |
| V1-U06 | 下载与低空间 | 部分 | 单元/集成（VM 已写，CI 待结果） | agentos-update-worker arm 先做前置检查（native/crates/update-worker/src/preflight.rs）：ESP 可用 ≥16 MiB、store 可用 ≥ max(候选闭包所需, 256 MiB)、无市电且电池 <40% 未充电则拒绝（UPDATE_PRECONDITION），拒绝时不写 one-shot、不改 default/条目。Rust u06_preflight_refuses_low_space_and_low_battery_and_arms_nothing 本轮通过；m7-update U06 子测试（真实 bootctl：低电/空间不足不 armed、loader 状态不变）已写，CI 待结果。下载断线续传：nix copy 以 store 路径为原子单位，已到路径保留，未在 VM 中断网复测。 |
| V1-U07 | 启动项写入断电 | 部分 | KVM VM（Actions）＋单元/集成 | m7-update：known-good 与候选条目完整、default 为 known-good；update-worker Rust 测试覆盖各发布点中断。VM 断电未做。 |
| V1-U08 | 单次试启动 | 通过 | KVM VM（Actions） | m7-update：one-shot 只启动候选一次、default 不变；无 init 的坏候选复位后进入 default，不无限重试。 |
| V1-U09 | 健康门槛 | 部分 | 单元/集成 | update-worker health 单元测试（假 ready、仅 SSH、Qt 不出帧、schema 不兼容）；VM 中未做。 |
| V1-U10 | 提交窗口恢复 | 部分 | KVM VM（Actions）＋单元/集成 | m7-update：commit 写入并读回 default；Rust U10 覆盖各断点对账。 |
| V1-U11 | 兼容回退 | 未通过 | 未验收 | 未做。 |
| V1-U12 | 保留与回收 | 通过 | KVM VM（Actions）＋单元/集成 | m7-update：GC 只移除未 pin 的登记条目，NixOS 自有条目保留；Rust U12。 |

## 备份恢复

| 编号 | 名称 | 结论 | 证据等级 | 证据 / 原因 |
|---|---|---|---|---|
| V1-R01 | 双库冷备份 | 通过 | KVM VM（Actions） | m8-backup：Host 持 host.lock 时拒绝冷检查点；停止后双库检查点可校验、仅 root 可读；恢复后重新 attach 成功。 |
| V1-R02 | 多域屏障 | 部分 | KVM VM（Actions） | precheck 修复（决定 23）后 m9-restore（run 41085217261，8df4a6a）两个 R02 子测试通过：一个 barrier 下两个工作区组成一个机器集合、之后都重新启动；备份在 barrier 下死亡时冻结所有工作区，abandon 释放。home 写者/GC/资源冻结未单独断言。 |
| V1-R03 | 集合发布中断 | 通过 | KVM VM（Actions）＋单元/集成 | m8-backup：manifest 前强杀不形成可恢复集合；recovery-worker Rust R03。 |
| V1-R04 | 加密离机往返 | 通过 | KVM VM（Actions）＋单元/集成 | m8-backup：age 导出→读回→解密到空盘→校验；错误密钥/篡改密文被拒。 |
| V1-R05 | 恢复路径防护 | 通过 | KVM VM（Actions）＋单元/集成 | m8-backup：路径穿越归档不能写出 staging；Rust R05 覆盖 link/设备节点/UID。 |
| V1-R06 | 同机根侧事实 | 部分 | 单元/集成 | directory.test.ts：恢复期间保留当前撤权；broker effect/quarantine 未测。 m9-restore（run 41085217261，8df4a6a）在“备份后撤销 bob”子测试等待 revoked 超时（同 I06 缺 ack 问题），本项子测试未执行到。 |
| V1-R07 | 恢复各代次 | 未通过 | 未验收 | m9-restore 已写，CI 未执行到：m9-restore（run 41085217261，8df4a6a）在“备份后撤销 bob”子测试等待 revoked 超时（同 I06 缺 ack 问题），本项子测试未执行到。 |
| V1-R08 | 半恢复整机 | 未通过 | 未验收 | m9-restore 已写，CI 未执行到：m9-restore（run 41085217261，8df4a6a）在“备份后撤销 bob”子测试等待 revoked 超时（同 I06 缺 ack 问题），本项子测试未执行到。 |
| V1-R09 | 缓存与 | 未通过 | 未验收 | 未做。 |
| V1-R10 | 异机克隆 | 未通过 | 未验收 | 未做。 |
| V1-R11 | 根侧日志丢失 | 未通过 | 未验收 | m9-restore 已写，CI 未执行到：m9-restore（run 41085217261，8df4a6a）在“备份后撤销 bob”子测试等待 revoked 超时（同 I06 缺 ack 问题），本项子测试未执行到。 |
| V1-R12 | 空间与快照保留 | 未通过 | 未验收 | 未做。 |

## v0.4 迁移

| 编号 | 名称 | 结论 | 证据等级 | 证据 / 原因 |
|---|---|---|---|---|
| V1-M01 | 真实旧备份 | 通过 | 真实旧备份（v0.4 验收机）＋单元/集成 | 从冻结 v0.4 实例的真实冷备份导入，源实例与备份保持可用。（tests/migration/import-v04.test.ts，AGENTOS_V04_BACKUP 指向真实备份。） |
| V1-M02 | 内容保持 | 通过 | 真实旧备份（v0.4 验收机）＋单元/集成 | app/revision/record ID、规范数据 hash、历史激活与旧收据一致。（tests/migration/import-v04.test.ts，AGENTOS_V04_BACKUP 指向真实备份。） |
| V1-M03 | legacy | 通过 | 真实旧备份（v0.4 验收机）＋单元/集成 | user:local 历史显式映射到 owner，不重算收据，未完成任务不获新权利。（tests/migration/import-v04.test.ts，AGENTOS_V04_BACKUP 指向真实备份。） |
| V1-M04 | 容器与文件身份 | 未通过 | 未验收 | 新 UID 下代码应用重建未做（需 OCI 基础镜像离线可用，见 B04）。 |
| V1-M05 | 旧授权处理 | 通过 | 真实旧备份（v0.4 验收机）＋单元/集成 | 自动策略暂停、provider 密钥未带入、旧 grants 需重新确认。（tests/migration/import-v04.test.ts，AGENTOS_V04_BACKUP 指向真实备份。） |
| V1-M06 | 原生回归主线 | 未通过 | 未验收 | 原生端完成旧主线未做。 |
| V1-M07 | 导入失败恢复 | 通过 | 真实旧备份（v0.4 验收机）＋单元/集成 | hash/配对失败只影响 staging；重复导入不产生第二个可写 storeUUID。（tests/migration/import-v04.test.ts，AGENTOS_V04_BACKUP 指向真实备份。） |
| V1-M08 | 退回旧环境边界 | 通过 | 真实旧备份（v0.4 验收机）＋单元/集成 | v0.4 程序拒绝打开 schema 5。（tests/migration/import-v04.test.ts，AGENTOS_V04_BACKUP 指向真实备份。） |

## 真实运行与发布

| 编号 | 名称 | 结论 | 证据等级 | 证据 / 原因 |
|---|---|---|---|---|
| V1-O01 | 真实模型原生主线 | 部分 | Host 级（真实模型） | Host 级真实模型（openai-compatible qwen3.8-flash，开发模式 Host，无原生 UI、无 machined）：建应用、改版、升级+切回、压缩，证据 docs/evidence/v1.0-smoke-real-host.json。原生 UI 主线在 v1.0 机器上未跑，未满足。 |
| V1-O02 | 两工作区真实并发 | 部分 | Host 级（真实模型） | 两个 Host 进程两工作区重叠真实请求并发创建均成功，证据 docs/evidence/v1.0-smoke-real-host.json。经 machined 机器 permit 的两工作区真实并发未跑（m10 未执行到）。 |
| V1-O03 | 断网日常可用 | 部分 | 单元/集成 | tests/integration/http.test.ts 无模型时 CRUD/查询/版本可用、生成明确不可用；未在 VM 中断网复测。 |
| V1-O04 | 启动与交互性能 | 未通过 | 需实体机，未验收 | 需要固定参考机计时。 |
| V1-O05 | 持续后台性能 | 未通过 | 需实体机，未验收 | 需要固定参考机计时。 |
| V1-O06 | 真实故障恢复 | 部分 | KVM VM（Actions） | VM 中已有：machined 重启保身份（m2）、Host SIGKILL 后另一工作区不受影响（m3 W04，CI 通过）、坏候选复位（m7）、检查点强杀（m8）。m11-ops O06：依次 SIGKILL broker/machined/gateway，各自由 systemd 重启、machineInstallId 不变、两个 Host 重连后 forward 可用。m11-ops（os/tests/m11-ops.py，两个真实 Host + 本地保持端点）已写，run 41089329164，CI 待结果。 Shell SIGKILL 与 VM power-cut 窗口未做。 |
| V1-O07 | 原生入口攻击 | 部分 | 单元/集成（VM 已写，CI 待结果） | access.test.ts：重复键/未知字段/URL 形 forward/超长帧被拒。本轮 gateway 新增：每 UID 32、总计 256 连接上限，已开始的帧须 30 秒内收齐（事件订阅空闲不限）；Rust 单元 o07_connection_slots_are_bounded_per_uid_and_released、o07_a_started_frame_must_complete_in_time_but_idle_is_unbounded 本轮通过。m11-ops O07（os/tests/ops-fuzz.py：超长长度、非 JSON、重复键、未知字段、URL forward、深嵌套、截断帧、20 个慢连接时正常请求 <5 s、停滞帧 35 s 内被关、每 UID 上限、释放后恢复、gateway RSS<200 MB）m11-ops（os/tests/m11-ops.py，两个真实 Host + 本地保持端点）已写，run 41089329164，CI 待结果。 旧票据重放未单独做。 |
| V1-O08 | 日志与支持包 | 通过 | KVM VM（Actions）＋单元/集成 | agentosctl support-bundle --out <file>（native/crates/machine/src/ctl.rs）：仅 root、0600；只收机器级事实（release、boot、schema/协议、身份摘要 sha256 前 16 位、registry、工作区状态、permit/barrier/restore、boot default）与脱敏服务日志（含 password/psk/secret/token/cookie/authorization/api key/private 的行替换为标记），不收工作区正文。Rust 单元 o08_support_bundle_lines_naming_secrets_are_replaced 本轮通过；m10-sched O08 子测试（非 root 被拒、0600、无 PAM 口令、无完整 machineInstallId、root_audit 不被轮转）KVM 通过（run 41088879793）。 |
| V1-O09 | 干净构建与安装 | 未通过 | 未验收 | build-repro（Actions 新 job）：agentos-native/node/shell/release 各构建后用 nix build --rebuild 再构建一次逐位比较，不同则列出差异；已写，CI 待结果。ISO 安装/导入/升级/离机恢复的同一候选完整演练未做。 |
| V1-O10 | 发布完成条件 | 未通过 | 未验收 | 100 项证据未齐，不能宣称发布完成。 |

## 统计

未通过 28 项，通过 26 项，部分 46 项（共 100 项）。

## 回归与偶发失败记录

- recovery 套件（v0.1–v0.4 继承项，开发树在 v0.4 验收机上）：此前偶发的 R08 “ENOENT auth-token” 根因是 tests/proc.ts 各 vitest worker 共用同一随机端口段，两个测试文件可能在同一端口起 Host——后起者绑定失败而 waitHttp 被另一文件的 Host 应答。改为按 `VITEST_POOL_ID` 分段并在应答时核对本进程仍存活。修复后连续 5 轮 R08 均通过；5 轮里另有 R09b（1 次，状态仍为 running 而非 blocked）、V2-P02（1 次，旧容器仍存活）与 V4-O05 前台 p95 比值（2 次，1.39/1.51 > 1.25）失败。前两者是重启/容器回收的计时窗口，O05 是共享云沙箱上的性能比值（规格要求固定参考机，见 O05）。按“同一问题循环不超过两次”的规则未再深挖，记为未关闭。
- telemetry 套件：V3-T01..T05 需要带 BTF 的 eBPF 验收 guest（v0.4 验收机上的 QEMU Debian guest）。本轮在 v1.0 树重新构建 agentos-telemetry（源码与 v0.4 相同）并在该 guest（Debian 6.12.113 cloud 内核，BTF，QEMU 无 KVM 加速＝TCG 级 guest）中运行：telemetry 6/6 通过，T01–T05 全部为 true，原始结果 docs/evidence/v1.0-telemetry-guest.json。

## 只能在实体机上验收的项目与跑法

这些项目在开发沙箱与 CI runner 上都没有对应硬件，结论固定为“需实体机，未验收”：

| 项目 | 需要 | 跑法 |
|---|---|---|
| V1-H01 | 支持清单中的 Intel/AMD 实体 GPU | 用 `nix build .#agentos-iso` 的 ISO 装机；登录后 `journalctl -b -u greetd`、`swaymsg -t get_outputs`、`agentosctl doctor` 记录驱动/固件/输出；从 greeter 到画布全程录屏。 |
| V1-H02 | 两种分辨率的实体显示器、可热插拔接口 | 设置页切 100%/200% 缩放与 mode；不确认等 15 秒回退；锁屏状态下拔插显示器，确认没有锁前画面帧。 |
| V1-H03 | 实体 GPU/显示 | 在 m5-desktop 的 VM 结果之外，对真实输出做 swaylock 崩溃、合成器崩溃、显示断开；确认回 greeter 且需 PAM。 |
| V1-H04 | 有线网卡、Wi-Fi | 连接/错误口令/拔线/恢复，比较界面与 `nmcli` 状态；在诊断包与模型请求日志中检索 Wi-Fi 口令。 |
| V1-H05 | 声卡、背光 | 改音量/静音/输出与亮度，用 `wpctl status`、`/sys/class/backlight` 读回；无设备的机器上应显示不可用。 |
| V1-H06 | 支持 S3/s2idle 的实体机 | `systemctl suspend`：确认 suspend 前锁屏与检查点，唤醒仍锁定，模型 attempt 与 broker 结果重核。 |
| V1-H07 | 实体机电源 | 普通关机、排空超时、强制继续三种路径；之后核对模型/外部效果事实与收据。 |
| V1-H08 | 一台含不支持设备的机器 | 确认只局部降级、没有用普通子进程替代 sandbox，报告不宣称未测硬件。 |
| V1-D10 | 实体显示 + Fcitx5 | 在 Shell 输入框做拼音/注音组合输入、简繁显示、Tab 焦点与快捷键、缩放；锁屏时确认未提交输入被清理。 |
| V1-U01（实盘） | 一块 ≥64 GiB 实体盘 | 用 ISO 离线安装（拔网线），首次登录；离线 OCI 已进发行闭包，发行镜像中应用容器启动仍待修（见 B04）。 |
| V1-U02（实盘） | 带 WWN/serial 的实体盘 | `agentos-install inspect/plan` 后换盘或改分区，确认被拒；复制中断电后在同一盘续作。 |
| V3-E04（继承） | 实体串口设备 | 按 v0.4 验收文档的串口步骤在实体设备上重跑。 |
| V1-O04 / V1-O05 | 固定参考机 | 在参考机上按规格第 27 节的起止定义取样（冷启动到 greeter、登录到画布、CRUD p95；ABBA 暖机），报告样本数与分位数。 |

## 发行签名

`nix build .#agentos-release` 产出**未签名**的 ReleaseManifest（manifest.json）、SBOM（sbom.json）与 SHA256SUMS（本轮 Actions 构建通过）。按规格 §20.1 与 M10，签名私钥只在发布环境使用、绝不进入镜像、仓库或 CI；本轮不执行正式签名与发布。更新器侧的签名/sequence/过期校验由 U04/U05 的单元测试覆盖，正式签名链与密钥轮换的端到端验收在发布环节完成。

- CI 的 Nix 缓存：cache-nix-action 把整库 tar 恢复到 daemon 拥有的 /nix/store，每个路径 “Cannot mkdir: Permission denied”，每轮从零构建；0ce9fb6 起换为 DeterminateSystems/magic-nix-cache-action@v15（路径级、跨 job 去重）。
