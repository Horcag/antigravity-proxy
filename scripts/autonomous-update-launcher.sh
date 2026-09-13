#!/bin/bash
set -euo pipefail

[ "$#" -eq 0 ] || { printf '%s\n' 'Autonomous updater accepts no arguments' >&2; exit 1; }
[ "${EUID:-$(id -u)}" -eq 0 ] || { printf '%s\n' 'Autonomous updater must run as root' >&2; exit 1; }
exec /usr/bin/flock -n -o /run/lock/antigravity-proxy-autonomous-update.lock \
  /usr/local/libexec/antigravity-proxy-updater/update
