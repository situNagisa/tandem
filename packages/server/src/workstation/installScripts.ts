// 执行器安装脚本模板：工作站公开下发（GET /install.sh、GET /install.ps1）。
// 只嵌入工作站地址与各平台执行器的 sha256（取自请求 Host 头与构建产物），不嵌入令牌；令牌由用户执行时传入。
// 流程：按系统与架构下载 <工作站>/executor/<target> 单文件执行器 → 校验 sha256 → 装到 ~/.tandem-executor/bin → 前台 join。
// 纯函数，便于单测（sh -n 语法检查、内容断言）。

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface InstallScriptOptions {
  /** 工作站地址，如 http://192.168.1.10:8481（不带尾斜杠）。 */
  server: string;
  /** 目标名 → 该平台执行器的 sha256（小写十六进制）。缺失的目标在脚本里报“不支持”。 */
  digests: Record<string, string>;
}

const UNIX_TARGETS = ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'] as const;

function digestCaseLines(digests: Record<string, string>): string {
  return UNIX_TARGETS.map((target) => {
    const digest = (digests[target] ?? '').trim().toLowerCase();
    return digest ? `    ${target}) printf '%s' ${shellQuote(digest)} ;;` : '';
  })
    .filter((line) => line !== '')
    .join('\n');
}

