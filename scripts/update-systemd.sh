#!/usr/bin/env bash
set -euo pipefail

[ "$#" -eq 0 ] || { printf '%s\n' 'Usage: update-systemd.sh' >&2; exit 1; }
exec sudo -n /usr/local/sbin/antigravity-proxy-update
