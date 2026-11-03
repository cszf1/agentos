.pragma library

var app = {
    title: "AgentOS 原生工作台",
    systemTag: "AgentOS // NixOS",
    waylandTag: "Sway 单窗口 · 软件渲染"
}

var nav = {
    sectionMain: "核心工作区",
    sectionGov: "治理与审计",
    sectionSys: "系统与硬件",
    home: "概览与意图",
    workspaces: "工作空间",
    appDetail: "应用画布",
    tasks: "任务中心",
    proposals: "变更提案",
    policies: "安全策略",
    incidents: "异常事件",
    backup: "快照与备份",
    update: "系统更新",
    hardware: "硬件与电源",
    diagnostics: "系统诊断"
}

var roles = {
    viewer: "查看者 (Viewer)",
    editor: "编辑者 (Editor)",
    owner: "所有者 (Owner)",
    viewerHint: "当前角色为「查看者」，写操作不可用"
}

var status = {
    connected: "服务在线",
    disconnected: "服务离线",
    sessionBound: "会话已绑定",
    sessionUnbound: "会话未绑定",
    hostOk: "宿主机正常",
    hostDown: "宿主机失联",
    modelOk: "模型就绪",
    modelDown: "模型不可用",
    brokerOk: "安全代理正常",
    brokerDown: "安全代理异常",
    readOnlyBanner: "当前处于「只读模式」：系统快照保护或审计锁定中，所有写入操作已禁用。",
    writesStoppedBanner: "当前已触发「紧急停写 (Writes Stopped)」：安全代理已拦截全部变更请求。",
    offlineBanner: "当前「与系统后台断开连接」：仅展示本地缓存数据（缓存于 ",
    offlineBannerSuffix: "），所有写入操作已禁用。",
    writeDisabledReasonReadOnly: "只读模式下禁止写入操作",
    writeDisabledReasonStopped: "系统已停写，禁止执行变更",
    writeDisabledReasonOffline: "服务离线，无法提交写入请求",
    writeDisabledReasonViewer: "查看者角色无写入权限"
}

var common = {
    confirm: "确认",
    cancel: "取消",
    retry: "重试",
    refresh: "刷新页面",
    save: "保存",
    close: "关闭",
    dismiss: "忽略",
    submit: "提交执行",
    search: "搜索...",
    clickAgainConfirm: "再次点击确认 (3s)",
    loadingTitle: "正在同步数据...",
    loadingDesc: "正在从本地系统服务拉取最新状态，请稍候。",
    emptyTitle: "暂无记录",
    emptyDesc: "当前视图下没有匹配的数据项。",
    errorTitle: "数据加载失败",
    errorDesc: "无法从 AgentOS Broker 读取当前列表，请检查连接后重试。",
    cachedAtPrefix: "缓存时间：",
    scaleLabel: "界面缩放",
    themeLight: "浅色主题",
    themeDark: "深色主题",
    lockScreen: "锁定会话"
}


var login = {
    title: "会话已锁定",
    subtitle: "AgentOS 本地安全会话需要重新验证身份以绑定系统代理",
    userLabel: "当前操作员",
    roleLabel: "权限角色",
    passwordLabel: "会话解锁密码",
    passwordPlaceholder: "请输入操作员口令（演示任意输入）",
    unlockBtn: "解锁并重新绑定会话",
    rebindHint: "会话通过本地 Unix Domain Socket 与 AgentOS Broker 通信，无外部网络暴露。"
}

var blocked = {
    badge: "SYSTEM SERVICE UNREACHABLE // 系统服务不可达",
    title: "无法连接 AgentOS 核心守护进程",
    subtitle: "界面未能与本地 Broker 建立受控通道。请检查虚拟机内 agentos-broker.service 状态。",
    hostState: "宿主机通道",
    brokerState: "安全代理 (Broker)",
    modelState: "推理引擎",
    cachedNotice: "最后缓存快照时间：",
    reconnectBtn: "立即重新连接",
    rebindBtn: "重新绑定会话句柄",
    enterDiagnosticsBtn: "查看离线诊断日志"
}

var trustedConfirm = {
    systemBanner: "AGENTOS TRUSTED SYSTEM BROKER · 系统级安全确认层（非应用弹窗）",
    systemSubBanner: "此确认层由系统内核代理直接渲染。为防误触，默认焦点位于「取消」，按 Enter 键不会触发确认，按 Esc 键立即取消。",
    operationLabel: "待执行系统级操作",
    targetLabel: "作用目标与范围",
    riskLabel: "风险级别",
    planHeader: "执行计划明细（逐条核对）",
    adminPasswordLabel: "管理员授权口令（必填）",
    adminPasswordPlaceholder: "此操作需要 Owner / 管理员口令验证",
    adminPasswordRequiredHint: "请输入管理员口令后再点击确认执行",
    cancelBtn: "取消操作 (Esc / 默认焦点)",
    acceptBtn: "确认授权并执行"
}

var appConfirm = {
    badge: "应用内操作确认",
    acceptBtn: "允许并继续",
    rejectBtn: "拒绝"
}

var home = {
    title: "系统概览与意图中心",
    subtitle: "实时监控虚拟机状态、向受控应用发送自然语言意图指令，并查看近期活动",
    intentBoxTitle: "发送受控意图 (Submit Intent)",
    intentPlaceholder: "输入需要 Agent 执行的任务指令，例如：整理本周财务账单并生成只读校验摘要...",
    targetAppLabel: "目标应用",
    submitIntentBtn: "提交意图",
    machineCardTitle: "虚拟机与服务健康度",
    quickAppsTitle: "已挂载应用画布",
    notificationsTitle: "系统通知与审计提醒",
    recentRunsTitle: "最近执行的任务流",
    expandCardBtn: "展开卡片",
    collapseCardBtn: "收起卡片",
    saveLayoutBtn: "保存工作台布局"
}

