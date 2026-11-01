# AgentOS v1.0 外部审查修复交接（2026-11-01，进行中）

先读本文件、`V1.0_REVIEW_FIXES.md`、`V1.0_PROGRESS.md`、`HANDOFF_V1.0.md`、`V1.0_VM_TESTS.md`、`RELEASE_V1.0.md`。规格唯一基准是 `docs/AGENTOS_MVP_V1.0.md`。历史决定和旧 run 以 PROGRESS 为准，不要照抄旧交接中的过时待办。

## 0. 铁律

1. 本轮继续完成所有可由 VM/KVM 验证的项目（用户已确认先继续VM，实机与64GB精简后续再做）：失败取证、修复、重跑；**最终固定完整 SHA 上全部 27 项成功**。不能只交半成品，不能拼接不同提交的绿灯宣称最终全量通过。
2. **规格 `docs/AGENTOS_MVP_V*.md` 不许修改。** 实体机和 WSL 不在本轮范围；独立操作者等人工要求不能自动替代。
3. **本地只编辑/Git；所有编译、运行、单元/集成及回归测试也在云端。** KVM 用 GitHub Actions；普通云端编译机无 KVM 的结果不算 KVM。
4. 只推 `cszf1/agentos` 的 `v1.0`；`main` 仍是 `2aaa004273a9548f45215c8faed7a395883c820b`，不得合并，除非完成后另获同意。
5. 作者只能 `cszf1 <246938975+cszf1@users.noreply.github.com>`。公开仓库推送前扫描新增行中的凭据、私钥、内部地址/主机信息；真实模型 key 不进仓库、CI 或 VM，CI/VM 一律 faux。
6. KVM、TCG、云端单元/集成、Host 真实模型、实体机分级；skip、ignored、部分成功、进行中均不计通过。不得用 root shell、SQL 写入、服务覆盖或降低断言造安装后系统的管理员验收。
7. workflow 仅改测试所需内容；不上传 ISO artifact、不创建 Release。最终清理本次临时资源，不删原构建机资料，不 hard reset、不盲做 GC。

## 1. 现状与证据

- 仓库：https://github.com/cszf1/agentos ，分支 `v1.0`。实际 HEAD 看 Git，最新候选/修复看 PROGRESS，实际验收提交看 Actions 的完整 `headSha`。
- 验收统计一致：**74 通过 / 15 部分 / 11 未通过**。I06、U05、R11、I08、U04 已恢复；D01/W08/U09 按完整 m5 41253718507 恢复，其他候选没有提前升项。
- 两轮审查原文：`docs/review/REVIEW_V1.0_EXTERNAL_2026-10-31.md`；逐项状态在 `V1.0_REVIEW_FIXES.md`。PROGRESS/TSV 当前续至决定 106，后续编号按最新尾项递增。
- 第一轮全量 `41220513266@4b1d863` 终态 **23 成功 / 4 失败**：失败 m5、m6-qcow2、m19、m20；其余包括 m18、build-repro、m3/m7 都成功。这不是最终全绿。
- e2159d6固定SHA的云端Node typecheck/contracts、184pass/4skip、Rust81pass/1ignored（27组/exit0）均通过；决定100候选同计数，另有Qt九套ctest/三种子fuzz/E2E编译通过、决定101另经Qt九套/E2E编译；决定105候选Qt九套/E2E编译及VM helper50项（5+3+7+6+16+2+4+3+4）通过。**不是最终KVM的27项通过**。

### b7c16fb 的最近四项调试基线

| 测试 | run | 候选 |
|---|---|---|
| m6-qcow2 | 41253713306 | b7c16fb |
| m19-iso | 41253715864 | b7c16fb |
| m5-desktop | 41253718507 | b7c16fb |
| m20-sway | 41253721127 | b7c16fb |

该组终态：m5 成功，其他三项失败。后续 m20 41256274306@c7e4051 仍失败；后续 m6 41258546486@85c9575 已完整成功；最新两项候选见决定96，不把局部进展当最终 all 通过。

