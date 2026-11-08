// 远程端只读探测与安装脚本。所有脚本通过 ssh 的 stdin 交给 sh -s；
// 变量用单引号安全引用，不在本地拼 shell 命令。
import { q } from './exec.js';

const PATH_PREAMBLE = `
PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_BIN=$(find "$HOME/.nvm/versions/node" -maxdepth 3 -type f -name node 2>/dev/null | sort | tail -1)
  [ -n "$NODE_BIN" ] && PATH="$(dirname "$NODE_BIN"):$PATH"
fi
if [ -d "$HOME/.volta/bin" ]; then PATH="$HOME/.volta/bin:$PATH"; fi
if [ -d "$HOME/.fnm" ]; then
  FN=$(find "$HOME/.fnm" -maxdepth 5 -type f -name node 2>/dev/null | sort | tail -1)
  [ -n "$FN" ] && PATH="$(dirname "$FN"):$PATH"
fi
export PATH
`;

export function probeScript(): string {
  return `${PATH_PREAMBLE}
printf 'TANDEM_PLATFORM=%s\\n' "$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
printf 'TANDEM_ARCH=%s\\n' "$(uname -m 2>/dev/null)"
printf 'TANDEM_HOSTNAME=%s\\n' "$(hostname 2>/dev/null || uname -n 2>/dev/null)"
printf 'TANDEM_HOME=%s\\n' "$HOME"
if command -v node >/dev/null 2>&1; then
  printf 'TANDEM_NODE=%s\\n' "$(command -v node)"
  printf 'TANDEM_NODE_VERSION=%s\\n' "$(node -v 2>/dev/null)"
else
  printf 'TANDEM_NODE_MISSING=1\\n'
fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  printf 'TANDEM_SYSTEMD=1\\n'
else
  printf 'TANDEM_SYSTEMD=0\\n'
fi
if command -v crontab >/dev/null 2>&1; then printf 'TANDEM_CRON=1\\n'; else printf 'TANDEM_CRON=0\\n'; fi
if command -v tar >/dev/null 2>&1; then printf 'TANDEM_TAR=1\\n'; else printf 'TANDEM_TAR=0\\n'; fi
printf 'TANDEM_PROBE_OK=1\\n'
`;
}

export function prepareScript(token: string, hostId: string): string {
  return `set -e
mkdir -p "$HOME/.tandem-host"
rm -rf "$HOME/.tandem-host/app.new"
mkdir -p "$HOME/.tandem-host/app.new"
tar -xzf "$HOME/.tandem-host/pkg.tar.gz" -C "$HOME/.tandem-host/app.new"
rm -f "$HOME/.tandem-host/pkg.tar.gz"
if [ -d "$HOME/.tandem-host/app" ]; then mv "$HOME/.tandem-host/app" "$HOME/.tandem-host/app.old"; fi
mv "$HOME/.tandem-host/app.new" "$HOME/.tandem-host/app"
rm -rf "$HOME/.tandem-host/app.old"
mkdir -p "$HOME/.tandem"
CONFIG="$HOME/.tandem/config.json"
if [ -f "$CONFIG" ]; then
  TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$CONFIG" | head -1)
  if [ -z "$TOKEN" ]; then printf 'TANDEM_CONFIG_ERROR=missing token\\n'; exit 3; fi
else
  TOKEN=${q(token)}
  printf '{"hostId":"%s","token":"%s","resumeOnRestart":"auto"}\\n' ${q(hostId)} "$TOKEN" > "$CONFIG"
  chmod 600 "$CONFIG"
fi
printf 'TANDEM_REMOTE_TOKEN=%s\\n' "$TOKEN"
`;
}

export function verifyNodeScript(nodePath: string): string {
  return `set -e
NODE=${q(nodePath)}
[ -x "$NODE" ] || { printf 'TANDEM_NODE_ERROR=不可执行 %s\\n' "$NODE"; exit 4; }
V=$("$NODE" -v 2>/dev/null)
printf 'TANDEM_NODE=%s\\n' "$NODE"
printf 'TANDEM_NODE_VERSION=%s\\n' "$V"
`;
}

export interface InstallInput {
  nodePath: string;
  remotePort: number;
  listenHost: '127.0.0.1' | '0.0.0.0';
  home: string;
  id: string;
  service: 'systemd' | 'nohup';
}

