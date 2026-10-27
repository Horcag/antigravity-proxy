#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="${SCRIPT_DIR}/dist"

echo "==> 1. Copying latest built dist from ${DIST_DIR} to production release paths..."
cp -r "${DIST_DIR}"/* /opt/antigravity-proxy/current/dist/
cp -r "${DIST_DIR}"/* /opt/antigravity-proxy/releases/20261027-native-credentials-only-v2/dist/

echo "==> 2. Switching entrypoint and drop-in to /opt/antigravity-proxy/current..."
sed -i 's|releases/20261027-native-credentials-only-v2|current|g' \
  /opt/arina-cliproxy/native-split-entrypoint.credentials-only-20261027-v2.mjs \
  /etc/systemd/system/antigravity-proxy.service.d/95-native-preservation.conf || true

echo "==> 3. Reloading systemd and restarting service..."
systemctl daemon-reload
systemctl restart antigravity-proxy.service

echo "==> DONE: antigravity-proxy.service is running with the latest code."
