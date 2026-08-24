#!/usr/bin/env bash
set -euo pipefail

config_path="${1:-}"
if [ -n "$config_path" ]; then
  node dist/cli.js serve --config "$config_path" &
else
  node dist/cli.js serve &
fi
pid="$!"
sleep 15
ps -o pid,rss,vsz,comm -p "$pid"
kill -TERM "$pid"
wait "$pid" 2>/dev/null || true
