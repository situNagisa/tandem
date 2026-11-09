// 主机安装脚本模板：工作站公开下发（GET /install.sh、GET /install.ps1）。
// 只嵌入工作站地址（取自请求 Host 头），不嵌入令牌；令牌由用户执行时传入。
// 纯函数，便于单测（sh -n 语法检查、内容断言）。

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface InstallScriptOptions {
  /** 工作站地址，如 http://192.168.1.10:8481（不带到尾斜杠）。 */
  server: string;
}

export function buildUnixInstallScript(options: InstallScriptOptions): string {
  const server = options.server.replace(/\/+$/, '');
  return `#!/bin/sh
# Tandem 主机一键安装：安装本机主机程序并登记到工作站（一次性令牌，15 分钟内有效）。
# 用法： curl -fsSL ${server}/install.sh | sh -s -- --token ach_xxx
set -eu

SERVER=${shellQuote(server)}
TOKEN=\${TANDEM_TOKEN:-}
NAME=""
WANT_SERVICE=1
PORT=""
DRY_RUN=0
INSTALL_DIR=\${TANDEM_INSTALL_DIR:-$HOME/.tandem-host}
APP="$INSTALL_DIR/app"
BIN="$INSTALL_DIR/bin/tandem-host"
LOG_FILE="$INSTALL_DIR/host.log"

usage() {
  cat <<'USAGE'
用法: install.sh --token <绑定码> [--server <工作站地址>] [--name <主机名>] [--port <端口>] [--no-service] [--dry-run]

  --token       工作站「添加主机」生成的一次性绑定码（ach_…，15 分钟有效；也可用环境变量 TANDEM_TOKEN）
  --server      工作站地址（默认使用下载本脚本的地址）
  --name        主机显示名（默认 hostname）
  --port        本机 Host 端口（默认 7878）
  --no-service  不安装系统服务，只起后台进程（重启后需重新运行）
  --dry-run     只打印将要执行的步骤，不做任何改动
USAGE
}

mask_token() {
  case "$TOKEN" in
    ach_*) printf 'ach_****' ;;
    '') printf '(未提供)' ;;
    *) printf '****' ;;
  esac
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
    --name) need_value "$1" "$#"; NAME="$2"; shift 2 ;;
    --name=*) NAME=\${1#*=}; shift ;;
    --port) need_value "$1" "$#"; PORT="$2"; shift 2 ;;
    --port=*) PORT=\${1#*=}; shift ;;
    --no-service) WANT_SERVICE=0; shift ;;
    --service) WANT_SERVICE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

SERVER=\${SERVER%/}
while [ "\${SERVER%/}" != "$SERVER" ]; do SERVER=\${SERVER%/}; done
[ -n "$SERVER" ] || { echo "请用 --server 指定工作站地址" >&2; exit 2; }
[ -n "$TOKEN" ] || { echo "缺少 --token（工作站「添加主机」生成的一次性绑定码）" >&2; usage >&2; exit 2; }
NAME=\${NAME:-$(hostname 2>/dev/null || echo tandem-host)}

node_help() {
  echo "" >&2
  echo "手动安装步骤：" >&2
  echo "  1. 安装 Node.js 22 或更高版本（https://nodejs.org/），或用系统包管理器安装 nodejs" >&2
  echo "     有 Node 22+ 时也可用 npm i -g（从工作站下载的 tgz 里执行 npm i -g ./tandem-host.tgz）" >&2
  echo "  2. 下载并解压主机安装包：" >&2
  echo "       curl -fsSL $SERVER/dl/tandem-host.tgz -o tandem-host.tgz" >&2
  echo "       mkdir -p $APP && tar -xzf tandem-host.tgz -C $APP" >&2
  echo "     解压后应能看到 $APP/dist/cli.js；没有就是下载不完整。" >&2
  echo "  3. 登记本机（令牌 $(mask_token)）：" >&2
  echo "       node $APP/dist/cli.js join $SERVER --token <绑定码> --name $NAME --service" >&2
  echo "     说明：不装系统服务时用 --no-service，只起后台进程。" >&2
}

if [ "$DRY_RUN" = 1 ]; then
  if [ "$WANT_SERVICE" = 1 ]; then SERVICE_TEXT="安装系统服务（开机自启、断线自动重连）"; else SERVICE_TEXT="不安装系统服务（仅后台进程）"; fi
  echo "Tandem 主机安装计划（--dry-run，不做任何改动）："
  echo "  工作站:   $SERVER"
  echo "  令牌:     $(mask_token)"
  echo "  主机名:   $NAME"
  echo "  安装目录: $INSTALL_DIR"
  echo "  本机端口: \${PORT:-7878}"
  echo "  服务:     $SERVICE_TEXT"
  echo "  步骤:"
  echo "    1. 检查 Node.js 版本（需要 22 或更高）"
  echo "    2. 下载 $SERVER/dl/tandem-host.tgz 并解压到 $APP"
  echo "    3. 写启动脚本 $BIN，并尝试链接到 ~/.local/bin/tandem-host"
  echo "    4. 运行: node $APP/dist/cli.js join $SERVER --token $(mask_token) --name $NAME \${PORT:+--port $PORT} $([ "$WANT_SERVICE" = 1 ] && echo --service || echo --no-service)"
  exit 0
fi

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.local/bin/node"; do
    if [ -x "$candidate" ]; then
      printf '%s\\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN=$(find_node || true)
if [ -z "$NODE_BIN" ]; then
  echo "[x] 没有找到 Node.js（需要 22 或更高版本）。" >&2
  node_help
  exit 1
fi
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) NODE_MAJOR=0 ;;
esac
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[x] Node.js 版本过低（当前 $("$NODE_BIN" -v 2>/dev/null || echo 未知)，需要 22+）。" >&2
  node_help
  exit 1
fi

TMP_DIR=$(mktemp -d "\${TMPDIR:-/tmp}/tandem-host.XXXXXX")
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "正在下载主机安装包…"
if ! curl -fsSL "$SERVER/dl/tandem-host.tgz" -o "$TMP_DIR/tandem-host.tgz"; then
  echo "[x] 无法从 $SERVER/dl/tandem-host.tgz 下载主机安装包。" >&2
  echo "    工作站可能没有随附安装包，或本机无法访问该地址。" >&2
  node_help
  exit 1
fi

echo "正在安装到 $APP …"
mkdir -p "$INSTALL_DIR/bin"
rm -rf "$APP"
mkdir -p "$APP"
if ! tar -xzf "$TMP_DIR/tandem-host.tgz" -C "$APP"; then
  echo "[x] 解压安装包失败。" >&2
  node_help
  exit 1
fi
if [ ! -f "$APP/dist/cli.js" ]; then
  echo "[x] 安装包内容不完整（缺少 dist/cli.js）。" >&2
  node_help
  exit 1
fi

cat > "$BIN" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$APP/dist/cli.js" "\\$@"
EOF
chmod 755 "$BIN"

mkdir -p "$HOME/.local/bin" 2>/dev/null || true
if ln -sf "$BIN" "$HOME/.local/bin/tandem-host" 2>/dev/null; then
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) echo "命令已就绪: tandem-host" ;;
    *) echo "命令已安装到 $HOME/.local/bin/tandem-host（该目录不在 PATH，可用完整路径或把 ~/.local/bin 加入 PATH）" ;;
  esac
fi

echo "正在登记本机到 $SERVER（令牌 $(mask_token)）…"
set -- join "$SERVER" --token "$TOKEN" --name "$NAME"
if [ -n "$PORT" ]; then
  set -- "$@" --port "$PORT"
fi
if [ "$WANT_SERVICE" = 1 ]; then
  set -- "$@" --service
else
  set -- "$@" --no-service
fi
set +e
"$NODE_BIN" "$APP/dist/cli.js" "$@"
status=$?
set -e
if [ "$status" -ne 0 ]; then
  echo "[x] 登记失败（退出码 $status）。" >&2
  echo "    绑定码一次性且 15 分钟内有效；可在工作站「添加主机」重新生成后再执行本命令。" >&2
fi
exit "$status"
`;
}

