# AgentOS v1.0 外部审查修复交接（2026-11-01，进行中）

先读本文件、`V1.0_REVIEW_FIXES.md`、`V1.0_PROGRESS.md`、`HANDOFF_V1.0.md`、`V1.0_VM_TESTS.md`、`RELEASE_V1.0.md`。规格唯一基准是 `docs/AGENTOS_MVP_V1.0.md`。历史决定和旧 run 以 PROGRESS 为准，不要照抄旧交接中的过时待办。

## 0. 铁律

1. 本轮继续完成所有可由 VM/KVM 验证的项目：失败取证、修复、重跑；**最终固定完整 SHA 上全部 27 项成功**。不能只交半成品，不能拼接不同提交的绿灯宣称最终全量通过。
2. **规格 `docs/AGENTOS_MVP_V*.md` 不许修改。** 实体机和 WSL 不在本轮范围；独立操作者等人工要求不能自动替代。
3. **本地只编辑/Git；所有编译、运行、单元/集成及回归测试也在云端。** KVM 用 GitHub Actions；普通云端编译机无 KVM 的结果不算 KVM。
4. 只推 `cszf1/agentos` 的 `v1.0`；`main` 仍是 `2aaa004273a9548f45215c8faed7a395883c820b`，不得合并，除非完成后另获同意。
5. 作者只能 `cszf1 <246938975+cszf1@users.noreply.github.com>`。公开仓库推送前扫描新增行中的凭据、私钥、内部地址/主机信息；真实模型 key 不进仓库、CI 或 VM，CI/VM 一律 faux。
6. KVM、TCG、云端单元/集成、Host 真实模型、实体机分级；skip、ignored、部分成功、进行中均不计通过。不得用 root shell、SQL 写入、服务覆盖或降低断言造安装后系统的管理员验收。
7. workflow 仅改测试所需内容；不上传 ISO artifact、不创建 Release。最终清理本次临时资源，不删原构建机资料，不 hard reset、不盲做 GC。

## 1. 现状与证据

- 仓库：https://github.com/cszf1/agentos ，分支 `v1.0`。实际 HEAD 看 Git，最新候选/修复看 PROGRESS，实际验收提交看 Actions 的完整 `headSha`。
- 验收统计一致：**74 通过 / 15 部分 / 11 未通过**。I06、U05、R11、I08、U04 已恢复；D01/W08/U09 按完整 m5 41253718507 恢复，其他候选没有提前升项。
- 两轮审查原文：`docs/review/REVIEW_V1.0_EXTERNAL_2026-10-31.md`；逐项状态在 `V1.0_REVIEW_FIXES.md`。PROGRESS/TSV 当前续至决定 93，后续编号按最新尾项递增。
- 第一轮全量 `41220513266@4b1d863` 终态 **23 成功 / 4 失败**：失败 m5、m6-qcow2、m19、m20；其余包括 m18、build-repro、m3/m7 都成功。这不是最终全绿。
- 云端 Node 基线：typecheck/contracts:check、184 passed、4 skipped；Rust 基线：79 passed、1 ignored。最新云端 VM helper 单测 5+3+7+6+6 通过，**不是最终 KVM 的 27 项通过**。

### b7c16fb 的最近四项调试基线

| 测试 | run | 候选 |
|---|---|---|
| m6-qcow2 | 41253713306 | b7c16fb |
| m19-iso | 41253715864 | b7c16fb |
| m5-desktop | 41253718507 | b7c16fb |
| m20-sway | 41253721127 | b7c16fb |

该组终态：m5 成功，其他三项失败。后续 m20 41256274306@c7e4051 仍失败；后续 m6 41258546486@85c9575 已完整成功；最新两项候选见决定96，不把局部进展当最终 all 通过。

### 最近失败、已做的候选修复

- **m6 `41258546486@85c9575` 完整成功**：两个同模板克隆、独立新卷钥、模板旧钥拒绝、克隆2持久化重加密中的断电续作、正常重启身份保持均已走完。不得回退完整握手/持久化切电条件，最终 all 再回归。
- **m19 最新 `41258548913@85c9575`**：固定 driver 使用 imagemagick_light，nixpkgs 明确 libpngSupport=false，故新 OCR 读取 PNG 失败；候选走现有 pngtopnm→PNM→8-bit PGM，保留严格正则、空白帧等待与 stderr。云端实际函数处理管理员原失败图两模式严格成功，新启动未激活图亦正常；助手30项通过。完整链路仍待。
- **m5 `41253718507@b7c16fb` 完整成功**：真实鼠标聚焦后的 Shell 快捷键、锁/解锁、注销/再登录、四时刻权限/执行主体、diagnostics-only 等健康负面均通过。D01/W08/U09 已恢复；只在最终固定 SHA 全量再回归，不继续猜 PATH 根因或重复调试已解决项。
- **m20 最新 `41258551440@85c9575`**：全 CRUD 已过，milk done=true、删后total=1；随后发现真实 HomePage 忽略 ASelect.chosen，提交value为空且刷新重置目标。候选只补 HomePage 消费与 scopeCleared 清空，新增实际 value、真实只读列表刷新保持、跨工作区及锁/解锁后目标清空检查；完整剩余旅程仍待。

### 已有有效证据与边界