### fbafdc2d1fbc58e3afeba434a3e961293337027d 的最新两项运行取证（决定96）

| 测试 | run | 候选 | 终态 |
|---|---|---|---|
| m19-iso | 41262196844 | fbafdc2 | 失败：提取 FAILED-SCREEN iso-failure-1 确认已到 password:，Tesseract 4.1.3 对黑底白字稀疏行字符方块噪声将该行误识为 U I B TR |
| m20-sway | 41262199646 | fbafdc2 | 失败：257 行 targetValue() == todo 证实选择成功；但刷新前 r.runIds() 调用了 go("tasks")，导致 Loader 销毁 Home 页面，切回后重建表单变回初始空值 |

### 65a8c3904e0b35128681359638554d2e6305d7b4 的最新两项运行取证（决定97）

| 测试 | run | 候选 | 终态 |
|---|---|---|---|
| m19-iso | 41266847934 | 65a8c39 | 失败：多变体 OCR 完整通过控制台首次设置并进入 ReGreet 图形界面；等待正则设为 Login，但 ReGreet 界面大字标题实际为 Welcome back!，导致超时 |
| m20-sway | 41266853527 | 65a8c39 | 失败：CRUD全部、目标选择、优先级、版本切换及代码注入全部通过；在分页测试步骤，下一页按钮因20条记录表格垂直展开位于 y=1122 处于 800 高度窗口外，click 被拦截 |

### 6852b1c 失败与决定99（历史，已推e2159d6）

- **m19 `41272160495@6852b1c396f4b5b7e3a032072e7ea4b540f00c02`**：ISO/首次设置/ReGreet/Shell/正常管理员tty/v0.4导入均已越过；停在 `admin update trust-key`，gateway和machined的秘密字段过滤误拒绝公开的keyId/publicKey。新回归在两层旧代码上分别复现同一INVALID_REQUEST。候选共享精确的 `admin.update + step=trust-key + keyId/publicKey` 例外，固定argv的格式验证和PAM/ticket/角色/锁屏防线不变；私钥、provider key、大小写/后缀变体、错误动作/步骤仍拒绝。完整Rust81pass/1ignored，助手32pass；完整KVM尚待。
- **m20 `41272167100@6852b1c`**：275行choose目标应用失败，是全局ensureVisible引入的新回归；它会修改弹窗ListView的contentY且未钳位上限。候选移除通用滚动，恢复此前点击行为，只在20行分页步骤通过真实QMP wheel将按钮完整滚入输出，再检查真实点击与页/行数变化，不放宽原断言。完整KVM尚待。
- **m19快速失败取证**：操作者脚本遇错输出 `AOS-DRILL-FAILED` 后继续抛出原错，屏幕等待优先判失败，避免静态错误后空等1200秒；新增2项真实helper测试覆盖立即失败及失败优先于其他OCR变体的成功。
- **m6 `41258546486@85c9575` 完整成功**：两个同模板克隆、独立新卷钥、模板旧钥拒绝、克隆2持久化重加密中的断电续作、正常重启身份保持均已走完。不得回退完整握手/持久化切电条件，最终 all 再回归。
- **m5 `41253718507@b7c16fb` 完整成功**：真实鼠标聚焦后的 Shell 快捷键、锁/解锁、注销/再登录、四时刻权限/执行主体、diagnostics-only 等健康负面均通过。D01/W08/U09 已恢复；只在最终固定 SHA 全量再回归。

### 最新 e2159d6891b486e8c75d947e79cebbba8930fbe7 终态与决定100候选

