#!/usr/bin/env bash
set -euo pipefail

install_dir="${INSTALL_DIR:-/opt/antigravity-proxy}"
data_dir="${DATA_DIR:-/var/lib/antigravity-proxy}"
env_file="${ENV_FILE:-/etc/antigravity-proxy/antigravity-proxy.env}"
user_name="${SERVICE_USER:-antigravity-proxy}"

sudo useradd --system --home-dir "$data_dir" --shell /usr/sbin/nologin "$user_name" 2>/dev/null || true
sudo install -d -m 0755 "$install_dir"
sudo install -d -m 0700 -o "$user_name" -g "$user_name" "$data_dir"
sudo install -d -m 0750 /etc/antigravity-proxy

if [ ! -f "$env_file" ]; then
  proxy_key="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
  admin_key="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
sudo tee "$env_file" >/dev/null <<EOF
AG_PROXY_HOST=127.0.0.1
AG_PROXY_PORT=8045
AG_PROXY_DATA_DIR=$data_dir
AG_PROXY_API_KEY=$proxy_key
AG_PROXY_ADMIN_API_KEY=$admin_key
EOF
  sudo chown root:"$user_name" "$env_file"
  sudo chmod 0640 "$env_file"
fi

sudo cp -R dist package.json node_modules "$install_dir"/
sudo chown -R root:root "$install_dir"

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
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$data_dir

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now antigravity-proxy.service
systemctl status antigravity-proxy.service --no-pager
