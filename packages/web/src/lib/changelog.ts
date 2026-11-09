import type { SettingsTab } from './types'

export type ChangelogTarget =
  | { kind: 'settings'; tab: SettingsTab; settingId?: string }
  | { kind: 'search' }
  | { kind: 'board' }
  | { kind: 'workstation' }
  | { kind: 'split' }
  | { kind: 'inbox' }
  | { kind: 'home' }
  /** 打开演示工作区；带 scenario 时直接打开对应演示场景。 */
  | { kind: 'demo'; scenario?: string }
  | { kind: 'checklist' }
  | { kind: 'about' }
  | { kind: 'feedback' }

export interface ChangelogEntry {
  id: string
  title: string
  /** 一句话说明，导览列表里只显示这一句。 */
  summary: string
  target: ChangelogTarget
}

export interface ChangelogRelease {
  version: string
  date: string
  items: ChangelogEntry[]
}

/**
 * 调试版专属条目：只在调试构建里合并；发布构建中 __TANDEM_DEBUG__ 为常量 false，
 * 这一组连同其中的标识一起被剔除（scripts/scan-release.mjs 会验证）。
 */
const DEBUG_TOUR_ITEMS: ChangelogEntry[] = [
  {
    id: 'mobile-preview',
    title: '手机预览：在电脑上看手机布局',
    summary:
      '调试版按 Ctrl/Cmd+Shift+M 打开手机尺寸窗口，预设 Pixel 7 / 小屏 / 平板，可旋转并模拟触摸。',
    target: { kind: 'home' },
  },
  {
    id: 'debug-account',
    title: '调试版免登录',
    summary: '调试版内置工作站测试账号，本机打开即可用，不用再手工注册；发布版不含。',
    target: { kind: 'settings', tab: 'accounts', settingId: 'accounts.workspace' },
  },
]

