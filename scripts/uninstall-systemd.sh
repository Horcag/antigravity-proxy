#!/usr/bin/env bash
set -euo pipefail

sudo systemctl disable --now antigravity-proxy.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/antigravity-proxy.service
sudo rm -f /usr/local/sbin/antigravity-proxy-import
sudo rm -f /etc/sudoers.d/antigravity-proxy-import
sudo systemctl daemon-reload
