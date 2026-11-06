#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
DOMAIN="${TANDEM_RELAY_DOMAIN:-${1:-}}"

if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    if [[ "$key" == "TANDEM_RELAY_DOMAIN" && -z "$DOMAIN" ]]; then
      DOMAIN="${value%$'\r'}"
    fi
  done < "$ENV_FILE"
fi

if [[ -z "$DOMAIN" ]]; then
  printf '用法: TANDEM_RELAY_DOMAIN=relay.example.com %s\n' "$0" >&2
  exit 2
fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ || "$DOMAIN" == .* || "$DOMAIN" == *..* || "$DOMAIN" == *.-* || "$DOMAIN" == -* || "$DOMAIN" == *- ]]; then
  printf 'TANDEM_RELAY_DOMAIN 不是有效域名\n' >&2
  exit 2
fi

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    printf '未找到 Docker，且当前系统不是 Ubuntu/Debian（需要手动安装 Docker）。\n' >&2
    exit 1
  fi
  printf '正在安装 Docker…\n'
  as_root apt-get update
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl docker.io docker-compose-plugin
fi

if ! docker compose version >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    printf '正在安装 Docker Compose 插件…\n'
    as_root apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin
  fi
fi
if ! docker compose version >/dev/null 2>&1; then
  printf '需要 Docker Compose v2（docker compose）。\n' >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1; then
    as_root systemctl enable --now docker
  fi
fi
if ! docker info >/dev/null 2>&1; then
  printf 'Docker daemon 不可用。\n' >&2
  exit 1
fi

umask 077
printf 'TANDEM_RELAY_DOMAIN=%s\n' "$DOMAIN" > "$ENV_FILE"

printf '正在构建并启动 relay…\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build

printf '\n部署完成。\n'
printf 'Host 接入命令：tandem-host --relay wss://%s\n' "$DOMAIN"
printf '健康检查：https://%s/healthz\n' "$DOMAIN"
