#!/usr/bin/env bash
set -euo pipefail

service_user="${SERVICE_USER:-antigravity-proxy}"
install_dir="${INSTALL_DIR:-/opt/antigravity-proxy}"
env_file="${ENV_FILE:-/etc/antigravity-proxy/antigravity-proxy.env}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this importer as root so it can enter the restricted service account." >&2
  exit 1
fi

exec runuser -u "$service_user" -- sh -c '
  set -a
  . "$1"
  set +a
  exec /usr/bin/node "$2/dist/cli.js" accounts import \
    --url "http://${AG_PROXY_HOST}:${AG_PROXY_PORT}" \
    --admin-key "$AG_PROXY_ADMIN_API_KEY"
' sh "$env_file" "$install_dir"
