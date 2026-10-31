# AgentOS v1.0 交接文档

交接时间：2026-10-31 10:40（UTC+8）
分支：`v1.0`（HEAD 见 `git log -1`，交接前为 f0bee6d）。`main` 不得改动。

## 1. 必须遵守的约束

- 规格文档 `docs/AGENTOS_MVP_V*.md` **不许修改**。v1.0 规格是 `docs/AGENTOS_MVP_V1.0.md`（M0–M10，共 100 项）。
- 规格里每一项都要做完；做不到的要在验收报告里写明原因，不能跳过，也不能写成通过。
- 提交作者只能用 `cszf1 <246938975+cszf1@users.noreply.github.com>`。
- 仓库是公开的：不得提交 token、API key、私钥、内部 IP 或主机名。推送前扫一遍。
- 真实模型 API key 不得进入 CI、VM、镜像或仓库。机器和 CI 一律用 faux 模型。
- 证据等级不能混用：KVM（GitHub Actions）、TCG、单元/集成、Host 级真实模型、实体机。**TCG 或单元结果不能写成 KVM 或实体机通过**；需要实体硬件的项标成“需实体机，未验收”。
- KVM 测试只用 GitHub Actions 公开 runner（`.github/workflows/v1-vm-tests.yml`），不使用 Azure 或其它云机。

## 2. 关键文件

| 文件 | 内容 |
|---|---|
| `docs/AGENTOS_MVP_V1.0.md` | 规格（只读） |
| `docs/V1.0_CHECKLIST.md` | 100 项逐条清单，含状态 |
| `docs/V1.0_PROGRESS.md` | 进度日志和设计决定 1–47；续做前先读 |
| `docs/v1.0-decisions.tsv` | 决定表 |
| `docs/ACCEPTANCE_V1.0.md` | 验收报告：总表、逐项证据、实体机验收命令、未完成原因 |
| `docs/V1.0_VM_TESTS.md` | 各 NixOS VM 检查（m2–m18）测哪些项 |
| `docs/RELEASE_V1.0.md` | 发行说明、硬件要求、支持范围 |
| `docs/evidence/` | 证据文件（含 `v1.0-smoke-real-host.json`） |
| `.github/workflows/v1-vm-tests.yml` | KVM VM 测试；手动运行时参数 `test=all` 或单个检查名 |

## 3. 如何构建和测试

- Rust：`cd native && cargo test --workspace`
- Node/TS：`pnpm install && pnpm test`（Node 24）
- NixOS VM（需要 KVM）：`nix build .#checks.x86_64-linux.<检查名>`
- Actions：在 GitHub 上手动运行 `v1-vm-tests`，`test=<检查名>`。push 到 `v1.0` 且改动 `os/ native/ packages/ desktop/ runtime/ fixtures/` 等路径时会自动触发全部检查，费时较长；只改文档不会触发。
- 每完成一项：更新清单状态和验收报告中该项的证据，再提交推送。报告里的统计必须与清单一致。

## 4. 当前状态（交接时）

**74 通过 / 15 部分 / 11 未通过**（第二十七轮核对，与 ACCEPTANCE 总表、清单一致）

| 证据等级 | 通过 | 部分 | 未通过 |
|---|---|---|---|
| KVM（Actions） | 62 | 3 | 0 |
| TCG VM | 0 | 0 | 0 |
| 单元/集成 | 12 | 10 | 0 |
| Host 级真实模型 | 0 | 2 | 0 |
| 需实体机，未验收 | 0 | 0 | 10 |
| 无可用证据（O10） | 0 | 0 | 1 |
| 合计 | 74 | 15 | 11 |

分级与 ACCEPTANCE 总表相同：每项只计入最高证据级别；U01、U02、H03 计在 KVM 行（部分），实体部分在 5.3 重复列出。

