# antigravity-proxy

Headless local proxy with account import, encrypted token storage, admin API, and account rotation
when an upstream account hits `429`, `RESOURCE_EXHAUSTED`, or quota-exhausted responses.

This repo is intentionally independent of Antigravity, Electron, OpenClaw, WSL session state, and
the original application database. Existing account exports are imported through stdin.

## Status

Current surface:

- `GET /health`
- `GET /admin/status`
- `GET /admin/accounts`
- `POST /admin/accounts/import`
- `GET /admin/accounts/export`
- `DELETE /admin/accounts/:accountId`
- `POST /admin/accounts/reload`
- `GET /v1/models`
- `POST /v1/chat/completions`
- OpenAI Responses, Anthropic-compatible, Gemini, streaming, image/audio routes copied from the
  extracted proxy core
- `POST /v1beta/models/:model:generateContent`
- Separate proxy/admin bearer keys
- Default bind: `127.0.0.1:8045`
- Encrypted SQLite state: `accounts.db` with AES-GCM encrypted token/quota fields
- Master key from `AG_PROXY_MASTER_KEY` or a strict-permission `.master-key` file
- Graceful `SIGINT`/`SIGTERM`
- Rotation tests for `429`, `RESOURCE_EXHAUSTED`, quota exhaustion, and retry exclusions

## Build

```bash
npm install
npm run build
npm run type-check
npm run lint
npm test
```

## Ubuntu 24.04 / WSL2 systemd

Install as an unprivileged service user with state under `/var/lib/antigravity-proxy` and secrets
under `/etc/antigravity-proxy/antigravity-proxy.env`:

```bash
cd /home/nikit/projects/antigravity-proxy
npm install
npm run build
sudo env IMPORT_SUDO_USER="$USER" ./scripts/install-systemd.sh
```

Environment file:

```bash
sudo cat /etc/antigravity-proxy/antigravity-proxy.env
```

Before importing accounts, set `AG_PROXY_OAUTH_CLIENT_ID` and
`AG_PROXY_OAUTH_CLIENT_SECRET` in that file from an OAuth client you are authorized to use. These
values are intentionally not committed to this repository; without them, expired access tokens
cannot be renewed from refresh tokens.

State directory:

```bash
sudo ls -la /var/lib/antigravity-proxy
sudo ls -la /var/lib/antigravity-proxy/accounts.db /var/lib/antigravity-proxy/.master-key
```

Status/logs:

```bash
systemctl status antigravity-proxy.service --no-pager
journalctl -u antigravity-proxy.service -n 100 --no-pager
```

Uninstall service only:

```bash
sudo ./scripts/uninstall-systemd.sh
```

## Secure Migration

Export accounts from Antigravity Manager with tokens, then import without committing the export.
The service must be running because import goes through the admin API. The installed helper reads
the export from stdin and runs under the restricted service account:

```bash
sudo /usr/local/sbin/antigravity-proxy-import < ./cloud-accounts-export.json
shred -u ./cloud-accounts-export.json 2>/dev/null || rm -f ./cloud-accounts-export.json
```

For a zero-file cutover, run these commands from the old AntigravityManager checkout and pipe the
exporter directly over SSH:

```powershell
npm run package
npm run --silent export:cloud-accounts:tokens:stdout |
  ssh your-wsl-host 'sudo -n /usr/local/sbin/antigravity-proxy-import'
```

The exporter launches its packaged Electron main process without a window so the original
safeStorage/DPAPI key remains available. Do not insert `tee` or another file-writing command into
the pipeline.

The import command validates the export schema and stores tokens encrypted. It does not keep the
plaintext JSON.

## API

Proxy requests use `AG_PROXY_API_KEY`:

```bash
curl http://127.0.0.1:8045/v1/models \
  -H "Authorization: Bearer $AG_PROXY_API_KEY"
```

Admin requests use `AG_PROXY_ADMIN_API_KEY`:

```bash
curl http://127.0.0.1:8045/admin/status \
  -H "Authorization: Bearer $AG_PROXY_ADMIN_API_KEY"
```

Refresh the cached account quota/model catalog without exporting tokens:

```bash
antigravity-proxy accounts refresh-quota --force
```

Headless deployments can set `AG_PROXY_UPSTREAM_VERSION` to the verified installed
Antigravity client version, then restart the service. Google filters the available
model catalog by client version; refreshing quotas with an outdated version can
still return an older catalog. Keep this deployment setting aligned with the client
used to validate upstream access. It does not create model aliases or bypass
account capability checks.

OpenAI-compatible request:

```bash
curl http://127.0.0.1:8045/v1/chat/completions \
  -H "Authorization: Bearer $AG_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"ping"}]}'
```

## Tailscale Binding

Default bind is loopback. To expose on a Tailscale address, set the bind host explicitly and keep
both API keys secret:

```bash
AG_PROXY_HOST=100.110.245.111
AG_PROXY_PORT=8045
AG_PROXY_API_KEY=replace-with-32-byte-random-secret
AG_PROXY_ADMIN_API_KEY=replace-with-different-32-byte-random-secret
```

Do not bind to `0.0.0.0` unless a host firewall restricts access.
Wildcard binds (`0.0.0.0` and `::`) are rejected. Other non-Tailscale addresses are rejected unless
`AG_PROXY_ALLOW_NON_TAILSCALE_BIND=true` is set explicitly. For the WSL2 deployment, keeping the
service on `127.0.0.1` and publishing it through Windows Tailscale forwarding/firewall is the
recommended path.