var workspaces = {
    title: "工作空间与成员管理",
    subtitle: "隔离不同安全域的数据画布、应用实例与操作员角色权限",
    listTitle: "可用工作空间",
    switchBtn: "切换至此空间",
    currentTag: "当前空间",
    membersTitle: "空间成员与角色",
    createUserTitle: "创建新操作员账户",
    loginNameLabel: "登录账号名",
    roleSelectLabel: "分配角色",
    initPasswordLabel: "初始安全口令",
    createUserBtn: "创建操作员"
}

var appDetail = {
    title: "应用画布与受控槽位",
    subtitle: "基于声明式 Slot 树、结构化记录表与受控动作队列运行应用，无内嵌浏览器",
    selectAppLabel: "切换当前应用：",
    tabCanvas: "Slot 槽位画布",
    tabRecords: "结构化数据记录",
    tabActions: "受控动作列表",
    tabHealth: "应用健康与配额",
    saveLayoutBtn: "保存画布布局"
}

var tasks = {
    title: "任务与作业调度中心",
    subtitle: "查看 Agent 意图执行历史、后台定时作业 (Jobs)、操作流水与实时会话转录日志",
    tabRuns: "Agent 执行记录 (Runs)",
    tabJobs: "后台定时作业 (Jobs)",
    tabOps: "底层操作流水 (Operations)",
    transcriptTitle: "执行转录日志 (Transcript)",
    loadTranscriptBtn: "加载转录",
    retryRunBtn: "重新触发任务"
}

var proposals = {
    title: "系统与架构变更提案",
    subtitle: "所有涉及 NixOS 配置、模型路由或存储挂载的变更均须通过提案审批",
    approveBtn: "批准并应用提案",
    rejectBtn: "驳回提案",
    proposerLabel: "发起方：",
    impactLabel: "影响范围：",
    diffTitle: "变更内容摘要"
}

var policies = {
    title: "安全策略与访问控制规则",
    subtitle: "定义 Agent 可调用的系统能力边界、外设访问白名单及敏感操作拦截等级",
    enforceLabel: "强制拦截模式",
    togglePolicyBtn: "切换启用状态",
    resetPolicyBtn: "重置为默认基线",
    scopeLabel: "作用范围：",
    levelLabel: "审计等级："
}

var incidents = {
    title: "安全与运行异常事件",
    subtitle: "追踪策略越界拦截、服务超时、只读降级与沙箱违规告警",
    ackBtn: "确认并归档",
    isolateBtn: "隔离涉事应用",
    severityLabel: "严重度：",
    sourceLabel: "来源模块：",
    timeLabel: "发生时间："
}

var backup = {
    title: "系统快照与数据备份",
    subtitle: "管理 NixOS 代际快照与工作空间加密归档，支持一键校验与回滚",
    createBackupBtn: "立即创建增量快照",
    restoreBackupBtn: "回滚至此快照",
    deleteBackupBtn: "删除快照",
    sizeLabel: "快照体积：",
    hashLabel: "校验指纹："
}

var update = {
    title: "系统代际与原子更新",
    subtitle: "基于 NixOS 原子代际切换 (Generations)，支持零停机升级与故障一键回滚",
    currentGenTitle: "当前运行代际状态",
    checkUpdateBtn: "检查可信更新源",
    applyUpdateBtn: "应用新代际更新",
    revisionsTitle: "历史 NixOS 代际列表 (Revisions)",
    rollbackBtn: "原子回滚至此代际"
}

var hardware = {
    title: "硬件外设与电源控制",
    subtitle: "管理声音、显示分辨率与系统电源；新显示设置可自动回退",
    audioTitle: "音频输出控制",
    volumeLabel: "主输出音量",
    muteLabel: "静音输出 (Mute)",
    applyAudioBtn: "应用音量设置",
    displayTitle: "显示分辨率设置",
    resolutionLabel: "输出分辨率（基准 1280×800）",
    applyResBtn: "切换分辨率",
    revertBannerPrefix: "分辨率已切换，将在 ",
    revertBannerSuffix: " 秒后自动还原为原设置，请确认显示是否正常：",
    keepDisplayBtn: "保留当前分辨率",
    revertDisplayBtn: "立即还原",
    secretTitle: "硬件安全模块 (TPM / 密钥注入)",
    secretSlotLabel: "目标硬件槽位",
    secretValueLabel: "硬件授权密钥",
    injectSecretBtn: "写入硬件密钥",
    powerTitle: "虚拟机电源管理",
    powerDesc: "执行系统安全关机将停止所有正在运行的 Agent 任务并卸载加密卷。",
    poweroffBtn: "安全关闭系统 (power.poweroff)"
}

var diagnostics = {
    title: "系统诊断与内核日志",
    subtitle: "查看沙箱能力矩阵、会话绑定令牌、守护进程健康度及原始诊断报告",
    capTitle: "系统能力矩阵 (Capabilities)",
    sessionTitle: "会话与安全通道详情",
    rawLogTitle: "原始诊断输出 (diagnosticsText)",
    copyDiagBtn: "导出诊断快照",
    runSelfTestBtn: "执行完整性自检"
}
