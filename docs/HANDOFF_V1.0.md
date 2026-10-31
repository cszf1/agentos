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
| `docs/V1.0_PROGRESS.md` | 进度日志和设计决定 1–41；续做前先读 |
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

**69 通过 / 20 部分 / 11 未通过**

| 证据等级 | 通过 | 部分 | 未通过 |
|---|---|---|---|
| KVM（Actions） | 57 | 6 | 0 |
| 单元/集成 | 12 | 12 | 0 |
| Host 级真实模型 | 0 | 2 | 0 |
| 需实体机 | 0 | 0 | 10 |
| O10（发布完成） | 0 | 0 | 1 |

最近一轮 Actions：m6-install、m18-o09、m7-update、m12-clone、m6-qcow2 通过；m2、m3、m5、m8–m11、m14–m16 及 build-release/iso/oci/qcow2/shell/audit 之前已通过。m13-native 和 m17-shared 失败（见下）；build-repro 交接时尚未出结果。

## 5. 剩余工作（按优先级）

### 5.1 需要改代码或补测试

1. **W09（m17-shared）**：两个 workspace 共享物理资源时，broker 调用 machined 的 `registry.pull` 每 10 秒读超时一次，registry 同步失败。新资源缺 `resource_state` 行的问题已修（broker `apply_observation`）。下一步：查 machined 侧 `registry.pull` 处理是否阻塞（锁、等待资源状态、请求帧未结束），在 VM 日志里对照 broker 与 machined 的时间线。
2. **O03、W05（m13-native）**：daily 阶段之后写记录失败。O03 返回 403；W05 的请求没有到达 Host。O03 的“生成不可用”部分已通过；D08、M06 已通过。下一步：查 daily 阶段后 session/memberVersion/权限令牌是否被轮换（403 常见原因），以及 W05 的请求在网关还是代理层被丢。
3. **S08**：machined 不可达时的一般降级已实现；还缺独立 VM 断言“此时新构建会被停止/拒绝”。需加一个 VM 检查或在已有检查里补断言。
4. **U11**：已有兼容性拒绝和回退证据，但两个系统闭包里是同一份 AgentOS 代码。需要构造真正的旧代际（旧版本 AgentOS 代码）闭包，验证回退到旧代码代际后数据和服务正常。
5. **O09**：m6-install、m18-o09、m7-update 已在同一提交通过；需要 build-repro 在**同一提交**上也通过，四项组合才能算闭环。可复现构建中 native/node/shell/release/OCI/ISO 已逐位一致；qcow2 差异集中在 LUKS/GPT/ESP 随机量，需要固定这些随机源或在报告中说明范围。

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
