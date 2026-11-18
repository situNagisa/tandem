/**
 * 偶发（flaky）记录。
 *
 * 用例失败后运行器会单独重跑一次，重跑通过记 flaky、不算失败；
 * 这里只在跑完全量后写一次记录，并给出需要排查的警告名单：
 * - 同一用例在一次全量里 flaky ≥2 次（重名用例或多段触发）；
 * - 同一用例连续 3 次全量都 flaky。
 * 历史文件放系统临时目录，不随仓库提交；TANDEM_REGRESSION_FLAKY_FILE 可覆盖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 已知偶发用例：来自 HANDOFF/PROGRESS 的历史记录，出现时优先对照。 */
export const KNOWN_FLAKY = [
  {
    name: '大会话滚到顶加载更早消息且位置不跳',
    note: '负载下更早消息加载与 scrollTop 补偿有竞态',
  },
  {
    name: '轮次大纲跳到未加载的轮',
    note: '跳到未加载轮要等分段加载，慢机器上容易超时',
  },
  {
    name: '反馈16#11：排队消息被读取后按原位置出现在对话流里',
    note: '排队消息写入与读取顺序依赖 Host 往返时序',
  },
  {
    name: '轮次条点击第 30 轮精准定位（不跳到相邻轮）',
    note: '负载下跳转动画 900ms 后还差 ~46px（m16 全量即出现过同一数值，与 1920 改动无关）',
  },
  {
    name: '登录门：调试版自动登录带演示主机，一行命令添加主机后显示已连接',
    note: '自动登录与一行命令安装受网络/进程启动时序影响',
  },
]

const HISTORY_LIMIT = 20

export function historyFile() {
  return process.env.TANDEM_REGRESSION_FLAKY_FILE ?? path.join(os.tmpdir(), 'tandem-regression-flaky.json')
}

export function loadHistory() {
  const file = historyFile()
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(data.runs)) return data
  } catch {
    /* 没有历史或格式损坏时从头记录 */
  }
  return { runs: [] }
}

/** 记录本次运行；full=false（--only/--changed）只留痕，不计入「连续 3 次全量」。 */
export function recordRun({ full, flaky }) {
  const history = loadHistory()
  history.runs.push({ at: new Date().toISOString(), full, flaky })
  history.runs = history.runs.slice(-HISTORY_LIMIT)
  try {
    fs.writeFileSync(historyFile(), `${JSON.stringify(history, null, 2)}\n`)
  } catch {
    /* 临时目录不可写时不影响回归结果 */
  }
  return history
}

/** 本次需要排查的警告名单。 */
export function flakyWarnings(history, flaky) {
  const warnings = new Set()
  const counts = new Map()
  for (const name of flaky) counts.set(name, (counts.get(name) ?? 0) + 1)
  for (const [name, count] of counts) {
    if (count >= 2) warnings.add(`${name}：本次全量内偶发 ${count} 次`)
  }
  const fullRuns = history.runs.filter((run) => run.full).slice(-3)
  if (fullRuns.length === 3) {
    for (const name of counts.keys()) {
      if (fullRuns.every((run) => run.flaky.includes(name))) {
        warnings.add(`${name}：连续 ${fullRuns.length} 次全量都偶发`)
      }
    }
  }
  return [...warnings]
}
