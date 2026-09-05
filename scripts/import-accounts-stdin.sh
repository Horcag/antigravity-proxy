#!/usr/bin/env bash
set -euo pipefail

service_user="${SERVICE_USER:-antigravity-proxy}"
install_root="${INSTALL_ROOT:-${INSTALL_DIR:-/opt/antigravity-proxy}}"
env_file="${ENV_FILE:-/etc/antigravity-proxy/antigravity-proxy.env}"
node_binary="${NODE_BINARY:-$install_root/current/bin/node}"

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Run this importer as root so it can enter the restricted service account.' >&2
  exit 1
fi
if [ ! -r "$env_file" ]; then
  printf '%s\n' 'The restricted environment file is unavailable.' >&2
  exit 1
fi
if [ ! -x "$node_binary" ]; then
  printf '%s\n' 'The configured Node runtime is unavailable.' >&2
  exit 1
fi

# The inner shell intentionally expands only values loaded from the restricted environment file.
# shellcheck disable=SC2016
exec runuser -u "$service_user" -- sh -c '
  set -a
  . "$1"
  set +a
  exec "$2" "$3/current/dist/cli.js" accounts import \
    --url "http://${AG_PROXY_HOST}:${AG_PROXY_PORT}" \
    --admin-key "$AG_PROXY_ADMIN_API_KEY"
' sh "$env_file" "$node_binary" "$install_root"
