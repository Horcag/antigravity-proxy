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
- `GET /admin/accounts/preferred`
- `PUT /admin/accounts/preferred` with `{ "account_id": "..." }`
- `DELETE /admin/accounts/preferred`
- `POST /admin/accounts/import`
- `GET /admin/accounts/export`
- `DELETE /admin/accounts/:accountId`
- `POST /admin/accounts/reload`
- `GET /admin/accounts/quota-diagnostics`
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

## Native AGY CONNECT requests

The CONNECT gateway relays Antigravity's native CloudCode protocol. It substitutes
OAuth credentials in headers; it does not translate native requests through the
API-compatible HTTP handlers. TLS is terminated and re-established by the gateway.

Native request bodies retain their original bytes, including compression, model,
project, session metadata, signatures and unknown fields. Origin paths and queries
are preserved. End-to-end header values, including `x-goog-session-id` and
`x-goog-user-project`, survive retries. Changes are limited to credentials and the
HTTP transport fields needed for forwarding, including authority/Host representation,
Content-Length and hop-by-hop header removal.

Account rotation does not change the requested model or repair the project context.
If another credential is not entitled to that original context, the gateway returns
the upstream failure instead of silently rewriting the request.

## Antigravity IDE / Language Server (WSL mode)

When Antigravity runs in WSL mode, the desktop app launches `language_server` directly
under `~/.antigravity-server/bin/<version>/language_server`.

To route IDE traffic through the proxy and enable transparent account rotation:

```bash
# Check status of installed server versions
antigravity-proxy ide status
# Or use the helper script:
./scripts/patch-antigravity-server.sh status

# Patch all installed language_server binaries with managed transparent wrappers
antigravity-proxy ide patch
# Or:
./scripts/patch-antigravity-server.sh patch

# Revert wrappers back to native binaries
antigravity-proxy ide unpatch
```

The wrapper routes CloudCode calls to `http://127.0.0.1:8045` and trusts the managed
local CA (`agy-trust.pem`) while keeping Windows `host_bridge_url` on `127.0.0.1` direct
via `NO_PROXY`. Native OAuth token exchange and Google sign-in also bypass the
rotation proxy, and existing caller bypasses are preserved. The system service
restarts after unexpected clean exits as well as failures; `systemctl stop` still
stops it explicitly.

## Build

```bash
npm install
npm run build
npm run type-check
npm run lint
npm test
```

## Ubuntu 24.04 / WSL2 systemd releases

The system service runs as the unprivileged `antigravity-proxy` user. Each deployment creates an
immutable release in `/opt/antigravity-proxy/releases/<release-id>` and atomically selects it via
`/opt/antigravity-proxy/current`. Persistent state stays in `/var/lib/antigravity-proxy`; the
restricted environment file stays in `/etc/antigravity-proxy/antigravity-proxy.env` and is never
rewritten during an update.

The installer keeps `/etc/antigravity-proxy` owned by `root:antigravity-proxy` with mode `0750`,
and its environment file owned by the same pair with mode `0640`. The service account can read the
file through its group, but cannot replace the directory or file. Set `SERVICE_GROUP` if the
dedicated service account uses a different group.

Build before installing. The default installer copies the Node executable used for the build into
each release, so it does not depend on `/usr/bin/node`. To use a managed system Node instead, set
`BUNDLE_NODE=0 NODE_BINARY=/absolute/path/to/node`; the installer validates that path first.

```bash
cd /home/nikit/projects/antigravity-proxy
npm ci
npm run build
RELEASE_OPERATOR="$(id -un)" sudo -E ./scripts/install-systemd.sh install
```

The installer stages release dependencies with lifecycle scripts enabled under `RELEASE_OPERATOR`
(normally the invoking non-root user), then makes the immutable release root-owned. It never runs
package lifecycle scripts as root. Before moving `current`, it uses that release's selected Node
runtime and `node_modules` as the service user to instantiate an in-memory `better-sqlite3`
database and exercise the built CLI. `RELEASE_OPERATOR` is required for a live install; it is
intentionally unnecessary for `ROOT_PREFIX` test mode.

The first install creates separate proxy and admin keys without printing them. Use `sudoedit
/etc/antigravity-proxy/antigravity-proxy.env` to add the authorized OAuth client ID and secret;
never paste or print that file in a terminal transcript. Existing keys, OAuth settings,
`accounts.db`, `accounts.db-wal`, `accounts.db-shm`, and `.master-key` are preserved.

### Update, rollback, and migration

`./apply-fix.sh` delegates to the configured system updater, which builds the committed
HEAD in isolated staging and publishes an immutable release with smoke checks and rollback.
Commit intended changes before running it. Do not copy `dist` into `current` or an
existing rollback release: that destroys the correspondence between source and running code.

Choose a release ID that identifies the source revision and update atomically. `current` and
`previous` are sibling links under `/opt/antigravity-proxy`, both resolving into `releases/`.
A failed post-start smoke check restores both links and the system unit to their exact pre-update
targets, then restarts the prior release and runs the same smoke check against it. Unit generation
selects the executable layout in the release being activated, so legacy immutable releases with
`runtime/node` remain rollback-compatible with newer `bin/node` releases. Release
transactions (install, update, migration, recovery, and rollback) use one non-blocking,
root-owned lock; a concurrent transaction fails without changing topology.

```bash
RELEASE_OPERATOR="$(id -un)" RELEASE_ID=20260904-eb39352 sudo -E ./scripts/install-systemd.sh update
sudo ./scripts/rollback-systemd.sh                 # recorded previous release
sudo ./scripts/rollback-systemd.sh 20260904-eb39352 # explicit release
```

