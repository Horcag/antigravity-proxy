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
npm test
```

## Ubuntu 24.04 / WSL2 systemd

Install as an unprivileged service user with state under `/var/lib/antigravity-proxy` and secrets
under `/etc/antigravity-proxy/antigravity-proxy.env`:

```bash
cd /home/nikit/projects/antigravity-proxy
npm install
npm run build
sudo ./scripts/install-systemd.sh
```

Environment file:

```bash
sudo cat /etc/antigravity-proxy/antigravity-proxy.env
```

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
The service must be running because import goes through the admin API:

```bash
set -a
. /etc/antigravity-proxy/antigravity-proxy.env
set +a
node dist/cli.js accounts import \
  --url http://127.0.0.1:8045 \
  --admin-key "$AG_PROXY_ADMIN_API_KEY" \
  < ./cloud-accounts-export.json
shred -u ./cloud-accounts-export.json 2>/dev/null || rm -f ./cloud-accounts-export.json
```

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

```json
AG_PROXY_HOST=100.110.245.111
AG_PROXY_PORT=8045
AG_PROXY_API_KEY=replace-with-32-byte-random-secret
AG_PROXY_ADMIN_API_KEY=replace-with-different-32-byte-random-secret
```

Do not bind to `0.0.0.0` unless a host firewall restricts access.