| 编号 | 现有证据 / 剩余 |
|---|---|
| F01 | m6 41258546486@85c9575 完整通过双克隆、卷钥、旧钥拒绝、断电恢复和重启身份；最终 all 再回归 |
| F02 / F08 | m5 41253718507@b7c16fb 完整通过，D01/W08 已恢复；U01 仍待 m19 |
| F03 / I06 | m10 KVM 已通过；最终矩阵再确认 |
| F04 / I08 | m3 `41208150103@6be1e0b` 通过，4b1d863 全量中的 m3 job 也成功，账本已恢复 |
| F05 | m6-install VM 已通过；真实盘断电部分仍需实体机 |
| F06 | 云端模型 relay policy 4 项通过；VM 不使用真实 key |
| F07 / R11 | m9 KVM 已通过；最终矩阵再确认 |
| F09 | `41208175425@6be1e0b` 及 4b1d863 的 build-repro 成功：六输出逐位一致；qcow2 解密树/闭包/NixDB 逻辑比较通过，不能写 qcow2 字节相同 |
| F10 | m2 KVM 已通过；最终矩阵再确认沙箱未回归 |
| F11 | m19 完整两机连贯演练仍待通过，不能仅凭安装子项升 U01 |
| F12 | m20 正在真实 Sway/QMP 路径迭代，不能拿 offscreen 代替 |
| F13 | 云端 versions 2、HTTP 7、model-relay-policy 4 项核实；productVersion=1.0.0，hostVersion=0.4.0 为兼容层 |
| F14 | workflow 覆盖已补；最终固定完整 SHA 的 all=27 尚未完成 |
| F15 / F16 | build-physical/build-audit 已成功；不等于实体机验收，测试 UUID 误报豁免不等于放过凭据 |
| R2-1 / U04 | m7 `41208171776@6be1e0b` 及 4b1d863 对应 job 成功，账本已恢复 |
| R2-2 / U09 | 单元、m7 与完整 m5 41253718507 已过，U09 已恢复；最终 all 再回归 |
| R2-3..5 | U05/U06、发行序号检查已有证据；最终矩阵再确认 |
| O09 | m18 `41217251403@34117e4` 与 4b1d863 对应 job 成功，正式管理员路径已验证；完整 ISO 连贯演练未通过，独立操作者要求仍需人工 |

## 2. 接下来按顺序做

1. 读 PROGRESS 与 Actions 最新运行；m5 已完整通过，不重复取旧失败作为现状。m6 后续已完整通过，剩余 m19/m20 按决定96继续修复重跑，不放宽安全、健康或 UI 断言。
2. m19 必须走完同一 ISO 安装两台、v0.4 导入、不健康试启动拒绝、known-good 回退、加密导出和新身份恢复。介质由活动本地会话用上游 udisks 策略挂载，材料复制到家目录；不扩大 root helper 路径白名单。
3. 离线可信时间必须显式核对：host/guest 差在规定边界内，再传 `--trusted-time`；不改到期字段、不关闭签名、NAR、序号或支持期检查。同一既有闭包的更高 sequence 不能冒称新代际下载证据。
4. m5/m20 完整成功后，逐项按覆盖更新 D01、W08、U09 和 D02–D07、D09、D11、D12；D09 未覆盖的慢读端/跨客户端有界部分明确保留，O09 的独立操作者保留。
5. 文档和修复定稿后，固定最终 SHA 手动 `test=all`；全部 27 项成功才满足本轮矩阵要求。若失败，修复后在新最终提交再跑全量。
6. 同步 ACCEPTANCE/CHECKLIST/HANDOFF/PROGRESS/REVIEW_FIXES/VM_TESTS/RELEASE，云端统计无 mismatch；最后清理临时测试资源，不合并 main、不发 ISO、不建 Release。

## 3. 运行方式与安全同步

- workflow：`.github/workflows/v1-vm-tests.yml`，19 个 VM + 8 个构建检查，另有 plan job，不把 plan 算入 27。
- 派发：`gh workflow run v1-vm-tests.yml -R cszf1/agentos --ref v1.0 -f test=<检查名或all>`。
- 查结果：`gh run view <run> -R cszf1/agentos --json headSha,status,conclusion,jobs`；失败用 `--log-failed` 和日志 artifact。
- 原云仓库的 origin 可能是本地 bundle；先检查 remote/工作树。无修改且 HEAD 是目标祖先时，才可按公开 URL fetch 并 ff-only：
  ```sh
  git fetch https://github.com/cszf1/agentos.git refs/heads/v1.0:refs/remotes/github/v1.0
  git merge-base --is-ancestor HEAD github/v1.0
  git merge --ff-only github/v1.0
  ```
  不把 hard reset 当同步方法；有 dirty 或分叉先查清楚，不能覆盖。
- 云编译机空间有限，先查容量和活跃构建，不盲 GC、不用通配删除原资料。本次临时机不注入 Vault/Secrets，任务结束精确删除。
- 本地不执行 Node/Rust/Python 测试或文档工具；只保留编辑/Git。

## 4. 文档工具（只在云端运行）

- `python3 -B docs/tools/v1doc.py stats`：重算并要求 `checklist mismatch: []`。
- `echo '实际证据' | python3 -B docs/tools/v1doc.py set V1-I08 通过 'KVM VM（Actions）' '检查说明'`：示例，不重复给已通过项造新证据。
- `python3 -B docs/tools/rfset.py F04 '状态' '提交' '证据' '剩余'`：维护审查行。
- 正确验收文件名为 `docs/ACCEPTANCE_V1.0.md`；ISO 定义在 `os/flake.nix`，安装器包装在 `os/packages/installer.nix`。

## 5. 不冒充完成的人工项

实体机/真实输入法、真实盘与显卡、参考机计时、真实串口，以及 O09 独立操作者。O01/O02 的原生真实模型路径不通过向 VM 注入真实 key 完成；O10 在 100 项证据齐全前仍未通过。最终报告分级列出原因，不宣称全部 v1.0 已完成或发布。
