import { useEffect, useState } from 'react'
import {
  Check,
  ChevronRight,
  CircleAlert,
  Lock,
  ServerCog,
  ShieldCheck,
  Terminal,
  TriangleAlert,
} from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import type {
  SshAuthKind,
  SshHostInput,
  SshHostKeyInfo,
  SshJob,
  SshProbeResult,
} from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { Button } from '../ui/Button'
import { Input, SegmentedControl, Switch } from '../ui/Controls'
import { Modal } from '../ui/Modal'
import { cn } from '../../lib/cn'
import type { HostConfig } from '../../lib/types'

export function SshJobProgress({ job }: { job: SshJob }) {
  return (
    <div className="space-y-1.5" data-ssh-job={job.kind} data-ssh-job-status={job.status}>
      {job.steps.map((step) => (
        <div key={step.id} className="flex items-start gap-2 text-[13px]">
          <span
            className={cn(
              'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
              step.status === 'ok'
                ? 'border-success/40 bg-success/15 text-success'
                : step.status === 'fail'
                  ? 'border-danger/40 bg-danger/15 text-danger'
                  : step.status === 'running'
                    ? 'border-border bg-surface-2 text-text'
                    : 'border-border text-muted',
            )}
          >
            {step.status === 'ok' ? (
              <Check size={11} />
            ) : step.status === 'fail' ? (
              <TriangleAlert size={11} />
            ) : step.status === 'running' ? (
              <Spinner size={10} />
            ) : (
              <span className="size-1 rounded-full bg-current" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className={cn(step.status === 'pending' ? 'text-muted' : 'text-text-soft')}>
              {step.title}
            </div>
            {step.detail && (
              <div className="break-all font-mono text-[12px] leading-4 text-muted">{step.detail}</div>
            )}
          </div>
        </div>
      ))}
      {job.error && (
        <div className="mt-1 flex items-start gap-1.5 rounded-lg bg-danger/10 px-2 py-1.5 text-[12px] leading-4 text-danger">
          <CircleAlert size={12} className="mt-0.5 shrink-0" />
          <span className="break-all">{job.error}</span>
        </div>
      )}
    </div>
  )
}

function formatFingerprint(fp: string): string {
  const raw = fp.replace(/^SHA256:/, '')
  return `SHA256:${raw.match(/.{1,8}/g)?.join(' ') ?? raw}`
}

function parseTarget(text: string, port: number): { user: string; host: string; port: number } {
  const match = text.trim().match(/^([^@\s]+)@([^:\s]+)$/)
  if (!match) throw new Error('请使用 user@host 格式（例如 root@192.168.1.20）')
  return { user: match[1]!, host: match[2]!, port }
}

interface Props {
  controller: HostConfig
  onClose: () => void
}

/** 设置-主机 → 添加远程主机 → 通过 SSH：探测、确认指纹、部署并自动添加为普通主机。 */
export function RemoteSshDialog({ controller, onClose }: Props) {
  const addHost = useAppStore((s) => s.addHost)
  const toast = useUiStore((s) => s.toast)

  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [port, setPort] = useState('22')
  const [authKind, setAuthKind] = useState<SshAuthKind>('agent')
  const [keyPath, setKeyPath] = useState('')
  const [password, setPassword] = useState('')
  const [remotePort, setRemotePort] = useState('7878')
  const [listenLan, setListenLan] = useState(false)
  const [uploadNode, setUploadNode] = useState(false)
  const [service, setService] = useState<'auto' | 'systemd' | 'nohup'>('auto')

  const [keyInfo, setKeyInfo] = useState<SshHostKeyInfo | null>(null)
  const [probe, setProbe] = useState<SshProbeResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [probing, setProbing] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [job, setJob] = useState<SshJob | null>(null)
  const [error, setError] = useState<string | null>(null)

  const busy = scanning || probing || deploying

  const resetDetection = () => {
    setKeyInfo(null)
    setProbe(null)
    setError(null)
  }

  const scan = async () => {
    setError(null)
    setKeyInfo(null)
    setProbe(null)
    setScanning(true)
    try {
      const info = await api.sshScanKey(controller, parseTarget(target, Number(port)))
      setKeyInfo(info)
      if (info.changed) setError('主机公钥与上次记录不一致，已阻止连接。请确认是否重装过系统或存在中间人。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取主机公钥')
    } finally {
      setScanning(false)
    }
  }

  const confirmAndProbe = async () => {
    if (!keyInfo) return
    setError(null)
    setProbing(true)
    try {
      const result = await api.sshProbe(controller, {
        target: parseTarget(target, Number(port)),
        auth: {
          kind: authKind,
          ...(authKind === 'key' ? { keyPath: keyPath.trim() } : {}),
          ...(authKind === 'password' ? { password } : {}),
        },
        fingerprint: keyInfo.fingerprint,
      })
      setProbe(result)
      if (!result.authOk) setError(result.error ?? 'SSH 登录失败')
    } catch (err) {
      setError(err instanceof Error ? err.message : '探测失败')
    } finally {
      setProbing(false)
    }
  }

  const deploy = async () => {
    if (!keyInfo || !probe?.authOk) return
    setError(null)
    setDeploying(true)
    try {
      const input: SshHostInput = {
        ...(name.trim() ? { name: name.trim() } : {}),
        target: parseTarget(target, Number(port)),
        auth: {
          kind: authKind,
          ...(authKind === 'key' ? { keyPath: keyPath.trim() } : {}),
          ...(authKind === 'password' ? { password } : {}),
        },
        fingerprint: keyInfo.fingerprint,
        ...(remotePort.trim() ? { remotePort: Number(remotePort) } : {}),
        ...(listenLan ? { listenLan: true } : {}),
        ...(uploadNode ? { uploadNode: true } : {}),
        ...(service !== 'auto' ? { service } : {}),
      }
      const next = await api.sshDeploy(controller, input)
      setJob(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : '部署失败')
      setDeploying(false)
    }
  }

  // 轮询部署任务；成功后把远程主机以普通主机身份加入客户端。
  useEffect(() => {
    if (!job || job.status !== 'running') return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const next = await api.sshJob(controller, job.id)
        if (cancelled) return
        setJob(next)
        if (next.status === 'ok' && next.result) {
          const result = next.result
          addHost({
            name: result.client.name,
            url: result.client.url,
            token: result.client.token,
            mode: 'ssh',
            sshHostId: result.host.id,
            sshControllerId: controller.id,
            sshTarget: `${result.host.target.user}@${result.host.target.host}:${result.host.target.port}`,
          })
          toast(`已部署并添加远程主机「${result.client.name}」`, 'success')
          setPassword('')
          setDeploying(false)
          onClose()
        } else if (next.status === 'fail') {
          setError(next.error ?? '部署失败')
          setDeploying(false)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '无法获取部署进度')
      }
    }, 700)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [job, controller, addHost, toast, onClose])

  const nodeBad = probe?.authOk && (!probe.node || !probe.node.ok)

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title="通过 SSH 添加远程主机"
      description={`由「${controller.name}」使用本机 OpenSSH 部署并维护隧道；密码只用于本次连接，不会保存。`}
      className="max-w-2xl"
      footer={
        <>
          {job?.status === 'fail' && (
            <Button
              onClick={() => {
                setJob(null)
                setDeploying(false)
                setError(job.error ?? '部署失败')
              }}
            >
              返回修改
            </Button>
          )}
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          {!keyInfo && (
            <Button variant="primary" onClick={() => void scan()} disabled={busy || !target.trim()}>
              {scanning && <Spinner size={13} />}
              检测主机
            </Button>
          )}
          {keyInfo && !probe?.authOk && (
            <Button
              variant="primary"
              onClick={() => void confirmAndProbe()}
              disabled={busy || keyInfo.changed || (authKind === 'key' && !keyPath.trim()) || (authKind === 'password' && !password)}
            >
              {probing && <Spinner size={13} />}
              确认指纹并检测
            </Button>
          )}
          {probe?.authOk && !job && (
            <Button
              data-setting-id="hosts.ssh.deploy"
              variant="primary"
              onClick={() => void deploy()}
              disabled={busy || !probe.node?.ok && !uploadNode}
            >
              {deploying && <Spinner size={13} />}
              部署并添加
            </Button>
          )}
        </>
      }
    >
      {!job && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_110px]">
            <div>
              <label className="settings-label">SSH 目标</label>
              <Input
                data-setting-id="hosts.ssh.target"
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value)
                  resetDetection()
                }}
                placeholder="user@192.168.1.20"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-[13px]"
              />
              <p className="mt-1 text-[12px] leading-4 text-muted">只连接内网或你自己指定的机器。</p>
            </div>
            <div>
              <label className="settings-label">SSH 端口</label>
              <Input
                data-setting-id="hosts.ssh.port"
                value={port}
                onChange={(e) => {
                  setPort(e.target.value.replace(/\D/g, ''))
                  resetDetection()
                }}
                inputMode="numeric"
                className="font-mono text-[13px]"
              />
            </div>
          </div>

          <div>
            <label className="settings-label">认证方式</label>
            <SegmentedControl
              aria-label="SSH 认证方式"
              className="flex w-full"
              value={authKind}
              onChange={setAuthKind}
              options={[
                { value: 'agent', label: 'ssh-agent' },
                { value: 'key', label: '私钥文件' },
                { value: 'password', label: '密码（不保存）' },
              ]}
            />
            {authKind === 'agent' && (
              <p className="mt-1.5 text-[12px] leading-4 text-muted">
                使用本机已运行的 ssh-agent。Windows 请在「服务」里确认 OpenSSH Authentication Agent 已启动并 ssh-add 过 Key。
              </p>
            )}
            {authKind === 'key' && (
              <Input
                data-setting-id="hosts.ssh.key"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="私钥路径，如 ~/.ssh/id_ed25519 或 C:\Users\你\.ssh\id_ed25519"
                spellCheck={false}
                className="mt-1.5 font-mono text-[13px]"
              />
            )}
            {authKind === 'password' && (
              <div className="mt-1.5 flex items-start gap-2">
                <Input
                  data-setting-id="hosts.ssh.password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="SSH 登录密码"
                  autoComplete="new-password"
                  className="font-mono text-[13px]"
                />
                <span className="flex h-8 shrink-0 items-center gap-1 text-[12px] text-muted">
                  <Lock size={11} /> 不保存
                </span>
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="settings-label">主机名称（可选）</label>
              <Input
                data-setting-id="hosts.ssh.name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="缺省用 user@host"
              />
            </div>
            <div>
              <label className="settings-label">远程 Host 端口</label>
              <Input
                data-setting-id="hosts.ssh.remotePort"
                value={remotePort}
                onChange={(e) => setRemotePort(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className="font-mono text-[13px]"
              />
            </div>
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px]">远程监听局域网</div>
                <p className="text-[12px] leading-4 text-muted">
                  关闭时只监听远程 127.0.0.1，客户端经 SSH 隧道访问。打开后同网段设备可用 token 直连（不建议）。
                </p>
              </div>
              <Switch checked={listenLan} onChange={setListenLan} label="远程监听局域网" />
            </div>
            <div>
              <div className="text-[13px]">服务方式</div>
              <p className="text-[12px] leading-4 text-muted">自动：有 systemd --user 用 systemd，否则 nohup + 每分钟检查。</p>
              <SegmentedControl
                aria-label="服务方式"
                className="mt-2 flex w-full"
                value={service}
                onChange={setService}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'systemd', label: 'systemd --user' },
                  { value: 'nohup', label: 'nohup + cron' },
                ]}
              />
            </div>
          </div>

          {keyInfo && (
            <div
              data-setting-id="hosts.ssh.fingerprint"
              className={cn(
                'rounded-xl border p-3',
                keyInfo.changed ? 'border-danger/40 bg-danger/5' : 'border-border bg-surface',
              )}
            >
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                <ShieldCheck size={13} className={keyInfo.changed ? 'text-danger' : 'text-success'} />
                主机公钥指纹
                {keyInfo.known && !keyInfo.changed && <span className="text-[12px] font-normal text-muted">（与上次记录一致）</span>}
              </div>
              <div className="mt-1 break-all font-mono text-[12px] leading-5 text-text-soft">
                {formatFingerprint(keyInfo.fingerprint)}
              </div>
              <p className="mt-1 text-[12px] leading-4 text-muted">
                {keyInfo.changed
                  ? '与 ~/.tandem/ssh_known_hosts 中的记录不同，已阻止连接。'
                  : '请通过带外渠道核对（服务器控制台 / 管理员）。确认后才会把该公钥写入 known_hosts。'}
              </p>
              <p className="mt-1 text-[12px] text-muted">
                {keyInfo.keyType} · {keyInfo.host}:{keyInfo.port}
              </p>
            </div>
          )}

          {probe && (
            <div className="rounded-xl border border-border bg-surface p-3 text-[13px]" data-setting-id="hosts.ssh.probe">
              {probe.authOk ? (
                <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="flex items-center gap-1 font-medium">
                      <Terminal size={12} /> {probe.hostname}
                    </span>
                    <span className="text-muted">{probe.platform}/{probe.arch}</span>
                    <span className={probe.node?.ok ? 'text-muted' : 'text-warning'}>
                      Node {probe.node?.version || '未安装'}
                      {probe.node?.ok ? ' ✓' : '（需要 ≥ 22）'}
                    </span>
                    <span className="text-muted">{probe.systemd ? 'systemd --user' : '无 systemd --user'}</span>
                  </div>
                  {nodeBad && (
                    <div className="mt-2 rounded-lg bg-warning/10 px-2 py-1.5 text-[12px] leading-4 text-warning">
                      <div className="flex items-start gap-1.5">
                        <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                        <span>
                          远程 Node 不满足要求。不会从公网自动下载；请先在远程安装 Node ≥ 22，或
                          {probe.nodeUpload?.available ? '勾选下方「从本机上传 Node」。' : `本机无法上传（${probe.nodeUpload?.reason ?? '平台不一致'}）。`}
                        </span>
                      </div>
                      {probe.nodeUpload?.available && (
                        <label className="mt-1.5 flex items-center justify-between gap-2 text-text-soft">
                          <span>从本机上传 Node {probe.nodeUpload.version}（{probe.nodeUpload.platform}/{probe.nodeUpload.arch}）</span>
                          <span data-setting-id="hosts.ssh.uploadNode">
                            <Switch checked={uploadNode} onChange={setUploadNode} label="从本机上传 Node" />
                          </span>
                        </label>
                      )}
                    </div>
                  )}
                  <div className="mt-2 flex items-center gap-1 text-[12px] text-muted">
                    <ServerCog size={11} /> 将安装到 {probe.homeDir}/.tandem-host，数据在 {probe.homeDir}/.tandem
                  </div>
                </>
              ) : (
                <div className="flex items-start gap-1.5 text-danger">
                  <CircleAlert size={12} className="mt-0.5 shrink-0" />
                  <span>{probe.error ?? 'SSH 登录失败'}</span>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-1.5 rounded-lg bg-danger/10 px-2.5 py-2 text-[12px] leading-4 text-danger">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
        </div>
      )}

      {job && (
        <div className="space-y-2">
          <SshJobProgress job={job} />
          <p className="text-[12px] leading-4 text-muted">
            {job.status === 'running'
              ? '正在部署，请不要关闭设置页。首次上传约 10–30 MB，取决于网络。'
              : job.status === 'fail'
                ? '可查看日志或重新检测后重试；已上传的文件保留在 ~/.tandem-host。'
                : '完成。'}
          </p>
        </div>
      )}
    </Modal>
  )
}
