#!/usr/bin/env bash
set -euo pipefail

sudo systemctl disable --now antigravity-proxy.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/antigravity-proxy.service
sudo systemctl daemon-reload
