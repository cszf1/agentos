# AgentOS v1.0 交接文档

更新时间：2026-11-01。**外部审查修复仍在进行中，不是完成或发布声明。**
分支：`v1.0`（实际 HEAD 以 `git log -1` 为准）；每次测试以 Actions 的完整 `headSha` 对照 PROGRESS，不能把文档提交或局部成功当最终全矩阵证据。`main` 不得改动。

## 1. 必须遵守的约束

- 规格文档 `docs/AGENTOS_MVP_V*.md` **不许修改**；v1.0 唯一规格是 `docs/AGENTOS_MVP_V1.0.md`（100 项）。不能跳过未完成项或把部分证据写成全部通过。
- **本地只编辑文件、操作 Git；所有编译、运行、单元/集成及回归测试都在云端。** KVM 验收用 GitHub Actions 的公开 hosted runner；没有 KVM 的云端编译机不冒充 KVM。
- 只推 `cszf1/agentos` 的 `v1.0`；合并 `main` 必须另获用户同意。作者仅 `cszf1 <246938975+cszf1@users.noreply.github.com>`。
- 公开仓库禁止凭据、私钥、真实模型 key、内部地址/主机信息；推送前检查新增行。真实模型 key 不进入 CI、VM 或镜像，CI/VM 一律 faux。
- KVM、TCG、云端单元/集成、Host 真实模型、实体机证据分开；跳过、ignored、部分成功和正在运行均不计为通过。实体机和 WSL 不在本轮范围。
- 安装后的发行系统按普通管理员路径操作：PAM → gateway 固定管理动作 → 一次性 ticket → 固定 root helper。不得靠 root shell、SQL 写入或服务覆盖造验收；恢复介质的事后只读取证不是替代管理员操作。
- workflow 只改测试所需内容；**不上传 ISO artifact、不创建 GitHub Release**。最终必须在固定完整 SHA 上 `test=all` 全部 27 项成功，不能拼接多个提交的单项绿灯。
- 云端同步先查工作树、fetch、核验祖先再 ff-only；不 hard reset、不覆盖他人修改、不盲做 Nix GC。结束时精确清理本次临时资源，不删原构建机资料。

## 2. 关键文件

| 文件 | 内容 |
|---|---|
| `docs/AGENTOS_MVP_V1.0.md` | 唯一规格，只读 |
| `docs/V1.0_CHECKLIST.md`、`docs/ACCEPTANCE_V1.0.md` | 100 项状态、证据与未完成原因 |
| `docs/V1.0_PROGRESS.md`、`docs/v1.0-decisions.tsv` | 设计决定与历史状态，持续追加 |
| `docs/V1.0_REVIEW_FIXES.md` | F01–F16、R2-1..5 的修复证据与剩余 |
| `docs/HANDOFF_V1.0_REVIEW_FIX.md` | 当前外审修复的运行任务与下一步 |
| `docs/V1.0_VM_TESTS.md` | VM 检查覆盖范围 |
| `docs/RELEASE_V1.0.md` | 发行/管理员操作说明、硬件限制 |
| `docs/evidence/` | 既有证据；Host 真实模型证据不冒充原生 VM 路径 |
| `.github/workflows/v1-vm-tests.yml` | 19 个 VM 检查 + 8 个构建检查，共 27 项；另有 plan job |

## 3. 如何构建和测试

以下命令**只在云端仓库运行**，不是本地执行建议：

- Node 24 / pnpm 10：按 `package.json` 的 typecheck、contracts:check、unit、integration 脚本执行。
- Rust 1.91.0：`cd native && cargo test --locked --workspace -- --test-threads=1`。
- KVM：`gh workflow run v1-vm-tests.yml -R cszf1/agentos --ref v1.0 -f test=<检查名或all>`。从 run 的 `headSha` 核验完整提交，不猜短码。
- 中间修复可用 `[skip ci]` 提交后手动单项；不同 SHA 的 concurrency group 已分离，不会被过时同名测试堵住。同 SHA 同测试仍串行，`cancel-in-progress: false`。
- 失败查 job 日志和 `vm-<test>-logs` artifact；不能因旧提交成功而给新提交记通过。
- 每次更改验收状态后，在云端运行 `python3 -B docs/tools/v1doc.py stats`，要求 `checklist mismatch: []`。审查行用 `docs/tools/rfset.py` 维护。

## 4. 当前状态（交接时）

**74 通过 / 15 部分 / 11 未通过**（按完整 m3/m7 恢复 I08、U04，按完整 m5 恢复 D01、W08、U09；其余候选未提前升项）

| 证据等级 | 通过 | 部分 | 未通过 |
|---|---|---|---|
| KVM（Actions） | 62 | 3 | 0 |
| TCG VM | 0 | 0 | 0 |
| 单元/集成 | 12 | 10 | 0 |
| Host 级真实模型 | 0 | 2 | 0 |
| 需实体机，未验收 | 0 | 0 | 10 |
| 无可用证据（O10） | 0 | 0 | 1 |
| 合计 | 74 | 15 | 11 |

分级与 ACCEPTANCE 总表相同，每项只计最高证据级别；U01、U02、H03 的实体部分另列，不重复计数。

