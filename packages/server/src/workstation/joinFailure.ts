// join 失败的归因：把登记错误翻成「用户照着做就能解决」的提示。纯函数，便于单测。
// 背景（R56）：以前一律说「绑定码过期」，误导；现在失败原因必须能落到下面几类之一。

export type JoinFailureKind = 'bind-code' | 'workstation-unreachable' | 'already-joined' | 'unknown';

export interface JoinFailureInput {
  /** 登记错误的 HTTP 状态（网络层失败时传 0）。 */
  status: number;
  /** 原始文案，原样呈现。 */
  message: string;
  /** 工作站地址，用于提示里指明连不上谁。 */
  workstationUrl?: string;
}

export interface JoinFailureExplanation {
  kind: JoinFailureKind;
  title: string;
  hints: string[];
}

/** 文案关键字优先级高于状态码：工作站的 401 会被包成 502 再返回。 */
export function explainJoinFailure(input: JoinFailureInput): JoinFailureExplanation {
  const message = input.message ?? '';
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
  if (/无法连接工作站|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed out|超时/.test(message)) {
    return {
      kind: 'workstation-unreachable',
      title: `本机连不上工作站 ${workstation}`,
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
      hints: ['要换到别的工作站：先在工作站页面移除这台主机，再清空本机数据目录（默认 ~/.tandem-host/data）后重新执行。'],
    };
  }
  return {
    kind: 'unknown',
    title: '登记失败',
    hints: ['把上面的输出发给维护人员排查。'],
  };
}
