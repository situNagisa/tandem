// 脱敏正则的统一来源：理解为「哪些字符串看起来像凭据」。
// 调用方各自决定作用范围、替换文案与顺序（secrets 打码、分享脱敏、网关调试日志）。
// 注意：这些是带 /g 的正则对象，只用于 replace；不要对它们调用 test/exec（lastIndex 会跨调用残留）。

/** PEM 私钥块：RSA/EC/OPENSSH/DSA/PGP/ENCRYPTED 等；保留首尾标记供调用方选择替换方式。 */
export const PRIVATE_KEY =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g;

/** 常见服务商 Key/Token 形态：OpenAI 系、GitHub、GitLab、Slack、AWS、Google、Tandem 网关/成员令牌。 */
export const KNOWN_KEY =
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{6,}\b|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\b(?:tgw|tmm)_[a-f0-9]{16,}\b/g;

/** 裸 Bearer 凭据（无 Authorization 上下文时也能识别）。 */
export const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;

/** Tandem 网关令牌（单独导出以保留网关自己的替换文案）。 */
export const GATEWAY_TOKEN = /\btgw_[a-f0-9]{16,}/gi;

/** Tandem 成员令牌（同上）。 */
export const MEMBER_TOKEN = /\btmm_[a-f0-9]{16,}/gi;

/** Authorization 头（保留前缀，值替换）。 */
export const AUTH_HEADER = /\b(Authorization\s*[:=]\s*)(Bearer|Basic|Share)\s+[^\s"',;]+/gi;

/** URL 查询参数里的凭据。 */
export const QUERY_SECRET = /([?&](?:token|api[_-]?key|access_token|secret|password|key)=)[^&\s"'`]+/gi;

/** key/value 形式的结构化凭据（JSON、命令行参数等）。 */
export const ASSIGN_SECRET =
  /(["']?(?:api[_-]?key|apiKey|token|secret|password|authorization|bearer|shareToken)["']?\s*[:=]\s*)(["']?)[^\s"',;}]{6,}\2/gi;

/** 环境变量赋值。 */
export const ENV_ASSIGN =
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*)\s*=\s*[^\s"'`]+/g;

/** URL 里的 user:password@。 */
export const URL_CREDENTIAL = /\/\/([^/\s:@]+):([^/\s@]+)@/g;
