/**
 * 桌面版能否用系统文件夹对话框选目录。
 *
 * 只有「桌面客户端 + 所选主机就是这台电脑」才能共用文件系统：
 * 判据是所选主机的 HostInfo.id（Host 配置里的 hostId）与桌面内嵌 Host 的 hostId 相同。
 * 网页 / 手机 / 远程主机 / WSL 里的 Host 与 Windows 客户端不是同一文件系统，
 * 任一信息缺失也按非本机处理，回退到应用内目录浏览器。
 */
export interface DesktopLocalHostInput {
  isDesktop: boolean
  selectedHostId?: string | null
  localHostId?: string | null
}

export function isDesktopLocalHost({
  isDesktop,
  selectedHostId,
  localHostId,
}: DesktopLocalHostInput): boolean {
  return (
    isDesktop === true &&
    typeof selectedHostId === 'string' &&
    selectedHostId.length > 0 &&
    typeof localHostId === 'string' &&
    localHostId.length > 0 &&
    selectedHostId === localHostId
  )
}
