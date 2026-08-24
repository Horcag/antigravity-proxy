#!/usr/bin/env bash
set -euo pipefail

install_dir="${INSTALL_DIR:-/opt/antigravity-proxy}"
data_dir="${DATA_DIR:-/var/lib/antigravity-proxy}"
env_file="${ENV_FILE:-/etc/antigravity-proxy/antigravity-proxy.env}"
user_name="${SERVICE_USER:-antigravity-proxy}"
import_sudo_user="${IMPORT_SUDO_USER:-}"

if [ ! -x /usr/bin/node ]; then
  echo "Node.js 22 must be installed system-wide at /usr/bin/node." >&2
  exit 1
fi

sudo useradd --system --home-dir "$data_dir" --shell /usr/sbin/nologin "$user_name" 2>/dev/null || true
sudo install -d -m 0755 "$install_dir"
sudo install -d -m 0700 -o "$user_name" -g "$user_name" "$data_dir"
sudo install -d -m 0750 -o root -g "$user_name" /etc/antigravity-proxy

if [ ! -f "$env_file" ]; then
  proxy_key="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
  admin_key="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
  sudo tee "$env_file" >/dev/null <<EOF
AG_PROXY_HOST=127.0.0.1
AG_PROXY_PORT=8045
AG_PROXY_DATA_DIR=$data_dir
AG_PROXY_API_KEY=$proxy_key
AG_PROXY_ADMIN_API_KEY=$admin_key
# Fill these before importing accounts so refresh tokens can be renewed.
AG_PROXY_OAUTH_CLIENT_ID=
AG_PROXY_OAUTH_CLIENT_SECRET=
EOF
  sudo chown root:"$user_name" "$env_file"
  sudo chmod 0640 "$env_file"
fi

sudo cp -R dist package.json package-lock.json node_modules "$install_dir"/
sudo npm --prefix "$install_dir" prune --omit=dev --ignore-scripts
sudo chown -R root:root "$install_dir"
sudo install -m 0755 scripts/import-accounts-stdin.sh /usr/local/sbin/antigravity-proxy-import
if [ -n "$import_sudo_user" ]; then
  if ! id "$import_sudo_user" >/dev/null 2>&1; then
    echo "IMPORT_SUDO_USER does not exist: $import_sudo_user" >&2
    exit 1
  fi
  sudo tee /etc/sudoers.d/antigravity-proxy-import >/dev/null <<EOF
$import_sudo_user ALL=(root) NOPASSWD: /usr/local/sbin/antigravity-proxy-import
EOF
  sudo chmod 0440 /etc/sudoers.d/antigravity-proxy-import
  sudo visudo -cf /etc/sudoers.d/antigravity-proxy-import >/dev/null
fi

sudo tee /etc/systemd/system/antigravity-proxy.service >/dev/null <<EOF
[Unit]
Description=Antigravity Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$user_name
Group=$user_name
EnvironmentFile=$env_file
WorkingDirectory=$install_dir
ExecStart=/usr/bin/node $install_dir/dist/cli.js serve
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=$data_dir
MemoryHigh=256M
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now antigravity-proxy.service
systemctl status antigravity-proxy.service --no-pager