最近一轮 Actions：run 41164440050（2b19b67，全部 24 项）中 22 项通过，包括 O09 的 build-qcow2、m6-qcow2、m6-install、m18-o09、m7-update。m13-native 失败（daily 阶段提交没有产生 run，W05/O03/S08 未执行）；build-repro 失败（ESP 空闲簇残留，决定 48 已修）。run 41167999147（1ed913d）带 m13 诊断，正在运行。

第二十四轮：run 41173405389（bcc9694，全部 24 项）中 m10-sched 与 m13-native 的 S08 构建子测试通过，S08 改为通过；m13 的 O03（缺确定性维护断言）与 W05（最后一步，决定 53）仍是部分；build-repro、m6-qcow2 写定时仍在运行。见 PROGRESS 决定 53、54 与“状态（第二十四轮）”。

第二十五轮：run 41173405389 完成，bcc9694 上 build-repro、m6-qcow2 通过；O09 构建部分满足，演练部分按规格 M10 不满足，保持部分（决定 57）。run 41177042175 的 m13 只剩两条测试断言失败（决定 55、56），Shell 侧 W05 断言全部通过。

第二十六轮：5466ae6 上 m13-native 一次通过（41179796054）一次失败（41179799013，W05 搜索被乱序旧应答覆盖，决定 58 修复）；O03 子测试通过但维护停在 awaiting_approval，决定 59 补批准后执行；计数不变 72/17/11。

第二十七轮：6871543 上 m13-native 通过（run 41183783854 单独派发；run 41183780999 全部 24 项中也通过），W05、O03 改为 KVM 通过（决定 58、59）。

第二十一轮：W09、U11 已 KVM 通过（run 41163076525）。第二十二轮：见 PROGRESS 决定 48、49 与“状态（第二十二轮）”。

## 5. 剩余工作（按优先级）

### 5.1 需要改代码或补测试

1. **W09（m17-shared）**：【第二十一轮已解决，决定 42，KVM run 41163076525 通过】两个 workspace 共享物理资源时，broker 调用 machined 的 `registry.pull` 每 10 秒读超时一次，registry 同步失败。新资源缺 `resource_state` 行的问题已修（broker `apply_observation`）。下一步：查 machined 侧 `registry.pull` 处理是否阻塞（锁、等待资源状态、请求帧未结束），在 VM 日志里对照 broker 与 machined 的时间线。
2. **O03、W05（m13-native）**：【第二十七轮已通过：run 41183783854、41183780999（6871543，KVM）】【第二十六轮：W05 乱序列表应答（决定 58），O03 批准后执行（决定 59），待下一次 m13】【第二十五轮：41177042175 中 W05 的 Shell 侧全部通过，失败在 VM 侧 cat|grep 与 pipefail（决定 55）；O03 的维护断言读错应答信封（决定 56）。两项测试已修，待下一次 m13】【第二十四轮：41173405389 中 O03 的生成不可用、CRUD、查询、版本切换在断网下通过；决定 54 补“确定性维护”断言。W05 的隔离断言通过，回到 A 时视图卡在 loading，决定 53 修复。两者待下一次 m13】【第二十二轮：41164440050 的 m13 在 daily 阶段就失败（提交没有产生 run），O03/W05 未执行；1ed913d 让各项互不阻断并打印 Shell 状态，见 run 41167999147】【第二十一轮：O03 根因是选错应用（决定 43）】daily 阶段之后写记录失败。O03 返回 403；W05 的请求没有到达 Host。O03 的“生成不可用”部分已通过；D08、M06 已通过。下一步：查 daily 阶段后 session/memberVersion/权限令牌是否被轮换（403 常见原因），以及 W05 的请求在网关还是代理层被丢。
3. **S08**：【第二十四轮已通过：m13 S08 构建子测试 41167999147、41173405389；m10 41173405389】【第二十二轮：子测试已写（决定 44），41164440050 中因 daily 失败未执行，见 run 41167999147】machined 不可达时的一般降级已实现；还缺独立 VM 断言“此时新构建会被停止/拒绝”。需加一个 VM 检查或在已有检查里补断言。
4. **U11**：【第二十一轮已解决，决定 45，KVM run 41163076525 通过】已有兼容性拒绝和回退证据，但两个系统闭包里是同一份 AgentOS 代码。需要构造真正的旧代际（旧版本 AgentOS 代码）闭包，验证回退到旧代码代际后数据和服务正常。
5. **O09**：【第二十五轮：bcc9694 上 build-repro 与全部演练 job 通过（run 41173405389）；构建部分满足。规格 M10 要求由未参与实现的操作路径按文档完成演练，现有证据未从 ISO 启动、不按文档、分在四个 VM、候选未签名，保持部分（决定 57）。下一步：一台 VM 从 agentos-iso 启动按 RELEASE 文档走完安装、导入、升级失败回退、导出到第二台恢复；独立操作者部分需人工】【第二十四轮：bcc9694（run 41173405389）上 m6-install、m18-o09、m7-update、build-qcow2 已通过，build-repro 与 m6-qcow2 写定时在跑；它们通过则 O09 在 bcc9694 闭环】m6-install、m18-o09、m7-update 已在同一提交通过；需要 build-repro 在**同一提交**上也通过，四项组合才能算闭环。可复现构建中 native/node/shell/release/OCI/ISO 已逐位一致；qcow2 的 GPT/ESP 已固定（tpl_uuid 用 uuid5、normalize_template_esp），LUKS2 分区内的随机量（卷密钥、salt、UUID）由解释脚本说明；ESP install.json 计划哈希差异第二十一轮已修（决定 46）；41164440050 中剩下的 ESP 差异是空闲簇残留，第二十二轮已修（决定 48），待同一提交 build-repro 重跑。