export function buildUnixInstallScript(options: InstallScriptOptions): string {
  const server = options.server.replace(/\/+$/, '');
  return `#!/bin/sh
# Tandem 执行器一键安装：下载单文件执行器，前台登记并连接到工作站（一次性令牌，15 分钟内有效）。
# 用法： curl -fsSL ${server}/install.sh | sh -s -- --token ach_xxx
set -eu

SERVER=${shellQuote(server)}
TOKEN=\${TANDEM_TOKEN:-}
SERVICE=0
DRY_RUN=0
INSTALL_HOME="\${HOME:-}/.tandem-executor"
BIN="$INSTALL_HOME/bin/tandem-exec"

usage() {
  cat <<'USAGE'
用法: install.sh --token <绑定码> [--server <工作站地址>] [--service] [--dry-run]

  --token     工作站「添加主机」生成的一次性绑定码（ach_…，15 分钟有效；也可用环境变量 TANDEM_TOKEN）
  --server    工作站地址（默认使用下载本脚本的地址）
  --service   设置开机自启（下次登录后自动连接；失败只提示）
  --dry-run   只打印将要执行的步骤，不做任何改动
USAGE
}

mask_token() {
  case "$TOKEN" in
    ach_*) printf 'ach_****' ;;
    '') printf '(未提供)' ;;
    *) printf '****' ;;
  esac
}

digest_for() {
  case "$1" in
${digestCaseLines(options.digests)}
    *) printf '' ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    line=$(sha256sum "$1") || return 1
  elif command -v shasum >/dev/null 2>&1; then
    line=$(shasum -a 256 "$1") || return 1
  elif command -v openssl >/dev/null 2>&1; then
    line=$(openssl dgst -sha256 "$1") || return 1
    printf '%s\\n' "\${line##* }"
    return 0
  else
    return 1
  fi
  printf '%s\\n' "\${line%% *}"
}

need_value() {
  if [ "$2" -lt 2 ]; then
    echo "缺少 $1 的值" >&2
    exit 2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --token) need_value "$1" "$#"; TOKEN="$2"; shift 2 ;;
    --token=*) TOKEN=\${1#*=}; shift ;;
    --server) need_value "$1" "$#"; SERVER="$2"; shift 2 ;;
    --server=*) SERVER=\${1#*=}; shift ;;
    --service) SERVICE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

while [ "\${SERVER%/}" != "$SERVER" ]; do SERVER=\${SERVER%/}; done
[ -n "$SERVER" ] || { echo "请用 --server 指定工作站地址" >&2; exit 2; }
[ -n "$TOKEN" ] || { echo "缺少 --token（工作站「添加主机」生成的一次性绑定码）" >&2; usage >&2; exit 2; }
[ -n "\${HOME:-}" ] || { echo "无法确定主目录（HOME 为空）" >&2; exit 1; }

case "$(uname -s)" in
  Linux) OS_NAME=linux ;;
  Darwin) OS_NAME=darwin ;;
  *) echo "[x] 不支持的系统：$(uname -s)（支持 Linux、macOS）" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "[x] 不支持的 CPU 架构：$(uname -m)" >&2; exit 1 ;;
esac
TARGET="$OS_NAME-$ARCH"
DIGEST=$(digest_for "$TARGET")
[ -n "$DIGEST" ] || { echo "[x] 不支持本机平台：$TARGET（工作站没有提供该平台的执行器）。" >&2; exit 1; }
URL="$SERVER/executor/$TARGET"

if [ "$DRY_RUN" = 1 ]; then
  if [ "$SERVICE" = 1 ]; then
    SERVICE_TEXT="设置开机自启（下次登录后自动连接）"
  else
    SERVICE_TEXT="不设置开机自启（关闭窗口即断开）"
  fi
  echo "Tandem 执行器安装计划（--dry-run，不做任何改动）："
  echo "  工作站:   $SERVER"
  echo "  令牌:     $(mask_token)"
  echo "  平台:     $TARGET"
  echo "  安装路径: $BIN"
  echo "  开机自启: $SERVICE_TEXT"
  echo "  下载地址: $URL"
  echo "  sha256:   $(printf '%.12s' "$DIGEST")"
  exit 0
fi

TMP_DIR=$(mktemp -d "\${TMPDIR:-/tmp}/tandem-exec.XXXXXX")
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "正在下载执行器…"
if ! curl -fsSL "$URL" -o "$TMP_DIR/tandem-exec"; then
  echo "[x] 无法从 $URL 下载执行器（工作站可能没有该平台执行器，或本机连不上工作站）。" >&2
  exit 1
fi

echo "正在校验 sha256…"
if ! ACTUAL=$(sha256_of "$TMP_DIR/tandem-exec"); then
  echo "[x] 没有可用的 sha256 校验工具（需要 sha256sum、shasum 或 openssl 之一），无法校验下载内容。" >&2
  exit 1
fi
if [ "$ACTUAL" != "$DIGEST" ]; then
  echo "[x] 执行器校验失败（期望 $DIGEST，实际 $ACTUAL），已删除下载文件。" >&2
  rm -f "$TMP_DIR/tandem-exec"
  exit 1
fi

echo "正在安装到 $BIN …"
mkdir -p "$INSTALL_HOME/bin"
if [ -f "$BIN" ]; then
  rm -f "$BIN.old"
  if ! mv "$BIN" "$BIN.old"; then
    echo "[x] 无法移动已有执行器 $BIN。" >&2
    exit 1
  fi
fi
if ! cp "$TMP_DIR/tandem-exec" "$BIN"; then
  echo "[x] 无法写入 $BIN。" >&2
  exit 1
fi
chmod 755 "$BIN"

echo "正在登记本机到 $SERVER（令牌 $(mask_token)），前台运行；关闭此窗口即断开。"
set -- join --server "$SERVER" --token "$TOKEN"
if [ "$SERVICE" = 1 ]; then
  set -- "$@" --service
fi
set +e
"$BIN" "$@"
status=$?
set -e
if [ "$status" -ne 0 ]; then
  echo "[x] 执行器退出（退出码 $status）。原因见上方输出；绑定码一次性、15 分钟内有效，过期后在工作站重新生成。" >&2
fi
exit "$status"
`;
}

