# 外部审查（两轮）对 AgentOS v1.0 @2aaa004 的修复清单 — 用户 2026-10-31 19:46 指示"按照两轮结果修改"

全部要修。每项：改代码 + 加回归测试（能在 KVM/单元跑的就跑）+ 更新 ACCEPTANCE/CHECKLIST/PROGRESS。做不到的项写明原因，不能写成通过。

## 第一轮
- F01 阻断 U03/B08/O10 os/.../disk-layout.nix:7–16,48–54：qcow2 模板克隆共享 LUKS 卷主密钥（首启只换口令槽）。修：首启在写用户数据前生成独立卷密钥（cryptsetup reencrypt 在线重加密，或首启初始化空白数据分区）；加反向测试：两份克隆 `cryptsetup luksDump --dump-volume-key`（或比较 master key digest）必须不同，且旧模板口令/旧卷密钥无法解开克隆。
- F02 严重 D01/U01 os/tests/m5-desktop.py:8–20：用真实 greetd/ReGreet 路径登录（不手打 exec agentos-session），测登录、注销、再登录、失败恢复。
- F03 严重 I06：撤权与写提交精确竞争窗口：两个同步客户端，在 DB 提交前、成员代次变化后、最终 ACK 前注入故障，检查提交事实、撤权状态、UI 结果一致。
- F04 严重 I08：分别断开 broker↔machined、broker↔Host，在撤权前后注入执行请求，验证已登记操作、未知效果、重连、最终 ACK 与执行者 fence。
- F05 严重 U02/U01 installer:21–22,70–85、m6-install.nix:91–101：安装恢复状态在 /run，断电后丢失。修：恢复状态持久化到目标盘（或安装介质）；断电后只读识别 + 显式恢复入口；测试用 machine.crash() 后重新从安装介质启动再续作。另：serial→WWN→maj:min 回退里 maj:min 不是稳定身份，不能当跨重启盘身份；检查拒绝错误盘、已有分区、同型号多盘、无序列号盘。
- F06 严重 I11/O08 scripts/model-relay-forward.mjs:4–8,18–22：未设 AGENTOS_MODEL_BASE_URL 时默认外部地址并带真实 Bearer。修：真实凭据模式必须显式给 URL 并校验（https、白名单/显式确认），拒绝跨源重定向。
- F07 严重 R11 server.rs:55–84、m9-restore.py:195–216：只丢 broker 日志、machine 目录完整时，补完整恢复演练（恢复模式 + 新身份流程，经明确授权），不靠另删 machine.sqlite。
- F08 一般 W08：锁屏、注销、重新登录时分别比较维护策略有效范围、执行主体、broker 权限。
- F09 一般 O09 repro-explain-qcow2.py:87–105：用构建时公开模板口令解锁两份镜像，比较 Btrfs 文件树、权限、Nix 闭包、内容哈希。
- F10 一般 B08/O07 agentos.nix:118–135,183–203：root 的 machined 和 broker 加 systemd 沙箱与资源限制（NoNewPrivileges、CapabilityBoundingSet、RestrictAddressFamilies、ProtectSystem/ReadWritePaths、LimitNOFILE/MemoryMax 等，按实际需要最小化），systemd-analyze security 记录 + 回归。
- F11 一般 U01/O09 m6-install.nix:5–14：用最终 ISO 作为唯一安装入口，在干净 UEFI VM 安装、首次解锁、ReGreet 登录、桌面应用主流程。
- F12 一般 M06/D08 m13-native.py:41–58：保留 offscreen，另补真实 Wayland（Sway）输出 + 键鼠输入 + 像素检查的关键用户旅程。
- F13 一般 B01/O10 package.json:3、contracts/index.ts:17–18：区分 runtime 协议兼容版本与产品发行版本 1.0.0，统一 doctor、包元数据、发行清单。
- F14 一般 O10 v1-vm-tests.yml:1–17：确保最终发行提交本身跑全部构建/审计/KVM（workflow 触发路径/分支覆盖补全，如 scripts/**、docs 不触发即可）；报告记录完整 SHA。
- F15 建议 H01–H08 flake.nix:25–26、agentos.nix:21–26、qemu.nix：新增独立实体机 profile（Intel/AMD：initrd 驱动、Mesa/KMS、固件、NVMe、电源管理），不要把 qemu profile 改名；实体部分标"需实体机，未验收"。
- F16 建议 B08 release-audit.py:66–101：分层审计：发行闭包扫描、源码全 Git 历史秘密扫描（如 gitleaks/trufflehog 跑全部提交对象）、依赖漏洞审查、签名验证分别记录。

## 第二轮
- R2-1 严重 U04 ctl.rs:221–236、m7-update.py:145–153,184–196：update verify 只比对索引 imageId 和文件存在；测试用 `echo archive` 冒充归档。修：校验 images.tar.sha256（签进清单）与真实内容；导入隔离镜像存储后核对镜像 ID；负面测试：字节翻转、替换 manifest、改 layer、截断、索引对但内容错。正向用真实 OCI 归档。
- R2-2 严重 U09 update-worker/src/health.rs:68–81、broker server.rs:55–80,113–128：健康门槛只看 broker socket 存在；diagnostics-only 仍 READY=1。修：健康门槛走 broker 协议读身份/日志状态/可用性（brokerReady）；图形检查关联实际登录会话与 Wayland 输出。回归：broker 进 diagnostics-only 但 socket 与服务 active，更新绝不提交。
- R2-3 严重 U05 release.rs:140–169、dir.rs:75–86、tests.rs:762–773：rotate_key 两个事务；INSERT OR IGNORE 静默忽略重复 keyId 不同公钥。修：信任新钥+冲突检查+吊销旧钥+审计同一事务；重复 keyId 仅公钥相同才幂等，否则报冲突。回归：重复 keyId、轮换中断。
- R2-4 一般 U06 ctl.rs:936–974、m16-fetch.py:63–107：update fetch 不校验 --closure 是否等于该 updateId 目标发行的 closurePath。修：下载前核对发行 ID/manifestHash/closurePath，进入 staged 前再确认；测试传另一合法闭包被拒。
- R2-5 一般 U05/O10 os/release.py:64–75：releaseSequence 固定 1。修：单调序列号分配机制（参数/签名环境输入，不能手改 JSON），测试从上一正式发行升级到下一发行。

## 统计
审查给出 66/23/11（降级 D01 I06 I08 W08 R11 U04 U05 U09）。修复并取得 KVM/单元证据后，按证据重新判定；没有证据的保持部分。