- **m19 `41277703466` 失败**：公钥登记、adopt-base、候选verify/fetch/activate全部完成；真实失败PNG显示 `AOS-TRIAL-ARMED`，六种OCR却一致读成 `ADS-TRIAL-ARMED`。尚未进行候选重启/健康拒绝/回退。现同步更换发送端和等待端为固定 `PASS-…` 消息（失败为 `FAIL-DRILL-FAILED`），转义后整行匹配；不接受旧误读、错误阶段或子串/后缀，不降低操作断言。
- **m20 `41277705633` 失败**：目标选择、刷新保持、版本/注入、真实滚轮分页26条、组件与非法树拒绝、列表滚动/预算均已通过，停在509行查找不存在的“静音”。真实machined不公布音频能力，UI不可模拟成功。决定100新增已有owner-only后台策略的正式工作区按钮与只读策略字段，同步TS/C++固定目录/93动作向量、真实plan.kind标题；D07改用该固定机器动作，必须成功收据/applied/ticket消费、锁屏撤回不消费，再确认恢复默认false。
- **候选验证**：缺UI/列表字段的回归先红后绿；Qt6.11.2九套ctest、三种子各2000轮fuzz、E2E编译通过；Rust81pass/1ignored、Node184pass/4skip、typecheck/contracts/slot-vectors通过；助手34项（5+3+7+6+13）、28个Python AST及drill语法/self-test/错误非零通过。不是完整Sway或最终全27通过。
- **边界**：D07的owner策略不是管理员硬件/PAM图形输入验收，不声称音频等实机功能可用；m19管理员仍走普通用户PAM→gateway→ticket→固定root helper。两条完整KVM须在决定100提交后重跑，统计仍74/15/11。

### 决定106（当前）

- `41297711680@8384e0f` m19完整成功，artifact13081406268，1453.74s：同ISO两安装、导入、真实健康拒绝/known-good回退、加密导出、第二管理员恢复及最终根锁/启动只读取证。不是独立操作者或新代码代际下载证据。
- 同SHA m20 `41297714218`（artifact13080447753）已过D09：完整302响应/300记录/撤权revoked、1033事件/gap1/revokeSeen、跨工作区0/协议错0；止649行Host降级判断。真实machine.status没有components，旧通用成功回调和缺省健康值把Host误标可用，非D09再次失败；最终SQL postlude未执行。
- 3项真实形状Qt回归旧源码3fail：Host/Broker健康误判、锁后旧通知重新填充。只允许实际workspace.forward成功标Host恢复，定期读当前Host的state（原5秒timer每3tick）且只更新可用性、不reset画布；Broker取真实brokerReady。onLocked统一推进scopeGen。测试预算对应已有轮询周期，生产/KVM超时与安全断言未改。
- 独立UDS bridge单元（脚本化HTTP/registry，不是真实Host鉴权）旧3fail：缺wire水位、未来游标错误成功、重放缺水位；新4项含1001事件溢出与快照后无旧burst重放全部绿。Native快照通过已有主体授权读取，校验水位/epoch，cursor/eventCursor一致，不默认0；Host新连接发gap。订阅绑定主体/epoch/boot/期限，实际投递重用live检查logind与成员，新增4项Native回归。
- 候选Qt9/E2E编译、Node188pass/4skip、Rust85pass/1ignored通过；helpers50/AST32不变。真实logind正向投递与开销必须KVM再验；新闭包m19/m20和最终同SHA全27仍待，74/15/11不升项。

### 决定105（历史）

- m19 `41289530427@6da488c` 已真实完成Login、两次有界关机、候选健康拒绝、known-good启动/记录核对与加密导出verified，止OCR的VERIF IED分词；第二机恢复及最终postlude未执行。固定协议消息允许字符间ASCII水平空白，但仍整行、同字符顺序，拒绝跨行/错字/前后缀，失败优先。3项回归旧源码4个subcase失败，helper50/AST32绿，真实日志6/6变体通过。
- m20严格连接先bind及断线期间锁/epoch的3项Qt回归，在旧产品代码实际3fail。绑定成功先清主体/epoch/锁变化的敏感状态并失效旧回调；解锁后显式reattach当前工作区，恢复快照和事件流；同认证重连保留草稿/剪贴板。3项绿、完整9套ctest与E2E编译绿，不等于实际Wayland/KVM绿。
- 后续同SHA重跑m19/m20，仍须核实真实慢读者/游标重读/Host代际、第二机恢复和最终根收据；最终all27未过，不升项。
- 用户当前目标收敛VM Edition，Windows桌面目标讨论VMware；本轮只继续现有云端QEMU回归修复。VMware适配、系统精简、前端改版另阶段，实体项不冒称通过，冻结规格不改。

