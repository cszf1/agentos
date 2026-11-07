# AgentOS

AgentOS 是基于 Linux/NixOS 开发的操作系统，包含持久化工作区、应用生成与版本管理、Agent 运行时、受控工具执行，以及 Qt/QML 原生前端。

## 当前方向

当前工作是在现有 Linux 架构内消除代码冗余，保持全部完整功能、接口和安全语义，让实现更简洁稳定。
不解耦 Linux，不添加其他操作系统或虚拟机种类的兼容插口，也不以跨平台重构或删功能代替精简。

前端界面、交互与使用体验优化另行安排，不与行为保持的代码精简混在一起。
旧的验收账本和阶段性规格不再作为当前路线；验证以实际改动范围与功能保持为准。

仓库仅维护 `main`。旧阶段报告、规格、测量数据与调试附件已移出当前工作资料；需要历史信息时查询 Git 和 Actions 运行记录。

## 在虚拟机里试用

虚拟机镜像是装好的系统：配好虚拟机参数、挂上磁盘、开机设置一个密码即可，见 [docs/VM_QUICKSTART.md](docs/VM_QUICKSTART.md)。

## 代码结构

| 目录 | 职责 |
|---|---|
| `packages/contracts` | 应用、协议、权限及运行时契约 |
| `packages/core` | 应用、记录、版本、任务、调度、权限与维护逻辑 |
| `packages/agent-pi` | Agent 接入、会话与模型预算 |
| `packages/host` | Host 服务、API、工作区持久化与恢复入口 |
| `packages/runtime-podman` | 现有 Podman 运行适配 |
| `packages/app-runner`、`packages/app-sdk` | 隔离应用执行与 SDK |
| `packages/broker-client`、`native` | 原生协议、权限网关与系统能力实现 |
| `desktop` | Qt/QML 原生前端、渲染与通信 |
| `runtime` | 锁定的运行时目录、镜像配方与兼容实现 |
| `os`、`deploy` | 现有系统构建、安装与部署实现 |
| `tests`、`fixtures` | 自动化测试、协议向量与固定输入数据 |
| `docs/contracts` | 被源码、构建及协议检查实际使用的机器可读契约 |

`runtime/frozen` 与测试夹具中的数据库是代码依赖，不是编译缓存或调试残留。

## 开发环境与构建

现有运行实现以 Linux 为基础：

- Node.js **24.22.1**，pnpm **10.34.9**（根 `package.json` 锁定）。
- 原生部分使用 Rust **1.91.0**，需要对应系统开发库；工具链见 `native/rust-toolchain.toml`。
- 代码应用使用 rootless Podman；需要 systemd、cgroup v2、用户命名空间及 subuid/subgid 配置。
- Qt/QML 前端使用 Qt 6；Nix 配置锁定前端与系统构建依赖。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm native:build
```

开发用 Host（独立数据目录 `.data/dev`，端口 4318）：

```bash
AGENTOS_MODEL_MODE=faux pnpm dev
```

代码应用需要先配置好 rootless Podman，并准备固定运行镜像：

```bash
pnpm runtime:prefetch
pnpm runtime:doctor
```

原生前端构建入口：

```bash
nix-shell desktop/shell.nix --run 'cmake -S desktop -B desktop/build -G Ninja && cmake --build desktop/build'
```

现有系统的构建、管理员操作、更新与恢复方法见 [操作说明](docs/OPERATIONS.md)。

## 配置与数据

- Host 默认监听 `127.0.0.1:4317`，数据默认位于 `~/.local/share/agentos`；具体变量见 `.env.example`。
- `AGENTOS_MODEL_MODE=faux` 使用确定性测试模型；真实模型配置使用 `AGENTOS_MODEL_PROVIDER`、`AGENTOS_MODEL_ID`、`AGENTOS_MODEL_BASE_URL`、`AGENTOS_MODEL_API_KEY`。
- 不把模型密钥提交到 Git、打入镜像或注入 CI/测试 VM；没有可用模型时，已有应用与数据功能不应被冒充为模型生成成功。
- 代码应用通过固定契约执行；权限、确认、未知结果隔离和恢复语义不能因后续精简而被削弱。

## 现有验证入口

保留现有自动化测试，不把旧 OS 的全量验收目标带入下一阶段。后续根据实际修改范围运行相关验证，不新增无关测试。

```bash
pnpm typecheck
pnpm contracts:check
pnpm test
cd native && cargo test --locked --workspace -- --test-threads=1
```

其他测试入口见 `package.json` 与 `desktop/shell.cmake`。现有系统 VM 检查保留在 `.github/workflows/v1-vm-tests.yml`，仅手动触发，不再随每次提交自动执行旧 OS 全量验收。

现有代码基线 [`7e4a8ae`](https://github.com/cszf1/agentos/commit/7e4a8aedc42e96c1628bd7e6f11202b723a96593)
已在 [Actions 41325583957](https://github.com/cszf1/agentos/actions/runs/41325583957) 跑通 19 项 VM 检查与 8 项构建检查。
这是历史功能基线，不代表平台无关核心已完成，也不承诺未测硬件、虚拟化平台或真实模型主线已验证。