To migrate a legacy user unit, the installer first validates and stages the complete immutable
release. Only then does it stop the exact configured legacy unit for the state-copy/cutover window,
copy the environment, SQLite database (including WAL/SHM), key material, and `config.json` as one
migration set, then start and smoke-check the system unit. A migration target whose state directory
contains any member of that set fails closed before copying; use the separately validated `update`
path for an already-migrated target.
If the cutover or legacy-unit disable fails, the script restores the prior service topology or
leaves a precise failure; it never reports success after a failed cutover. Run it only while the
legacy user's systemd runtime is available:

```bash
LEGACY_SERVICE_USER=nikit \
LEGACY_DATA_DIR=/home/nikit/.local/share/antigravity-proxy \
LEGACY_ENV_FILE=/home/nikit/.config/antigravity-proxy/antigravity-proxy.env \
LEGACY_USER_UNIT=antigravity-proxy.service \
RELEASE_ID=20260904-eb39352 \
RELEASE_OPERATOR="$(id -un)" \
sudo -E ./scripts/install-systemd.sh migrate
```

`LEGACY_ENV_FILE` is required only when the restricted system environment file does not already
exist; it is copied as a file and never echoed.

For deterministic, non-live inspection or tests, use `DRY_RUN=1` (no files or secrets are
created) or set `ROOT_PREFIX=/tmp/antigravity-proxy-root RELEASE_TEST_MODE=1`.
`RELEASE_TEST_MODE=1` rejects a missing, relative, root, or root-resolving `ROOT_PREFIX`
before it writes anything. Never point `ROOT_PREFIX` at a live filesystem root.

### Post-cutover verification

The installer checks that the exact systemd `MainPID` owns the configured listener, `/health`,
unauthenticated admin rejection, and enabled/active state under the dedicated service user. Re-run
the same checks after a manual rollback:

```bash
systemctl is-enabled --quiet antigravity-proxy.service
systemctl is-active --quiet antigravity-proxy.service
ss -ltn '( sport = :8045 )'                         # expect 127.0.0.1:8045 by default
curl --fail --silent --show-error http://127.0.0.1:8045/health
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:8045/admin/status
# expect 401 or 403 without an admin credential
journalctl -u antigravity-proxy.service -n 100 --no-pager
```

The unit enables filesystem, device, privilege, namespace, process, and kernel hardening while
leaving outbound IPv4/IPv6 HTTPS available for OAuth and upstream requests. It deliberately omits
`MemoryDenyWriteExecute`, restrictive syscall filters, and network-deny settings because they can
break Node JIT/native addons or required outbound HTTPS.

Uninstall only the system unit and helper (not releases, state, or environment):

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

Inspect the cached quota and current account/model availability without triggering a refresh. This
admin-key-only read returns a request-local ordinal label (for example, `account-1`) for each active
account, freshness, advertised public/physical model IDs, remaining percentages, reset times, and
temporary blocks. Labels are not stable across requests and cannot identify an account. The response
never returns account IDs, tokens, personal account metadata, proxy URLs, project/session IDs, raw
quota payloads, or configuration values.

```bash
antigravity-proxy accounts quota-diagnostics
```

Read or manage the durable proxy-only preferred account with the separate admin key. The response
contains only the account id, provider, display metadata, and status; it never includes email or
token fields. Setting an unknown account id returns `404` without changing the saved config.

```bash
antigravity-proxy accounts preferred get
antigravity-proxy accounts preferred set --id <account-id>
antigravity-proxy accounts preferred clear
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

## Projects, application ports and dashboard

`proxy.projects` accepts separate application credentials while preserving the original
`proxy.api_key`. Each project has an `id`, `name`, `api_key`, `enabled` flag and optional
`model_mapping`. Disabled project keys reject authentication. Project keys never authorize
administration. Exact aliases take precedence over wildcard mappings; project mappings
apply only within that request. Catalogs advertise explicit aliases only when their
upstream target is available.

In the separated deployment, the primary port is 8317 for native Antigravity CONNECT,
administration and `/dashboard`. Set `proxy.compatibility_ports` to `[8045]` for the
existing `/v1/` and `/v1beta/` application APIs on loopback. They retain the same authentication
and streaming behavior, but reject administration, dashboard, upgrades and CONNECT.

The dashboard uses the separate admin key, held in browser memory until logout/reload.
It shows account/quota availability, project activity and the latest 500 request outcomes
from the current service run. It does not store prompts, responses or credentials.
HTTP and native gRPC failures are counted separately from successful HTTP 200 transport.

The offline `migration import-easycli --stdin` command accepts a validated version-1 JSON
payload with `projects`, raw Antigravity `accounts`, and `model_mapping`. Every account
requires an explicit `migration_status`: `active`, `blocked`, or `disabled`. This makes
source-app shutdown distinct from upstream bans. OAuth tokens are encrypted in the
existing account database; unsupported Codex credentials are counted and skipped.
Back up the destination configuration and encrypted database before migration: configuration
and account updates use separate persistence operations. Do not store the payload in Git.

Native login/setup operations preserve the caller's original OAuth and project and work
without a generation pool. Native audio uses an HTTP/2 duplex connection for the exact
Antigravity audio RPC, with one account lease held for the stream and no replay. Explicit
ToS suspension stops the request and excludes that credential; it does not trigger a
cross-account retry. These safeguards do not establish immunity from provider restrictions.
