#!/usr/bin/env bash
set -euo pipefail

port="${AG_PROXY_MEASURE_PORT:-18045}"
data_dir="$(mktemp -d -t antigravity-proxy-memory-XXXXXX)"
pid=""

cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid"
    wait "$pid" 2>/dev/null || true
  fi
  case "$data_dir" in
    /tmp/antigravity-proxy-memory-*) rm -rf "$data_dir" ;;
  esac
}
trap cleanup EXIT INT TERM

AG_PROXY_DATA_DIR="$data_dir" \
AG_PROXY_HOST=127.0.0.1 \
AG_PROXY_PORT="$port" \
AG_PROXY_API_KEY=memory-measure-proxy-key \
AG_PROXY_ADMIN_API_KEY=memory-measure-admin-key \
  node dist/cli.js serve >/dev/null 2>&1 &
pid="$!"

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

sleep 5
ps -o pid,rss,vsz,%mem,etime,comm -p "$pid"