function systemdUnit(input: InstallInput): string[] {
  return [
    '[Unit]',
    'Description=Tandem Host (managed by Tandem SSH onboarding)',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment=TANDEM_HOME=${input.home}/.tandem`,
    `ExecStart=${input.nodePath} ${input.home}/.tandem-host/app/server/dist/cli.js --port ${input.remotePort} --host ${input.listenHost}`,
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
  ];
}

export function installServiceScript(input: InstallInput): string {
  if (input.service === 'systemd') {
    const unit = pathJoin(input.home, '.config/systemd/user/tandem-host.service');
    const lines = systemdUnit(input).map(q).join(' ');
    return `set -e
mkdir -p "$(dirname ${q(unit)})"
printf '%s\\n' ${lines} > ${q(unit)}
systemctl --user daemon-reload
systemctl --user enable tandem-host.service >/dev/null 2>&1 || true
loginctl enable-linger "$USER" >/dev/null 2>&1 || printf 'TANDEM_LINGER_WARN=1\n'
systemctl --user restart tandem-host.service
printf 'TANDEM_SERVICE=systemd\\n'
`;
  }
  const dir = pathJoin(input.home, '.tandem-host');
  const cli = `${dir}/app/server/dist/cli.js`;
  const log = `${dir}/tandem-host.log`;
  const start = `#!/bin/sh
DIR=${q(dir)}
if [ -f "$DIR/pid" ] && kill -0 "$(cat "$DIR/pid")" 2>/dev/null; then exit 0; fi
nohup ${q(input.nodePath)} ${q(cli)} --port ${input.remotePort} --host ${input.listenHost} >> ${q(log)} 2>&1 &
echo $! > "$DIR/pid"
`;
  const stop = `#!/bin/sh
DIR=${q(dir)}
if [ -f "$DIR/pid" ]; then
  PID=$(cat "$DIR/pid")
  kill "$PID" 2>/dev/null || true
  sleep 1
  kill -9 "$PID" 2>/dev/null || true
  rm -f "$DIR/pid"
fi
`;
  const watch = `#!/bin/sh
${q(`${dir}/start.sh`)}
`;
  return `set -e
mkdir -p ${q(dir)}
printf '%s' ${q(start)} > ${q(`${dir}/start.sh`)}
printf '%s' ${q(stop)} > ${q(`${dir}/stop.sh`)}
printf '%s' ${q(watch)} > ${q(`${dir}/watch.sh`)}
chmod 700 ${q(`${dir}/start.sh`)} ${q(`${dir}/stop.sh`)} ${q(`${dir}/watch.sh`)}
${q(`${dir}/start.sh`)}
CRON_LINE="* * * * * ${dir}/watch.sh >/dev/null 2>&1 # tandem-ssh-${input.id}"
if command -v crontab >/dev/null 2>&1; then
  ( crontab -l 2>/dev/null | grep -v 'tandem-ssh-${input.id}' ; echo "$CRON_LINE" ) | crontab - 2>/dev/null || printf 'TANDEM_CRON_WARN=1\\n'
else
  printf 'TANDEM_CRON_WARN=1\\n'
fi
printf 'TANDEM_SERVICE=nohup\\n'
`;
}

export function restartScript(service: 'systemd' | 'nohup', home: string): string {
  if (service === 'systemd') {
    return `set -e
systemctl --user daemon-reload
systemctl --user restart tandem-host.service
printf 'TANDEM_SERVICE=systemd\\n'
`;
  }
  return `set -e
${q(`${home}/.tandem-host/stop.sh`)}
sleep 1
${q(`${home}/.tandem-host/start.sh`)}
printf 'TANDEM_SERVICE=nohup\\n'
`;
}

export function stopServiceScript(service: 'systemd' | 'nohup', home: string, id: string): string {
  if (service === 'systemd') {
    return `systemctl --user disable --now tandem-host.service >/dev/null 2>&1 || true
rm -f "$HOME/.config/systemd/user/tandem-host.service"
systemctl --user daemon-reload >/dev/null 2>&1 || true
printf 'TANDEM_STOPPED=1\\n'
`;
  }
  return `${q(`${home}/.tandem-host/stop.sh`)} >/dev/null 2>&1 || true
if command -v crontab >/dev/null 2>&1; then
  ( crontab -l 2>/dev/null | grep -v 'tandem-ssh-${id}' ) | crontab - >/dev/null 2>&1 || true
fi
printf 'TANDEM_STOPPED=1\\n'
`;
}

export function logsScript(service: 'systemd' | 'nohup', home: string, lines: number): string {
  const n = Math.max(10, Math.min(2000, Math.floor(lines)));
  if (service === 'systemd') {
    return `journalctl --user -u tandem-host.service -n ${n} --no-pager 2>/dev/null || tail -n ${n} ${q(`${home}/.tandem-host/tandem-host.log`)} 2>/dev/null || true`;
  }
  return `tail -n ${n} ${q(`${home}/.tandem-host/tandem-host.log`)} 2>/dev/null || true`;
}

export function uninstallScript(service: 'systemd' | 'nohup' | undefined, home: string, id: string, keepData: boolean): string {
  const stop = service ? stopServiceScript(service, home, id) : '';
  return `set +e
${stop}
rm -rf ${q(`${home}/.tandem-host`)}
${keepData ? '' : `rm -rf ${q(`${home}/.tandem`)}\n`}
printf 'TANDEM_UNINSTALLED=1\\n'
`;
}

function pathJoin(base: string, rest: string): string {
  return `${base.replace(/\/+$/, '')}/${rest.replace(/^\/+/, '')}`;
}