- 第一轮外审修复全量 `41220513266@4b1d863` 已完成：**23 成功 / 4 失败**（m5、m6-qcow2、m19、m20）。m18、增强 build-repro、m3、m7 在其中成功；该 run 不是最终全绿。
- 完整单项成功：m5 `41253718507@b7c16fb`、m6 `41258546486@85c9575`；最终同SHA矩阵仍须回归。最新e2159d6的m19 `41277703466` 已完整走完签名候选activate，但真实成功消息AOS被OCR读成ADS；m20 `41277705633` 已越过选择、分页、组件和列表，停在真实后端不提供的“静音”。决定100同步换固定整行PASS消息，并用已有owner-only后台策略实际验证可信确认/成功ticket收据/锁屏撤回/恢复默认；两条完整KVM仍待。
- e2159d6固定SHA云端Node typecheck/contracts、184pass/4skip、Rust81pass/1ignored（27组/exit0）通过。决定100候选同计数，另有Qt九套ctest、三种子各2000轮fuzz、E2E编译通过。它们不是最终KVM矩阵或真实模型证据。
- 云端VM助手52项（5+3+7+6+18+2+4+3+4）、32个Python AST、drill语法/self-test/非零错误消息通过；新消息严格整行匹配，错误阶段/子串不算成功。**不是KVM矩阵27项通过**，最新见PROGRESS决定107。
- 可复现比较已核实六输出逐位一致；qcow2 解密树、闭包及 Nix DB 逻辑内容一致，允许的物理布局差异有窄解释。不能写成 qcow2 字节相同。

## 5. 剩余工作（按优先级）

### 5.1 当前 VM/KVM 工作

1. 8384e0f有完整m19成功；5083f3c的41308977956第一机/源盘取证已过，第二机CtrlAltF2后仍Greeter，107按真实输出重选至两帧TTY再登录。m20 41308980957已过D09及Host停止/恢复，止Bob事件缺userId误停Alice写入。107修目标白名单、歧义先停写后向原生目录查权（旧回复/Viewer不能解封）、Gap与记录提示重读视图但保留草稿；Qt9/E2E、Node190/4skip、helper52/AST32候选绿。新SHA完整KVM、SQL postlude及all27仍待，不拼子段。
2. m6 `41258546486@85c9575` 已完整验证两克隆独立卷密钥、模板旧钥拒绝、断电续作及重启身份；保持完整握手和持久化切电条件，在最终固定 SHA 全矩阵再回归。
3. m5 `41253718507` 已完整通过并恢复 D01、W08、U09；保留其真实 ReGreet、点击/缩放、重启、锁/注销、权限范围与健康负面断言，在固定最终全矩阵再回归，不重复把已解决根因当待办。
4. m19：同一发行 ISO 完成两机连贯演练：安装 → v0.4 导入 → 签名候选试启动不健康被拒 → known-good 回退 → 加密导出 → 第二台 ISO 安装后恢复。只用正式管理员入口。现有同闭包高 sequence 候选不等于新代码代际下载证据。
5. m20：真实Sway/Wayland + QMP输入、像素、数据库核对；D07采用真实owner后台策略，不冒充管理员硬件/PAM图形入口或音频验收；按实际覆盖更新 D02–D07、D09、D11、D12。D09 未覆盖的慢读端/跨客户端有界部分不能被单机局部结果替代。
6. 所有修复及账本定稿后，在固定完整 SHA 派发 `test=all`；全部 27 项成功才满足本轮最终矩阵要求。如失败，继续修复并在新最终提交重跑。

### 5.2 必须保留的证据边界

- O01、O02：已有 Host 真实模型部分证据；原生 Qt/machined 真实模型路径未验收，不能向 VM/CI 放真实 key 来补。
- O09：自动两机演练即使通过，也不替代未参与实现的独立操作者按文档验收。构建比对、m18 或多个拆分用例成功不等于整项通过。
- U01、U02、H03：VM 范围与真实盘/真实显示输出范围分开记录。

### 5.3 需实体机（未验收）

D10（真实 Fcitx5 输入）、H01、H02、H04–H08、O04、O05，以及 U01/U02 实盘安装与更新、H03 真实显示输出、V3-E04 真实串口。命令和标准见 ACCEPTANCE 的实体机一节；不在本轮自动化中冒充完成。

### 5.4 O10

100 项证据齐全前保持未通过。即使本轮最终 27 项全绿，也不得宣称 v1.0 全部 100 项完成或已经发布。

## 6. 已知偏离与限制

- machine 数据库 schema 为 2（设计写 1），用于 workspace 删除 tombstone；保留兼容性说明，不修改规格。
- qcow2 首启在线重加密已由完整 m6 `41258546486@85c9575` 验证独立卷钥、旧钥拒绝及断电恢复；实体安全边界不冒称已验。
- `productVersion=1.0.0`；`hostVersion=0.4.0` 是兼容层版本，不能混称产品版本。
- 发行签名在发布环境完成，仓库不含发行签名私钥；VM 测试签名/age identity 是临时夹具，不代表真实密钥管理方案。

## 7. 历史修复与回归参考

历史已解决问题不再列为当前待办：W09、U11、O03、W05、S08 的证据和各轮失败/修复在 PROGRESS；两轮外审原文在 `docs/review/`。不要重复调查旧根因或重新派发已过时 run。

## 8. 交付前检查

1. ACCEPTANCE、CHECKLIST、HANDOFF、PROGRESS、REVIEW_FIXES 与 VM/RELEASE 说明按实际证据同步，云端工具检查统计一致。
2. 检查新增行与全历史扫描，确认规格未修改、无凭据/内部信息；按指定身份只推 `v1.0`。
3. 固定最终完整 SHA 上全部 27 项成功，报告链接与完整 SHA；源树干净。
4. 精确清理本次 preflight、下载/调试输出和两台临时单元机，保留原构建机资料与最终证据。
5. 分别列出云端单元、KVM、真实模型和实体机/人工遗留；不合并 main、不上传 ISO、不建 Release。
