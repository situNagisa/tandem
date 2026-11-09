// join 失败的归因：把本机 Host 返回的 HTTP 状态与文案翻成「用户照着做就能解决」的提示。
// 纯函数，便于单测；CLI 只负责拼文案，不做网络判断。
//
// 背景（R56）：Windows 上 join 的任何失败都会被一次 libuv 断言（0xC0000409）盖掉，
// 安装脚本只看到「登记失败（退出码 -1073740791）」，于是提示绑定码过期——误导。
// 现在失败原因必须能落到下面几类之一，各自给不同提示。

export type JoinFailureKind =
  | 'bind-code'
  | 'host-token'
  | 'workstation-unreachable'
  | 'already-joined'
  | 'host-not-owner'
  | 'unknown';

export interface JoinFailureInput {
  /** 本机 Host 返回的 HTTP 状态（网络层失败时传 0）。 */
  status: number;
  /** Host 返回的原始文案，原样呈现。 */
  message: string;
  /** 本机 Host 端口，默认 7878。 */
  hostPort?: number;
  /** 工作站地址，用于提示里指明连不上谁。 */
  workstationUrl?: string;
}

export interface JoinFailureExplanation {
  kind: JoinFailureKind;
  title: string;
  hints: string[];
}

/** 文案关键字优先级高于状态码：Host 会把工作站的 401 包成 502 再返回。 */
export function explainJoinFailure(input: JoinFailureInput): JoinFailureExplanation {
  const message = input.message ?? '';
  const hostPort = input.hostPort ?? 7878;
  const workstation = input.workstationUrl ?? '工作站';

  if (/绑定码|注册令牌|一次性令牌/.test(message)) {
    return {
      kind: 'bind-code',
      title: '绑定码无效、已使用或已过期',
      hints: [
        '绑定码一次性、15 分钟内有效：在工作站「添加主机」重新生成一个，再执行本命令。',
        '令牌要完整复制（以 ach_ 开头），不要带引号之外的空白。',
      ],
    };
  }
  if (/仅 Host 所有者|未授权|令牌无效|token 无效|令牌.*吊销|Host 令牌/.test(message)) {
    return {
      kind: 'host-token',
      title: `本机 127.0.0.1:${hostPort} 上的 Tandem Host 拒绝了本机令牌`,
      hints: [
        '该端口上的 Host 不是这个数据目录（TANDEM_HOME）的，通常是另一个 Tandem 实例还在跑。',
        `关掉那个实例，或用 --port 指定一个别的端口后重试（例：--port ${hostPort + 1}）。`,
      ],
    };
  }
  if (/无法连接工作站|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed out|超时/.test(message)) {
    return {
      kind: 'workstation-unreachable',
      title: `本机 Host 连不上工作站 ${workstation}`,
      hints: [
        '确认工作站地址、端口和防火墙；从这台机器用浏览器打开该地址应能看到登录页。',
        '如果刚重新生成过绑定码，先确认工作站服务还在运行，再重试。',
      ],
    };
  }
  if (input.status === 409) {
    return {
      kind: 'already-joined',
      title: '本机已经加入过别的工作站',
      hints: ['先在本机执行 tandem-host 的相关命令退出原工作站（或在客户端里移除这台主机），再重新加入。'],
    };
  }
  if (input.status === 403) {
    return {
      kind: 'host-not-owner',
      title: '本机 Host 拒绝了这个操作',
      hints: [`只有 Host 所有者（本机 ~/.tandem 的主 token）能登记本机；确认 127.0.0.1:${hostPort} 上的 Host 属于当前用户。`],
    };
  }
  if (input.status === 401 && /401/.test(message)) {
    return {
      kind: 'host-token',
      title: `本机 127.0.0.1:${hostPort} 上的 Tandem Host 拒绝了本机令牌`,
      hints: [`关掉占用 ${hostPort} 的 Tandem 实例，或用 --port 换一个端口后重试。`],
    };
  }
  return {
    kind: 'unknown',
    title: '登记失败',
    hints: [`原始错误：${message || '（没有返回内容）'}`, '查看本机 Host 日志（TANDEM_HOME/host.log）后再重试。'],
  };
}