export function buildWindowsInstallScript(options: InstallScriptOptions): string {
  const server = options.server.replace(/\/+$/, '');
  return `# Tandem 主机一键安装（Windows PowerShell）：安装本机主机程序并登记到工作站。
# 用法（PowerShell）：
#   & ([scriptblock]::Create((irm ${server}/install.ps1))) -Token 'ach_xxx'
param(
  [string]$Token = $env:TANDEM_TOKEN,
  [string]$Server = '',
  [string]$Name = '',
  [switch]$NoService,
  [switch]$DryRun,
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$DefaultServer = ${psQuote(server)}
if (-not $Server) { $Server = if ($env:TANDEM_SERVER) { $env:TANDEM_SERVER } else { $DefaultServer } }
$Server = $Server.TrimEnd('/')
$InstallDir = if ($env:TANDEM_INSTALL_DIR) { $env:TANDEM_INSTALL_DIR } else { Join-Path $HOME '.tandem-host' }
$AppDir = Join-Path $InstallDir 'app'
$BinDir = Join-Path $InstallDir 'bin'
$LogFile = Join-Path $InstallDir 'host.log'

function Mask-Token {
  param([string]$Value)
  if (-not $Value) { return '(未提供)' }
  if ($Value.StartsWith('ach_')) { return 'ach_****' }
  return '****'
}

function Exit-WithHelp {
  param([string]$Message)
  Write-Host "[x] $Message" -ForegroundColor Red
  Write-Host ''
  Write-Host '手动安装步骤：'
  Write-Host '  1. 安装 Node.js 22 或更高版本（https://nodejs.org/）'
  Write-Host '     安装后在 PowerShell 里确认：node -v'
  Write-Host '  2. 下载并解压主机安装包（ZIP，不依赖 tar）：'
  Write-Host "       Invoke-WebRequest -UseBasicParsing -Uri $Server/dl/tandem-host.zip -OutFile \`$env:TEMP\\tandem-host.zip"
  Write-Host "       Expand-Archive -Path \`$env:TEMP\\tandem-host.zip -DestinationPath '$AppDir' -Force"
  Write-Host "     解压后应有 '$AppDir\\dist\\cli.js'；没有就是下载不完整，重试第 2 步。"
  Write-Host '  3. 登记本机（把 <绑定码> 换成工作站生成的一次性令牌，15 分钟有效）：'
  Write-Host "       node '$AppDir\\dist\\cli.js' join $Server --token <绑定码> --name $([Environment]::MachineName)"
  Write-Host '     默认安装为登录自启的系统服务；只想起后台进程时加 --no-service。'
  exit 1
}

if (-not $Server) { Exit-WithHelp '请用 -Server 指定工作站地址' }
if (-not $Token) { Exit-WithHelp '缺少 -Token（工作站「添加主机」生成的一次性绑定码）' }
if (-not $Name) { $Name = [Environment]::MachineName }

$ServiceText = if ($NoService) { '不安装系统服务（仅后台进程）' } else { '安装系统服务（登录自启、崩溃自动重启）' }
if ($DryRun) {
  Write-Host 'Tandem 主机安装计划（-DryRun，不做任何改动）：'
  Write-Host "  工作站:   $Server"
  Write-Host "  令牌:     $(Mask-Token $Token)"
  Write-Host "  主机名:   $Name"
  Write-Host "  安装目录: $InstallDir"
  Write-Host "  本机端口: $(if ($Port -gt 0) { $Port } else { 7878 })"
  Write-Host "  服务:     $ServiceText"
  Write-Host '  步骤:'
  Write-Host '    1. 检查 Node.js 版本（需要 22 或更高）'
  Write-Host "    2. 下载 $Server/dl/tandem-host.zip 并用 Expand-Archive 解压到 $AppDir"
  Write-Host "    3. 写启动脚本 $BinDir\\tandem-host.cmd"
  Write-Host "    4. 运行: node $AppDir\\dist\\cli.js join $Server --token $(Mask-Token $Token) --name $Name $(if ($Port -gt 0) { "--port $Port" } else { '' }) $(if ($NoService) { '--no-service' } else { '--service' })"
  exit 0
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) { Exit-WithHelp '没有找到 Node.js（需要 22 或更高版本）。' }
$NodePath = $NodeCmd.Source
$NodeMajor = 0
try { $NodeMajor = [int](& $NodePath -p "process.versions.node.split('.')[0]") } catch { $NodeMajor = 0 }
if ($NodeMajor -lt 22) { Exit-WithHelp "Node.js 版本过低（当前 $(& $NodePath -v)，需要 22+）。" }

Write-Host '正在下载主机安装包…'
$TmpDir = Join-Path ([IO.Path]::GetTempPath()) ("tandem-host-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null
try {
  $Zip = Join-Path $TmpDir 'tandem-host.zip'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$Server/dl/tandem-host.zip" -OutFile $Zip
  } catch {
    Exit-WithHelp "无法从 $Server/dl/tandem-host.zip 下载主机安装包（工作站可能没有随附安装包，或本机无法访问该地址）。"
  }
  $ZipSize = (Get-Item -LiteralPath $Zip).Length
  if ($ZipSize -lt 1024) { Exit-WithHelp "下载的主机安装包不完整（只有 $ZipSize 字节）。" }

  Write-Host "正在安装到 $AppDir …"
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
  New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
  # Windows 自带 tar 在中文/特殊路径上会失败（Invalid empty pathname）；安装包是 ZIP，用 Expand-Archive。
  try {
    Expand-Archive -LiteralPath $Zip -DestinationPath $AppDir -Force
  } catch {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $AppDir)
  }
  if (-not (Test-Path (Join-Path $AppDir 'dist\\cli.js'))) {
    Exit-WithHelp '解压安装包失败或安装包内容不完整（缺少 dist/cli.js）。'
  }

  $Wrapper = Join-Path $BinDir 'tandem-host.cmd'
  $wrapperLines = @(
    '@echo off',
    'chcp 65001 >nul',
    ('"' + $NodePath + '" "' + (Join-Path $AppDir 'dist\\cli.js') + '" %*')
  )
  # 不带 BOM 的 UTF-8：cmd 在 chcp 65001 后能正确读中文路径。
  [IO.File]::WriteAllText($Wrapper, ($wrapperLines -join "\`r\`n") + "\`r\`n", [Text.UTF8Encoding]::new($false))
  Write-Host "启动脚本: $Wrapper"

  Write-Host "正在登记本机到 $Server（令牌 $(Mask-Token $Token)）…"
  $joinArgs = @((Join-Path $AppDir 'dist\\cli.js'), 'join', $Server, '--token', $Token, '--name', $Name)
  if ($Port -gt 0) { $joinArgs += @('--port', [string]$Port) }
  if ($NoService) { $joinArgs += '--no-service' } else { $joinArgs += '--service' }
  & $NodePath @joinArgs
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-Host "[x] 登记失败（退出码 $code）。" -ForegroundColor Red
    Write-Host '    绑定码一次性且 15 分钟内有效；可在工作站「添加主机」重新生成后再执行本命令。'
  }
  exit $code
} finally {
  Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}
`;
}
