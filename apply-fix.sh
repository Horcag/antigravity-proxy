#!/usr/bin/env bash
set -euo pipefail

echo "==> 1. Copying latest built dist to active release path..."
cp -r /opt/antigravity-proxy/current/dist/* /opt/antigravity-proxy/releases/20261027-native-credentials-only-v2/dist/

echo "==> 2. Switching entrypoint and drop-in to /opt/antigravity-proxy/current..."
sed -i 's|releases/20261027-native-credentials-only-v2|current|g' \
  /opt/arina-cliproxy/native-split-entrypoint.credentials-only-20261027-v2.mjs \
  /etc/systemd/system/antigravity-proxy.service.d/95-native-preservation.conf || true

echo "==> 3. Reloading systemd and restarting service..."
systemctl daemon-reload
systemctl restart antigravity-proxy.service

echo "==> DONE: antigravity-proxy.service is running with the latest code."
