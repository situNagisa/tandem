// 「添加主机」弹层用到的纯函数：一行命令、工作站对外地址选择、平台默认值。

export type AddHostPlatform = 'linux' | 'macos' | 'windows'

export interface AddHostCommands {
  /** 目标机器上执行一次即可：下载主机程序并前台连接工作站。 */
  oneLiner: string
  /** 已装 tandem-host 的机器：只登记并连接。 */
  installed: string
}

/** 去掉首尾空白与结尾斜杠（命令里统一自己拼 `/install.sh`）。 */
export function normalizeWorkstationUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

export function buildAddHostCommands(input: {
  workstationUrl: string
  token: string
  platform: AddHostPlatform
  /** 开机自启（需要相应权限）；默认关闭。 */
  service?: boolean
}): AddHostCommands {
  const base = normalizeWorkstationUrl(input.workstationUrl)
  const token = input.token.trim()
  const service = input.service === true
  const oneLiner =
    input.platform === 'windows'
      ? `& ([scriptblock]::Create((irm ${base}/install.ps1))) -Token '${token}'${service ? ' -Service' : ''}`
      : `curl -fsSL ${base}/install.sh | sh -s -- --token ${token}${service ? ' --service' : ''}`
  return {
    oneLiner,
    installed: `tandem-host join ${base} --token ${token}${service ? ' --service' : ''}`,
  }
}

export interface ShareUrlResult {
  /** 展示在命令里的工作站地址；回环地址会被替换成局域网地址。 */
  url: string
  /** 可切换的地址（去重、去回环、保持顺序）；多个时界面给选择器。 */
  candidates: string[]
  /** 工作站只提供回环地址：其他机器无法访问。 */
  loopbackOnly: boolean
}

export function pickShareUrl(centerUrl: string, statusUrls: readonly string[]): ShareUrlResult {
  const center = normalizeWorkstationUrl(centerUrl)
  const usable = [...new Set(
    statusUrls
      .map(normalizeWorkstationUrl)
      .filter((url) => /^https?:\/\//i.test(url)),
  )]
  const shared = [...new Set(usable.filter((url) => !isLoopbackUrl(url)))]

  if (center && !isLoopbackUrl(center)) {
    return {
      url: center,
      candidates: [...new Set([center, ...shared])],
      loopbackOnly: false,
    }
  }
  if (shared.length > 0) {
    return { url: shared[0]!, candidates: shared, loopbackOnly: false }
  }
  return {
    url: center || usable[0] || '',
    candidates: [...new Set([...(center ? [center] : []), ...usable])],
    loopbackOnly: true,
  }
}

export function defaultAddHostPlatform(userAgent: string): AddHostPlatform {
  if (/windows/i.test(userAgent)) return 'windows'
  if (/macintosh|mac os x|darwin/i.test(userAgent)) return 'macos'
  return 'linux'
}

/** 日志与截图里不出现完整注册令牌。 */
export function maskToken(text: string): string {
  return text.replace(/ach_[A-Za-z0-9_-]+/g, 'ach_****')
}