### 5.2 现有环境做不到，保持“部分”

- **D02–D07、D09、D11、D12**：只有 Qt offscreen 单元测试，没有真实图形会话验收。
- **O01、O02**：只有 Host 级真实模型证据（两个 workspace、qwen3.8-flash、8 组重叠请求、无跨 workspace 泄漏、revision 升级回退保留记录）。原生 Qt/machined 路径需要把真实 key 放进 CI 或 VM，违反密钥约束，不做。
- **U01、U02、H03**：VM 部分已通过，实体磁盘/真实显卡部分需实体机。

### 5.3 需实体机（未验收）

D10（真实 Fcitx5 输入）、H01、H02、H04–H08、O04、O05（固定参考机计时），以及 U01/U02 实盘安装与更新、H03 真实显示输出、V3-E04 真实串口。验收命令和通过标准写在 `docs/ACCEPTANCE_V1.0.md` 的实体机一节。

### 5.4 O10

100 项证据齐全前保持未通过。不得宣称 v1.0 全部完成。

## 6. 已知偏离与限制（已写进报告）

- machine 数据库 schema 为 2（设计写 1），用于支持 workspace 删除 tombstone（W10）。
- 由同一 qcow2 模板克隆的机器共享 LUKS 卷密钥；首次启动只替换口令槽。
- 发行签名按规格在发布环境完成，仓库不含签名私钥。

## 7. 本轮测试抽出并已修的产品 bug（供回归参考）

网关事件不计入待发预算且 u64 计数回绕后丢回复；网关 unwrap 崩溃；被拒连接不关闭；备份屏障期间 Host 先迁移数据库（新增 `host.precheck`）；更新后健康检查永远通过；维护次数/冷却按 workspace 计可被绕过；额度最后一步被拒后名额泄漏；机器模式 permit key 格式错误导致代码应用无法构建；从未启动的 workspace 使整机备份失败；已取消任务显示为失败；Wi-Fi 密码链路未接通；离线安装包缺容器镜像；users.create 会话 epoch 问题；构建闸门 bodyHash。

## 8. 交付前检查

1. 清单、报告、进度三者状态一致，统计数字一致。
2. 扫描整个提交历史无密钥/内部地址。
3. `git status` 干净，只推送 `v1.0`。
4. 最终报告按第 1 节的证据等级分开写，并列出所有未完成项及原因。