/** 版本升级后首次打开时展示；按版本从新到旧排列。 */
export const CHANGELOG: ChangelogRelease[] = [
  {
    version: '0.4.6',
    date: '2026-11-09',
    items: [
      {
        id: 'account-model-key',
        title: '模型账号归你的工作站账号',
        summary:
          '账号、分组与 Key 属于登录的工作站账号，所有主机共用一份；Key 加密保存在工作站，主机不再保存，换主机也不用重填。',
        target: { kind: 'settings', tab: 'profiles', settingId: 'profiles.accounts' },
      },
      {
        id: 'account-balance',
        title: '账号余额一眼可见',
        summary:
          '账号设置与模型菜单显示剩余余额，工作站用该账号 Key 查询、缓存 5 分钟；支持 OpenRouter、DeepSeek、Moonshot、New API、OpenAI 与自定义查询。',
        target: { kind: 'settings', tab: 'profiles', settingId: 'profiles.balance' },
      },
      {
        id: 'permission-inline',
        title: '审批就在对话里问',
        summary:
          '需要授权时，审批作为触发工具之后的一条消息出现，随对话滚动；回答后原位留一行结果，输入框保持可用。',
        target: { kind: 'demo', scenario: 'permission' },
      },
      {
        id: 'popover-stable',
        title: '下拉不再抖',
        summary:
          '所有菜单、下拉与弹层从第一帧起就在正确位置，不再先跳一下；账号等数据没到齐时先等数据再展开。',
        target: { kind: 'home' },
      },
      {
        id: 'host-switch-pending',
        title: '换主机先确认，不再误发',
        summary:
          '选中另一台主机后先标「待切换」，文件夹显示「待选」；选好目录前输入框锁定并变暗，随时可撤销。',
        target: { kind: 'home' },
      },
      {
        id: 'message-time-usage',
        title: '每条消息都有时间与花费',
        summary:
          '用户与 assistant 消息都常显时间；用户消息还显示这条输入的估算 token 与金额，assistant 显示输入、输出、缓存与耗时。',
        target: { kind: 'demo', scenario: 'chat-tools' },
      },
      {
        id: 'user-bubble-tight',
        title: '用户气泡紧贴文字',
        summary: '短消息的气泡宽度跟着文字走，操作条不再把右侧撑出一大块空白。',
        target: { kind: 'home' },
      },
      {
        id: 'settings-width-padding',
        title: '设置页留白更舒服',
        summary:
          '设置内容区统一限宽居中、左右留白；卡片图标与标题对齐，说明文字不再贴着边框。',
        target: { kind: 'settings', tab: 'general' },
      },
      {
        id: 'windows-add-host-fixed',
        title: 'Windows 一行命令添加主机修好了',
        summary:
          '端口被占自动换空闲端口，失败时给准确原因并写 install.log；登录自启改用当前用户启动项，不再要求管理员。',
        target: { kind: 'settings', tab: 'hosts' },
      },
      {
        id: 'model-chip-clean',
        title: '模型芯片更干净',
        summary: '模型芯片只显示模型名与箭头，思考强度放在菜单和悬停提示里。',
        target: { kind: 'home' },
      },
    ],
  },
  {
    version: '0.4.5',
    date: '2026-11-09',
    items: [
      {
        id: 'workstation-login',
        title: '先登录，再开始',
        summary:
          '桌面、网页与手机打开后先登录或注册工作站，未登录时保留原链接；内测构建在本机回环地址自动登录内置测试账号。',
        target: { kind: 'settings', tab: 'accounts', settingId: 'accounts.workspace' },
      },
      {
        id: 'add-host-one-line',
        title: '一行命令添加主机',
        summary:
          '在「添加主机」里复制一行命令，到目标机器执行一次即可接入并注册为常驻服务；没有主机时首页直接引导添加。',
        target: { kind: 'settings', tab: 'hosts' },
      },
      {
        id: 'session-graph',
        title: '会话图：看清轮次与分支',
        summary:
          '会话信息面板新增会话图：灰色主线、彩色子代理泳道并合并回主线、分叉单独标注；点节点跳到对应轮或打开子代理/分叉。',
        target: { kind: 'demo', scenario: 'subagents' },
      },
      {
        id: 'subagent-session',
        title: '子代理会话可以进入',
        summary:
          '点会话图里的子代理或 Task 卡片进入它的会话，顶部面包屑可以返回父会话，只读查看它做过什么。',
        target: { kind: 'demo', scenario: 'subagents' },
      },
      {
        id: 'permission-ask',
        title: '权限询问按问答列出',
        summary:
          '需要授权时按 Claude Code 式一问一答列出选项（允许 / 拒绝 / 始终允许），数字键或点击选择，默认选项一眼可见。',
        target: { kind: 'demo', scenario: 'permission' },
      },
      {
        id: 'info-panel-collapse',
        title: '会话信息卡片可收起',
        summary:
          '右侧信息面板每张卡都能收起、展开并记住状态，面板变窄时也能一屏看完。',
        target: { kind: 'home' },
      },
      {
        id: 'context-colors',
        title: '上下文卡按用途分色',
        summary:
          '上下文占用按消息、工具输出、缓存等类别用不同颜色与刻度显示，一眼看出是谁占了空间。',
        target: { kind: 'home' },
      },
      {
        id: 'long-session-band',
        title: '长会话先看占位条',
        summary:
          '超长会话只加载最近 200 条，顶部用占位条标出「第 1–N 轮未加载」；大纲里未加载轮次也有标识，滚到顶自动补齐。',
        target: { kind: 'demo', scenario: 'chat-tools' },
      },
      {
        id: 'host-folder-first',
        title: '换主机先选文件夹',
        summary:
          '切换主机时先确认项目文件夹，输入框在选定前禁用，避免把消息发到错误目录。',
        target: { kind: 'home' },
      },
      {
        id: 'ui-polish-045',
        title: '细节打磨',
        summary:
          '反馈截图更快；警告色与状态色校准；下拉不再抖动；代码块自动换行时行号与内容逐行对齐、工具条不压内容。',
        target: { kind: 'feedback' },
      },
    ],
  },
  {
    version: '0.4.4',
    date: '2026-11-09',
    items: [
      {
        id: 'account-key-kept',
        title: '编辑账号不再丢 Key',
        summary:
          '已有 Key 只显示「已保存 · ••••末四位」，要换就点「更换 Key」；只改倍率等其他字段时，Key 原样保留。',
        target: { kind: 'settings', tab: 'profiles', settingId: 'profiles.accounts' },
      },
      {
        id: 'model-pull-latest-generation',
        title: '拉取模型只勾每个系列最新一代',
        summary:
          '从账号拉取模型后，每个系列的最新一代（如 claude-fable-5-1、sonnet-5-5）默认勾选，前代默认不勾，仍可手动补选。',
        target: { kind: 'settings', tab: 'profiles', settingId: 'profiles.models' },
      },
      {
        id: 'cache-switch-confirm',
        title: '切换模型/账号/分组才确认缓存失效',
        summary:
          '会话已有上下文时，选中新的模型、账号或分组才弹确认（附约多少 token 与费用），取消即不改；菜单里不再常驻提示。',
        target: { kind: 'home' },
      },
      {
        id: 'outline-lazy-jump',
        title: '大纲能跳到还没加载的轮次',
        summary:
          '点大纲里的早期轮会先载入那一段再滚动并高亮；滚轮只在大纲里预览移动，不改变当前选中轮，也不滚动对话区。',
        target: { kind: 'demo', scenario: 'chat-tools' },
      },
      {
        id: 'combobox-unified',
        title: '下拉换成统一组件，文字不再被裁',
        summary:
          '单价覆盖与预算规则里的原生下拉改为统一的可搜索列表；菜单、按钮与分段控件行高抬高，中英文上下缘不再被截断。',
        target: { kind: 'settings', tab: 'budgets', settingId: 'budgets.edit' },
      },
      ...(__TANDEM_DEBUG__
        ? [
            {
              id: 'debug-flavor-fixed',
              title: '调试版自动登录与反馈草稿恢复正常',
              summary:
                '调试版把构建风味在打包时写死：首次启动直接进入调试账号，反馈草稿实时写进「下载/Tandem 反馈/」，不再因运行时判断落空。',
              target: { kind: 'feedback' as const },
            },
          ]
        : []),
    ],
  },
  {
    version: '0.4.3',
    date: '2026-11-09',
    items: __TANDEM_DEBUG__
      ? [
          {
            id: 'feedback-autosave',
            title: '反馈边写边存，重开就恢复',
            summary:
              '每条反馈新增、编辑或删除都立即存到本机（刷新、崩溃、关页面都不丢），重新打开提示已恢复几条，继续写。',
            target: { kind: 'feedback' as const },
          },
          {
            id: 'feedback-draft-folder',
            title: '调试版把反馈实时写成文件',
            summary:
              '桌面调试版每条反馈同步写进「下载/Tandem 反馈/草稿-…」：截图、快照、轨迹各自成文件，不留半截文件。',
            target: { kind: 'feedback' as const },
          },
          {
            id: 'feedback-tfb-package',
            title: '导出 .tfb 包，改扩展名能解压',
            summary:
              '导出的反馈是一个 .tfb 包（本质是 zip），把它改成 .zip 就能直接解压查看；桌面调试版还能一键打开所在文件夹。',
            target: { kind: 'feedback' as const },
          },
        ]
      : [],
  },
  {
    version: '0.4.2',
    date: '2026-11-09',
    items: [
      {
        id: 'message-duration',
        title: '每条回复都标耗时',
        summary:
          'assistant 用量行末尾显示本轮用时（含工具）；轮次大纲悬停看耗时、其中工具与首 token。',
        target: { kind: 'demo', scenario: 'chat-tools' },
      },
      ...(__TANDEM_DEBUG__ ? DEBUG_TOUR_ITEMS : []),
      {
        id: 'clean-native-ui',
        title: '界面更干净：屏蔽浏览器自带控件',
        summary:
          '关闭拼写检查、自动填充与数字箭头，右键菜单改为应用自己的；滚动条改为覆盖式，不占宽度。',
        target: { kind: 'home' },
      },
      {
        id: 'settings-compact-rows',
        title: '设置页更紧凑',
        summary: '设置卡片与行距收紧，标签在左、控件在右，数值与单位不换行，一屏能看更多。',
        target: { kind: 'settings', tab: 'general' },
      },
      {
        id: 'external-session-panel',
        title: '外部会话也能看大纲和详情',
        summary:
          '预览 Claude Code / Codex 历史会话时，右侧有大纲与信息面板，上下文、用量、耗时一目了然。',
        target: { kind: 'home' },
      },
      {
        id: 'install-guide-platforms',
        title: '设备安装说明按平台切换',
        summary:
          '工作站里的 adb / 串口安装步骤按 Windows、macOS、Linux（再分发行版）分段，命令可一键复制。',
        target: { kind: 'workstation' },
      },
      {
        id: 'info-panel-empty-groups',
        title: '会话信息面板隐藏空分组',
        summary: '没有数据的分组自动收起，新出现时淡入；底部可切回「显示空分组」。',
        target: { kind: 'home' },
      },
    ],
  },
  {
    version: '0.4.1',
    date: '2026-11-09',
    items: [
      {
        id: 'outline-pinned-only',
        title: '按住 Alt 只看已固定轮次',
        summary:
          '轮次大纲下方提示按住 Alt（Mac 为 Option）只看已固定的轮，松开恢复全部；点这行提示也能切换。',
        target: { kind: 'demo', scenario: 'chat-tools' },
      },
      {
        id: 'outline-context-shading',
        title: '大纲深浅就是上下文占用',
        summary:
          '每轮深浅固定表示该轮上下文占用，不再切换口径；悬停看该轮的输入、输出、缓存命中与花费。',
        target: { kind: 'demo', scenario: 'chat-tools' },
      },
      {
        id: 'context-top-turns',
        title: '最占空间按轮次列出',
        summary:
          '每个用户发言一行、按占用降序，点行跳到该轮，展开看轮内最大的几项；整个区块可折叠并记住。',
        target: { kind: 'home' },
      },
      {
        id: 'execution-mode-menu',
        title: '执行方式收成一个菜单',
        summary:
          '自动 / 单代理 / 低成本 / 多代理协作与委派倾向合并到输入框底栏一个菜单；侧栏「派单」改名「跨主机派单」。',
        target: { kind: 'home' },
      },
      {
        id: 'composer-token-estimate',
        title: '输入时就看见 token 与占用',
        summary:
          '输入框底栏显示本次输入约多少 token，以及发送后的上下文占比；附件、粘贴文本与已选元素都计入。',
        target: { kind: 'home' },
      },
      {
        id: 'model-cache-warning',
        title: '切换模型前提示缓存将失效',
        summary:
          '会话已有上下文时，换模型、账号或分组前提示下一轮按完整上下文计费，并估算 token 与费用；可不再提示。',
        target: { kind: 'home' },
      },
      {
        id: 'composer-markdown',
        title: '输入框支持 Markdown 排版',
        summary:
          '代码围栏自动成对、代码块内回车换行、列表自动续号，标题与分割线着色；发送的仍是原始 Markdown。',
        target: { kind: 'home' },
      },
      {
        id: 'device-compact-panel',
        title: '设备面板更紧凑，串口问题直说',
        summary:
          '设备行压成单行，板载串口默认折叠；无权限或被占用时给出原因、修复命令与重新检测入口。',
        target: { kind: 'workstation' },
      },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-11-09',
    items: [
      {
        id: 'workstation-service',
        title: '工作站服务：一个地址管所有主机',
        summary:
          '工作站可单独运行，注册/登录后生成绑定码添加主机；主机所有者按账号授权，撤销即时失效。',
        target: { kind: 'settings', tab: 'accounts', settingId: 'accounts.workspace' },
      },
      {
        id: 'sidebar-host-groups',
        title: '侧栏按主机分组，会话一眼找全',
        summary:
          '所有主机的会话分组显示，组内再分「已固定」与「最近」项目；不用先切主机再找会话。',
        target: { kind: 'home' },
      },
      {
        id: 'model-menu-cascade',
        title: '模型菜单级联飞出，常用模型留在顶部',
        summary:
          '账号、分组、模型逐级弹出而不是整页替换，最近使用的模型排在最前，可跨账号分组。',
        target: { kind: 'home' },
      },
      {
        id: 'thinking-effort-levels',
        title: '思考强度只列模型真实档位',
        summary: '思考强度按当前模型实际支持的档位显示，不支持的一项不出现，选完即回显。',
        target: { kind: 'home' },
      },
      {
        id: 'price-multiplier',
        title: '按账号与分组设置价格倍率',
        summary:
          '实际花费 = 官方参考价 × 账号倍率 × 分组倍率；中转常见 0.3×、1.5× 直接填，用量页按实记账。',
        target: { kind: 'settings', tab: 'profiles', settingId: 'profiles.multiplier' },
      },
      {
        id: 'turn-outline-usage',
        title: '轮次大纲按用量着色',
        summary:
          '悬停任一查看该轮花费与上下文占用，大纲按用量深浅着色；「已固定」与「全部轮次」分两段，固定不重排。',
        target: { kind: 'home' },
      },
      {
        id: 'panel-resize',
        title: '右侧栏可拖宽',
        summary: '会话信息、计划与代理面板左侧边缘可拖动，宽度记住，窄屏仍自动收起。',
        target: { kind: 'home' },
      },
      {
        id: 'chat-reading-width',
        title: '表格与代码块铺满对话列',
        summary:
          '表格与代码块用满对话列宽，横滚更少；焦点框改为中性色，运行/失败状态与代码着色更清晰。',
        target: { kind: 'settings', tab: 'appearance', settingId: 'appearance.theme' },
      },
      {
        id: 'background-hover-list',
        title: '后台任务悬停即看',
        summary: '顶栏后台任务按钮悬停列出本会话任务与状态，点一条直接打开输出。',
        target: { kind: 'home' },
      },
      ...(__TANDEM_DEBUG__
        ? [
            {
              id: 'demo-device-session',
              title: '演示设备可挂到会话',
              summary:
                '演示安卓设备与串口板挂到会话后显示演示画面；工作站给出按 Host 平台的 adb/串口安装说明。',
              target: { kind: 'workstation' as const },
            },
          ]
        : []),
      {
        id: 'flavor-builds',
        title: '体验包与正式包分开',
        summary:
          '体验包额外带维护者工具与角标，正式包只保留日常功能；关于页标注当前包类型，同一设备只能装一个。',
        target: { kind: 'about' },
      },
    ],
  },

  {
    version: '0.3.1',
    date: '2026-11-08',
    items: [
      {
        id: 'division-routing',
        title: '分工路由：简单任务不变复杂',
        summary:
          '默认单代理；一眼机械的任务整单交给低成本模型直做；多步机械或领域匹配才多代理协作，由子代理执行，主会话模型与缓存不变。',
        target: { kind: 'settings', tab: 'routing', settingId: 'routing.division' },
      },
      {
        id: 'route-mode-picker',
        title: '发送前先选执行方式',
        summary:
          '输入框底栏可选自动 / 单代理 / 低成本 / 多代理协作，只影响本条消息，也可记住为会话偏好。',
        target: { kind: 'home' },
      },
      {
        id: 'division-confirm-plan',
        title: '分工先看计划再确认',
        summary:
          '需要确认时先列出子任务、模型与预计花费；可逐个换模型、删子任务，或整单改为单代理；同一张卡进收件箱。',
        target: { kind: 'settings', tab: 'routing', settingId: 'routing.division' },
      },
      {
        id: 'subagent-reroute',
        title: '子代理可换模型或交回主会话',
        summary: '右栏子代理卡片可换任意模型重跑，或把原始任务交回主会话（单代理）。',
        target: { kind: 'demo', scenario: 'subagents' },
      },
      {
        id: 'route-learned-preference',
        title: '记住你的执行方式选择',
        summary: '每次手动覆盖按领域与机械动作累计；设置里能看到学到的偏好并清空。',
        target: { kind: 'settings', tab: 'routing', settingId: 'routing.division' },
      },
      {
        id: 'usage-by-role',
        title: '用量按角色统计',
        summary: '用量页分别统计规划者、执行者与专长模型的调用、花费与节省。',
        target: { kind: 'settings', tab: 'usage', settingId: 'usage.roles' },
      },
    ],
  },

  {
    version: '0.3.0',
    date: '2026-11-08',
    items: [
      {
        id: 'workstation-devices',
        title: '工作站：设备共享',
        summary: '在一处看到所有主机的 ADB / 串口设备，挂载后会话里的 agent 直接可用，串口还能开终端。',
        target: { kind: 'workstation' },
      },
      {
        id: 'workspace-accounts',
        title: '工作区账号',
        summary: '登录一次就能看到所有可访问的机器；所有者按账号分配角色、主机范围与项目目录。',
        target: { kind: 'settings', tab: 'accounts', settingId: 'accounts.workspace' },
      },
      {
        id: 'preview-side-panel',
        title: '预览不再挡输入框',
        summary: '应用预览在桌面是右侧面板、手机是底部抽屉，选完元素焦点回到输入框。',
        target: { kind: 'demo', scenario: 'preview' },
      },
      {
        id: 'inbox-turn-rollup',
        title: '收件箱按回合聚合',
        summary: '同一回合的审批收成一行，回合结束或出错置顶；点一行看明细或直接打开会话。',
        target: { kind: 'inbox' },
      },
      {
        id: 'confirm-danger-actions',
        title: '危险操作统一确认',
        summary: '看板合并先列出每张卡的文件与 diff；手动压缩可查看原文并撤销，删除账号等也走同一确认。',
        target: { kind: 'board' },
      },
      {
        id: 'board-done-actions',
        title: '完成的卡片能接着处理',
        summary: '完成态卡片可直接打开会话、查看改动与测试结果，或合并、重新运行；失败卡能看错误再重试。',
        target: { kind: 'board' },
      },
      {
        id: 'turn-outline-hover',
        title: '轮次大纲悬停看全文',
        summary: '鼠标停在轮次上就能看到该轮完整提问，读屏也能逐轮读出，不用点进去找。',
        target: { kind: 'demo', scenario: 'chat-tools' },
      },
      {
        id: 'mobile-env-bar',
        title: '手机环境条更完整',
        summary: '环境条改成横向滑动，文件夹、分支与 Worktree 在手机上都能看全。',
        target: { kind: 'demo', scenario: 'chat-tools' },
      },
      {
        id: 'model-price-hint',
        title: '模型菜单显示参考价',
        summary: '选模型时直接看到每百万 token 的参考单价；未设置时显示「去设置」，点开就能填。',
        target: { kind: 'settings', tab: 'profiles', settingId: 'profiles.prices' },
      },
      ...(__TANDEM_DEBUG__
        ? [
            {
              id: 'feedback-root-cause',
              title: '反馈自动按功能与根因归类',
              summary: '圈选的反馈自动带上功能标签与建议根因，导出后按功能、按根因分别整理；弹出菜单里也能圈选。',
              target: { kind: 'feedback' as const },
            },
          ]
        : []),
    ],
  },

  {
    version: '0.2.1',
    date: '2026-11-08',
    items: __TANDEM_DEBUG__
      ? [
          {
            id: 'demo-workspace',
            title: '演示工作区',
            summary: '一键创建带演示数据的会话、看板与设置页，随时清除，不影响真实数据。',
            target: { kind: 'demo' as const },
          },
          {
            id: 'checklist',
            title: '体验清单',
            summary: '按功能逐项体验并标记通过/有问题；进度与报告都保存在本机。',
            target: { kind: 'checklist' as const },
          },
          {
            id: 'feedback-grouping',
            title: '反馈按功能与根因归类',
            summary: '反馈自动归到功能并建议根因，导出后按功能、按根因分别整理。',
            target: { kind: 'feedback' as const },
          },
        ]
      : [],
  },

  {
    version: '0.2.0',
    date: '2026-11-08',
    items: [
      {
        id: 'desktop-update',
        title: '桌面端自动更新',
        summary: '桌面端可从内网更新源发现并下载新版本，安装完成后提示重启。',
        target: { kind: 'settings', tab: 'general', settingId: 'general.updates' },
      },
      {
        id: 'release-signing',
        title: '安卓正式签名包',
        summary: '安卓端提供签名 APK 与上架用 AAB，版本与桌面端保持一致。',
        target: { kind: 'about' },
      },
      {
        id: 'preview-canvas',
        title: '应用预览画布',
        summary: '在会话侧栏预览本机前端应用，可切换设备尺寸、点选元素并回填到对话。',
        target: { kind: 'demo', scenario: 'preview' },
      },
      {
        id: 'project-wiki',
        title: '项目 Wiki',
        summary: '为仓库生成模块页与术语页，agent 可检索；增量更新保留手写内容。',
        target: { kind: 'demo', scenario: 'wiki' },
      },
      {
        id: 'session-paging',
        title: '大会话分页与轮次大纲',
        summary: '超大会话首屏只加载最近内容，滚到顶部自动补更早内容，轮次大纲可直接跳转。',
        target: { kind: 'demo', scenario: 'chat-tools' },
      },
      {
        id: 'ssh-remote',
        title: '远程主机一键部署',
        summary: '用 SSH 添加远程主机并部署 Host，手机可经隧道连接使用。',
        target: { kind: 'settings', tab: 'hosts', settingId: 'hosts.ssh.add' },
      },
      {
        id: 'settings-tour',
        title: '设置分组与新功能导览',
        summary: '设置项按用途分组，顶栏入口更少；升级后首次打开会提示本版新增功能。',
        target: { kind: 'about' },
      },
      {
        id: 'board-v2',
        title: '看板与 AI 评审增强',
        summary: '看板支持运行时提议、卡片 AI 评审与 PR 聚合，分屏里也能处理冲突。',
        target: { kind: 'board' },
      },
    ],
  },



  {
    version: '0.1.0',
    date: '2026-11-08',
    items: [
      {
        id: 'command-palette',
        title: '命令面板统一搜索',
        summary: 'Ctrl/Cmd+K 能搜会话、命令、设置项与主机，支持拼音首字母。',
        target: { kind: 'search' },
      },
      {
        id: 'auto-compact',
        title: '上下文自动压缩',
        summary: '接近上下文上限时先摘要旧对话，长会话不再因超长中断。',
        target: { kind: 'settings', tab: 'general', settingId: 'general.auto-compact' },
      },
      {
        id: 'approval-learning',
        title: '审批策略学习',
        summary: '同类请求批准 3 次后建议项目级自动允许，危险命令永不建议。',
        target: { kind: 'settings', tab: 'permissions', settingId: 'permissions.learning' },
      },
      {
        id: 'doctor',
        title: '主机诊断',
        summary: '逐项检查 Node、磁盘、账号连通、git 与 MCP，报告自动脱敏。',
        target: { kind: 'settings', tab: 'hosts', settingId: 'hosts.doctor' },
      },
      {
        id: 'secrets',
        title: '项目 Secrets',
        summary: '项目密钥只注入命令环境，消息与日志中自动打码。',
        target: { kind: 'settings', tab: 'secrets', settingId: 'secrets.list' },
      },
      {
        id: 'full-text-search',
        title: '全文搜索与筛选',
        summary: '会话正文、外部会话和工具路径都能搜；侧栏可按状态、主机、项目筛选。',
        target: { kind: 'search' },
      },
      {
        id: 'sandbox',
        title: '命令沙箱与网络白名单',
        summary: '限制越界写入与非白名单联网，危险操作转审批。',
        target: { kind: 'settings', tab: 'permissions', settingId: 'permissions.sandbox' },
      },
      {
        id: 'split',
        title: '多会话分屏',
        summary: '2 列、3 列或 2×2 同时看多个会话，布局刷新后保留。',
        target: { kind: 'split' },
      },
      {
        id: 'board',
        title: '任务看板',
        summary: '把目标拆成卡片并行执行，支持依赖、审批、AI 评审与 PR 聚合。',
        target: { kind: 'board' },
      },
      {
        id: 'handoff',
        title: '额度交接',
        summary: 'Key 限流或预算将尽时切换到备用分组，或等待额度重置。',
        target: { kind: 'settings', tab: 'general', settingId: 'general.handoff' },
      },
      {
        id: 'auto-route',
        title: '自动模型路由',
        summary: '按难度与偏好自动选模型，简单任务用快模型，失败自动升级。',
        target: { kind: 'settings', tab: 'routing', settingId: 'routing.preference' },
      },
      {
        id: 'team',
        title: '内网团队与共享',
        summary: '邀请成员、审批转交、审计日志，以及会话分享链接。',
        target: { kind: 'settings', tab: 'team', settingId: 'team.members' },
      },
    ],
  },
]

export const CHANGELOG_VERSION = CHANGELOG[0]?.version ?? '0.0.0'
export const LATEST_CHANGELOG_ITEMS = CHANGELOG.flatMap((release) => release.items)
export const APP_VERSION = __APP_VERSION__

const SEEN_KEY = 'tandem.changelogSeen.v1'
const ONBOARDING_KEY = 'tandem.onboarding.v1'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式等 localStorage 不可用时，导览只在本次会话有效 */
  }
}

export function changelogSeenVersion(): string | null {
  return read(SEEN_KEY)
}

export function markChangelogSeen(): void {
  write(SEEN_KEY, CHANGELOG_VERSION)
}

export function onboardingDone(): boolean {
  return read(ONBOARDING_KEY) === 'done'
}

export function markOnboardingDone(): void {
  write(ONBOARDING_KEY, 'done')
}

/** 跳转后在目标元素上加一圈短暂高亮，不改变布局。 */
export function pulseTourTarget(selector: string, delay = 220): void {
  window.setTimeout(() => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.remove('tour-pulse')
    void el.getBoundingClientRect()
    el.classList.add('tour-pulse')
    window.setTimeout(() => el.classList.remove('tour-pulse'), 1900)
  }, delay)
}