### 决定104（历史）

- m19 `41285496688@c55086c` 首次ReGreet按Enter后仍停账号/会话选择页；真实Login按钮存在，未到密码页也未检验有界关机修复。改按实际PNG的冻结GTK主色定位唯一按钮并QMP点击（真实失败帧中心967,487），零/多候选失败，仍等Password才输口令。新增4项纯像素回归和实际帧验证，helper47/Python32 AST通过，待新m19完整KVM。
- m20 `41286508130@d49768d` 已完整文件传输和302请求/300记录/撤权revoked，止D09零新增事件。只读已核实新连接先自动订阅后绑定，被SESSION_REQUIRED拒绝；绑定后现工作区不为空故未reattach，订阅没有恢复。下一步补严格绑定前置的真实socket回归再修；不降低压力或伪造事件。
- 两项均失败，不把子段或未运行的最终SQL postlude当整项通过；最终同SHA全27仍待。

### 决定103（历史）

- m20 `41284124280@4731cc4` 三个确认框scanout均108/108；取消中心从449.9,522.5移到449.9,552.5，实际Wayland证实旧几何会过早取点。取消、锁屏UI撤回、恢复后台默认值已越过；首笔根收据可见，但最终postlude的stale/restore逐hash根收据未执行，不能算D07整项通过。
- 当前止D09的burst-prepare，300 CRUD+bind+revoke共302请求在单个bash-c参数中超过Linux上限，真实exit126。决定103通过NamedTemporaryFile+驱动copy_from_host共享目录传完整UTF8，chmod0644，不减少压力；实际旧源码bash E2BIG红后，3项字节/数量/短参数/模式/错误清理回归转绿，CI接入，helper43/Python31 AST全过。实际VM共享复制及完整慢读者仍待新KVM。
- m19 `41285496688@c55086c` 仍在重跑决定102；不要取消或把运行中计通过。最终仍须同固定SHA全27。

### 决定102（历史）

- m19 `41282001484@3476f0e` 已通过新PASS消息和候选激活；在关机等待被驱动API的非法timeout关键字中断。固定驱动原方法无timeout且内部无界wait；候选以Popen.wait(timeout=180)先有界等待、exit0后再用原零参数API清理状态并start，不强制断电、不跳管理员PAM/解锁/健康门槛。
- 四项真实子进程回归在旧helper均复现TypeError，修后正常退出/超时/非零退出/无进程全过；CI接入，helper40及Python30 AST通过。完整m19仍待重跑，健康拒绝/回退/第二机恢复未计通过。
- m20 `41284124280@4731cc4` 仍待终态；它是决定101的扫描/活窗取证候选，不预判根因或成功。最终仍须同固定SHA全27。

### 3476f0e 后续与决定101（历史）

- 当时m19 `41282001484` 仍在完整KVM中；终态及后续见决定102，不把当时的运行中计通过。
- m20 `41282003990` 已通过真实owner后台策略首笔确认（reconciled、数据库后台值1），在应用说明的取消按钮539行clicked=0。离屏Qt真实mouseClick探针未复现位移，不能宣称已证实布局问题。
- 决定101补每个确认框的实际扫描对照、取消前后坐标、零次clicked的QPointer存活状态和窗口尚存时的真实PNG；不放宽点击/权限/数据断言。Qt九套、E2E编译、helper36和29个Python AST已过，实际Sway根因及完整旅程待新KVM。先取m19终态并重跑m20，最终仍同固定SHA全27。

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