export function buildWindowsInstallScript(options: InstallScriptOptions): string {
  const server = options.server.replace(/\/+$/, '');
  const digest = (options.digests['windows-amd64'] ?? '').trim().toLowerCase();
  return `# Tandem 执行器一键安装（Windows PowerShell）：下载单文件执行器，前台登记并连接到工作站；关闭此窗口即断开。
# 用法（PowerShell）：
#   & ([scriptblock]::Create((irm ${server}/install.ps1))) -Token 'ach_xxx'
param(
  [string]$Token = $env:TANDEM_TOKEN,
  [string]$Server = '',
  [switch]$Service,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$DefaultServer = ${psQuote(server)}
if (-not $Server) { $Server = if ($env:TANDEM_SERVER) { $env:TANDEM_SERVER } else { $DefaultServer } }
$Server = $Server.TrimEnd('/')
$InstallDir = Join-Path $HOME '.tandem-executor'
$BinDir = Join-Path $InstallDir 'bin'
$Exe = Join-Path $BinDir 'tandem-exec.exe'
$Target = 'windows-amd64'
$Digest = ${psQuote(digest)}
$Url = "$Server/executor/$Target"

function Mask-Token {
  param([string]$Value)
  if (-not $Value) { return '(未提供)' }
  if ($Value.StartsWith('ach_')) { return 'ach_****' }
  return '****'
}

function Exit-WithHelp {
  param([string]$Message)
  Write-Host "[x] $Message" -ForegroundColor Red
  # 一行命令用 scriptblock 在当前 PowerShell 会话里执行：exit 会直接关掉用户的窗口，改用 throw。
  throw $Message
}

if (-not $Server) { Exit-WithHelp '请用 -Server 指定工作站地址' }
if (-not $Token) { Exit-WithHelp '缺少 -Token（工作站「添加主机」生成的一次性绑定码）' }
if (-not $Digest) { Exit-WithHelp "不支持本机平台：$Target（工作站没有提供该平台的执行器）。" }

if ($DryRun) {
  $ServiceText = if ($Service) { '设置开机自启（下次登录后自动连接）' } else { '不设置开机自启（关闭窗口即断开）' }
  Write-Host 'Tandem 执行器安装计划（-DryRun，不做任何改动）：'
  Write-Host "  工作站:   $Server"
  Write-Host "  令牌:     $(Mask-Token $Token)"
  Write-Host "  平台:     $Target"
  Write-Host "  安装路径: $Exe"
  Write-Host "  开机自启: $ServiceText"
  Write-Host "  下载地址: $Url"
  Write-Host "  sha256:   $($Digest.Substring(0, 12))"
  return
}

Write-Host '正在下载执行器…'
$TmpDir = Join-Path ([IO.Path]::GetTempPath()) ("tandem-exec-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null
try {
  $Download = Join-Path $TmpDir 'tandem-exec.exe'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Download
  } catch {
    Exit-WithHelp "无法从 $Url 下载执行器（工作站可能没有该平台执行器，或本机连不上工作站）。"
  }
  Write-Host '正在校验 sha256…'
  $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Download).Hash
  if ($Actual.ToLowerInvariant() -ne $Digest.ToLowerInvariant()) {
    Exit-WithHelp "执行器校验失败（期望 $Digest，实际 $Actual），已删除下载文件。"
  }

  Write-Host "正在安装到 $Exe …"
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  if (Test-Path -LiteralPath $Exe) {
    $Old = "$Exe.old"
    # 运行中的 exe 不能覆盖：先把已有文件改名挪开，再写入新文件。
    if (Test-Path -LiteralPath $Old) { Remove-Item -LiteralPath $Old -Force }
    Move-Item -LiteralPath $Exe -Destination $Old -Force
  }
  Copy-Item -LiteralPath $Download -Destination $Exe -Force

  Write-Host "正在登记本机到 $Server（令牌 $(Mask-Token $Token)），前台运行；关闭此窗口即断开。"
  $JoinArgs = @('join', '--server', $Server, '--token', $Token)
  if ($Service) { $JoinArgs += '--service' }
  & $Exe @JoinArgs
  $Code = $LASTEXITCODE
  if ($Code -ne 0) {
    Exit-WithHelp "执行器退出（退出码 $Code）。原因见上方输出；绑定码一次性、15 分钟内有效，过期后在工作站重新生成。"
  }
} finally {
  Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}
`;
}
