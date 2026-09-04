# ADR 0001: Two-Plane Account Ownership Architecture

- **Status:** Accepted
- **Date:** 2026-09-04
- **Deciders:** Antigravity Architecture & Core Team
- **Consulted:** Antigravity Manager maintainers, Proxy runtime team, Security & Operations
- **Informed:** Client integrators (OpenClaw, Natively, CLI tooling)

---

## 1. Context

Historically, Antigravity Manager coupled developer-facing desktop management (account authentication, visual profile switching, Electron GUI) with an embedded HTTP proxy service routing local AI requests to upstream cloud providers. As autonomous agent workflows (such as OpenClaw, Natively, and continuous background CLIs) expanded, this co-located architecture introduced significant operational and architectural friction:

1. **Divergent Usage Models:**
   - **Interactive Developer Workflows:** Human engineers interacting with the Antigravity IDE, classic Antigravity desktop tools, and the native `agy` CLI expect explicit, scoped account selection. A developer actively switching accounts in their IDE wants predictable identity context without unintended background rotations.
   - **High-Throughput Automated API Workflows:** Automated agents and tools issuing concurrent requests require resilient load balancing, quota tracking across multiple accounts, automatic failover upon receiving `429 Too Many Requests` or `RESOURCE_EXHAUSTED`, cooldown management, sticky sessions, and proactive access token refresh.

2. **Cross-Boundary Fragility (Windows / WSL2):**
   Antigravity Manager typically runs as a Windows desktop application relying on Electron and Windows Data Protection API (DPAPI) `safeStorage` to encrypt secrets. The headless proxy runtime (`antigravity-proxy`) runs in Linux/WSL2 environments as an unprivileged, continuous `systemd` daemon. Attempting to share database files, inter-process communication (IPC), or encryption contexts across this boundary leads to process coupling, file locking errors, and permission hazards.

3. **Concurrency and Scheduling Contention:**
   When both the Manager application and the proxy runtime attempt to manage the same accounts or contend for loopback port `127.0.0.1:8045`, port conflicts, race conditions in token refreshes, and database locking errors (`SQLITE_BUSY`) inevitably arise.

To establish stability, clear failure domains, and strict security isolation, we must define the architectural boundary between Antigravity Manager and the standalone `antigravity-proxy` daemon.

---

## 2. Decision

We establish a **Two-Plane Account Ownership Architecture** that strictly decouples interactive desktop client state from the automated proxy request pool into two independent execution planes.

```
+-------------------------------------------------------------------------------+
|                   PLANE A: Manager-Managed Interactive Clients                 |
|                                                                               |
|   +---------------------+   +-----------------------+   +-----------------+   |
|   |   Antigravity IDE   |   |  Classic Antigravity  |   |  Native agy CLI |   |
|   +----------+----------+   +-----------+-----------+   +--------+--------+   |
|              |                          |                        |            |
|              +--------------------------+------------------------+            |
|                                         |                                     |
|                                         v                                     |
|                     +---------------------------------------+                 |
|                     |          Antigravity Manager          |                 |
|                     |   - Scoped Account Selectors:         |                 |
|                     |       * active_cloud_account.ide      |                 |
|                     |       * active_cloud_account.classic  |                 |
|                     |       * active_cloud_account.agy      |                 |
|                     |   - Electron GUI & Auth Management    |                 |
|                     |   - Embedded Proxy: DISABLED          |                 |
|                     |   - Account Export Producer (JSON)    |                 |
|                     +-------------------+-------------------+                 |
+-----------------------------------------|-------------------------------------+
                                          |
                                          | Idempotent One-Way Export / Import
                                          | (via stdin / admin API / CLI)
                                          v
+-------------------------------------------------------------------------------+
|                   PLANE B: Proxy-Managed API Request Pool                     |
|                                                                               |
|   +---------------------+   +-----------------------+   +-----------------+   |
|   |  Natively (Agents)  |   |   OpenClaw Runtime    |   | Compatible CLIs |   |
|   +----------+----------+   +-----------+-----------+   +--------+--------+   |
|              |                          |                        |            |
|              +--------------------------+------------------------+            |
|                                         |                                     |
|                         HTTP traffic to 127.0.0.1:8045                        |
|                                         v                                     |
|                     +---------------------------------------+                 |
|                     |       Standalone antigravity-proxy    |                 |
|                     |   - Sole Runtime Source of Truth:     |                 |
|                     |       * Encrypted accounts.db (AES)   |                 |
|                     |       * Token hydration & auto-refresh|                 |
|                     |       * Quota polling (every 10m)     |                 |
|                     |       * Per-account model discovery   |                 |
|                     |       * Sticky sessions & cooldowns   |                 |
|                     |       * Failover & retry policies     |                 |
|                     |       * Proxy-only account pinning    |                 |
|                     |   - Distinct Admin API & Proxy Keys   |                 |
|                     |   - Optional Direct OAuth Ingestion   |                 |
|                     +---------------------------------------+                 |
+-------------------------------------------------------------------------------+
```

### 2.1. Plane A: Manager-Managed Interactive Clients

1. **Ownership and Scope:**
   Antigravity Manager remains the exclusive owner of interactive account selection, manual switching, and user profiles for developer-facing interactive tools: Antigravity IDE, classic Antigravity, and the native `agy` CLI.
2. **Distinct Selectors:**
   Manager persists and manages distinct, granular selectors in its internal database:
   - `active_cloud_account.ide` (controls account active within IDE sessions)
   - `active_cloud_account.classic` (controls classic Antigravity tooling)
   - `active_cloud_account.agy` (controls native CLI operations)
3. **Immutability from Proxy:**
   The standalone proxy must **never** inspect, mutate, or synchronize these selectors, must not patch IDE/CLI configuration files, and must never invoke global Manager account switches.
4. **Proxy Component Disabled:**
   The embedded proxy within Antigravity Manager remains permanently disabled. Manager shall never bind to loopback port `127.0.0.1:8045` nor act as an API request scheduler or load balancer. Manager functions solely as an interactive desktop GUI and an account-export producer.

### 2.2. Plane B: Proxy-Managed API Request Pool

1. **Sole Runtime Source of Truth:**
   The standalone proxy daemon (`antigravity-proxy`) is the sole runtime authority and single writer for all HTTP/API traffic originating from clients explicitly configured to use `http://127.0.0.1:8045` (e.g., Natively, OpenClaw, background automation scripts, and compatible API clients).
2. **Autonomous Pool Lifecycle:**
   Within Plane B, the standalone proxy independently and autonomously owns:
   - **Account Storage:** Encrypted local SQLite persistence (`accounts.db`) protected by an independent master key.
   - **Token Refresh:** Automated proactive and reactive access token renewal using OAuth refresh tokens, completely isolated from Manager.
   - **Quota and Model Discovery:** Periodic quota catalog polling (every 10 minutes and on-demand), maintaining dynamic per-account model availability state.
   - **Traffic Scheduling:** Dynamic candidate selection, sticky session affinity, rate limit tracking, cooldowns on `429` / `RESOURCE_EXHAUSTED` responses (e.g., 5-minute rate limit cooldown, 30-minute forbidden cooldown), transparent account failover, and retry policies.
   - **Proxy-Only Account Pinning:** Manual account preferred pinning (`setPreferredAccount`) managed exclusively through the proxy admin API or CLI, scoped entirely to Plane B without affecting Plane A selectors.

### 2.3. Architectural Boundary and Ingestion Contract

1. **Bootstrap / Update, Not Ownership Transfer:**
   Importing credentials from Manager into the standalone proxy is an explicit credential bootstrap or pool update operation. It does not transfer ownership of interactive clients to the proxy, nor does it establish continuous bidirectional linkage.
2. **No Shared Mutable SQLite:**
   There is **no shared SQLite database** between Antigravity Manager and `antigravity-proxy`. Each system maintains its own isolated database file, schema, locking lifecycle, and encryption mechanism.
3. **No Bidirectional Synchronization:**
   There is **no bidirectional synchronization** between Manager's database and the proxy database. State updates within the proxy (e.g., rate-limit lockouts, token refreshes, quota snapshots) remain strictly internal to the proxy and are not synced back to Manager.
4. **Supported Ingestion Mechanisms:**
   - **Explicit Idempotent Import:** Account ingestion occurs via an explicit, authenticated administrative interface (`POST /admin/accounts/import` or CLI `antigravity-proxy accounts import`). The import accepts standard export payloads, updates existing accounts idempotently based on account email/ID, and triggers in-memory pool reloading.
   - **Direct OAuth Addition:** Standalone proxy supports direct OAuth authorization via its admin endpoints (`/admin/oauth/url`, `/admin/oauth/exchange`) and CLI, bypassing Manager entirely when configured.
5. **Decoupled Windows / WSL Bridge:**
   Any automatic Windows Manager bridge requiring user-session DPAPI or Electron runtimes is optional, strictly external, and completely separate. The WSL2 `systemd` proxy service must never attempt to read Windows Manager internal files, process memory, or master keys (`.mk`) directly.
6. **Decoupled Administration:**
   Antigravity Manager GUI buttons are not required or used to manage proxy rotation, pooling, or pinning. Administrative operations (account import, export, removal, reload, quota refresh, and pinning) are performed exclusively via the authenticated admin API or CLI.
7. **Authentication Separation & Network Contract:**
   - Client API traffic to `127.0.0.1:8045` authenticates via bearer token using `AG_PROXY_API_KEY`.
   - Administrative traffic to `/admin/*` requires a distinct bearer token `AG_PROXY_ADMIN_API_KEY`.
   - Secrets and credentials must never be printed to stdout/stderr, exposed in logs, or committed to version control.

---

## 3. Comparison with Alternatives

We evaluated three alternative integration strategies against the chosen Two-Plane Single-Writer Import boundary.

| Evaluation Criteria | Alternative 1: Shared Mutable SQLite | Alternative 2: Bidirectional Sync Engine | Alternative 3: Live DPAPI / Electron Bridge | Chosen Decision: Two-Plane Independent Ownership |
| :--- | :--- | :--- | :--- | :--- |
| **Data Integrity & Concurrency** | **Unacceptable:** Cross-OS (Windows/WSL) SQLite file locking over DrvFS/9P causes frequent `SQLITE_BUSY` crashes and database corruption. | **High Risk:** Race conditions on simultaneous token refreshes cause OAuth token invalidation; complex split-brain conflict resolution. | **Fragile:** Proxy requests block on desktop Electron main thread IPC or UI events. | **Excellent:** Each plane is a single-writer with local file locking; zero cross-process database contention. |
| **Fault Isolation & Resilience** | **Poor:** A crash or lockup in Manager corrupts or blocks the entire proxy API service. | **Poor:** Synchronization failures or network disconnects cascade across both systems. | **Unacceptable:** Proxy halts whenever the user logs out, locks desktop, or closes Electron Manager. | **Complete:** Proxy daemon runs 24/7 as an autonomous systemd service; unaffected by Manager crashes, reboots, or updates. |
| **Security Boundary** | **High Hazard:** Systemd service requires direct write permissions to user desktop application directory. | **Moderate:** Requires persistent bi-directional channel with credential access in both directions. | **Severe Hazard:** System daemon must elevate into interactive desktop session and access Windows DPAPI structures. | **Hardened:** Clean, unprivileged service boundary; credentials imported over stdin/API; master keys strictly local. |
| **Operational Simplicity** | **Low:** Difficult to debug shared lock contention and OS boundary translation issues. | **Very Low:** Requires state machine, distributed transaction/tombstone tracking, and drift detection. | **Low:** Requires managing Electron headless processes or Windows named pipes. | **High:** One-way, explicit, idempotent import via standard HTTP/CLI; simple debugging and inspection. |
| **Interactive UX Fidelity** | **Degraded:** Automated proxy rotations mutate the developer's active IDE account unexpectedly. | **Degraded:** Conflicting changes between interactive selections and proxy failover. | **Degraded:** Interactive UI operations stall during high-volume API proxy traffic. | **Preserved:** Developer's IDE account remains steady on `active_cloud_account.ide` regardless of proxy pool rotations. |

### Detailed Evaluation of Alternatives

#### Alternative 1: Shared Mutable SQLite Database
In this model, both Antigravity Manager and `antigravity-proxy` would attach to a single `accounts.db` located in a shared directory (e.g., mounted via DrvFS in WSL or a shared network folder).
- *Why Rejected:* SQLite does not support safe concurrent multi-process writes across Windows/WSL virtual filesystem mounts (DrvFS / 9P). Locks are either not propagated reliably or result in persistent `SQLITE_BUSY` errors. Furthermore, mixing interactive account selections with high-velocity proxy state (real-time rate limit tracking, cooldown timestamps, dynamic token hydration) violates the principle of single responsibility and invites database corruption.

#### Alternative 2: Bidirectional Real-Time Database Synchronization
In this model, Manager and Proxy maintain distinct databases and run a bidirectional synchronization agent (e.g., listening to file changes, database triggers, or webhooks) to mirror account additions, token refreshes, and status flags.
- *Why Rejected:* Bidirectional sync introduces distributed consensus problems without a distributed coordinator. When Google OAuth rotates a refresh token upon token renewal, concurrent refresh attempts by both planes invalidate the grant. Handling conflict resolution, account deletions, and active selector states creates extreme architectural complexity for zero user benefit.

#### Alternative 3: Live DPAPI / Electron Bridge
In this model, the proxy daemon does not persist credentials; instead, it issues live IPC queries across the WSL/Windows boundary into an Electron helper process running in the Windows user session, decrypting tokens on-demand via Windows DPAPI.
- *Why Rejected:* This approach violates the core requirement of a headless server daemon. If the developer logs off, locks Windows, or quits Antigravity Manager, the background proxy fails. Furthermore, inter-process communication between Linux systemd services and interactive Windows desktop sessions introduces severe latency, process lifecycle dependencies, and security vulnerabilities.

---

## 4. Trade-offs

### What We Give Up
- **Instant Automatic Zero-Touch Sync:** Adding an account to Antigravity Manager does not automatically make it available in the proxy pool without an explicit import action (such as executing an import script or piping JSON via stdin).
- **Storage Redundancy:** Accounts utilized in both planes exist in two separate encrypted databases on the machine.

### What We Gain
- **Absolute Operational Stability:** The proxy API runs continuously as an unprivileged, rock-solid system daemon without dependency on desktop application lifecycles.
- **Zero Lock Contention:** Local single-writer SQLite ensures deterministic latency and zero lock contention.
- **Strict Fault Isolation:** API rate limits, model quota exhaustions, and automated account failovers never interfere with a developer's interactive IDE session.
- **Hardened Security Perimeter:** Credentials enter the proxy via ephemeral streams (stdin/TLS) and are encrypted at rest with local master keys, avoiding cross-user or cross-environment permission leaks.

---

## 5. Consequences

### Positive Consequences
- **Stable Developer Experience:** Developers can pin specific accounts for the IDE (`active_cloud_account.ide`) without concern that background agent tasks will rotate their interactive credentials.
- **High-Resilience Agent Execution:** The proxy service independently handles upstream rate limits (`429`), quota limits, and transient provider failures across multiple accounts without user intervention.
- **Clear Maintenance & Evolution:** Antigravity Manager and `antigravity-proxy` can be updated, refactored, or restarted independently without risk of cross-application breakage.
- **Headless & Server Support:** `antigravity-proxy` can be deployed on remote headless servers, developer workstations, or CI runners without requiring Electron or desktop dependencies.

### Negative / Neutral Consequences
- Operators must run an import pipeline (e.g., `import-accounts-stdin.sh` or direct OAuth) when introducing new accounts into the proxy API pool.
- Account deletions in Manager do not automatically prune accounts from the proxy; removal must be issued via the proxy admin API/CLI (`DELETE /admin/accounts/:accountId`).

---

## 6. Security Invariants

All implementations and operations must adhere strictly to these security invariants:

1. **Zero Credential Exposure:**
   Access tokens, refresh tokens, client secrets, and master encryption keys must **never** be logged to stdout, stderr, log files, systemd journals, or error responses.
2. **Ephemeral Ingestion via Stdin:**
   Account exports from Manager containing unencrypted tokens must be passed directly to the proxy importer via pipes (stdin) or memory buffers. Unencrypted credentials must never be written to persistent, unencrypted disk files. Any temporary export file generated during migration must be securely shredded (`shred -u` or equivalent) immediately.
3. **Encryption at Rest:**
   All token payloads in the proxy's `accounts.db` must be encrypted using AES-256-GCM. The encryption master key (`AG_PROXY_MASTER_KEY` or `.master-key`) must be readable only by the unprivileged proxy service user (permissions `0600`).
4. **Distinct Credential Roles:**
   - `AG_PROXY_API_KEY`: Strictly authorized for proxying API inference requests (`/v1/*`, `/v1beta/*`). It provides zero access to administrative endpoints.
   - `AG_PROXY_ADMIN_API_KEY`: Strictly authorized for management endpoints (`/admin/*`). It must be protected with greater restriction than the proxy API key.
5. **Network Binding Boundaries:**
   - By default, the proxy binds strictly to `127.0.0.1:8045`.
   - Wildcard binds (`0.0.0.0`, `::`) are explicitly rejected by configuration guards.
   - Non-loopback binding is restricted to verified Tailscale network interfaces unless an explicit override flag (`AG_PROXY_ALLOW_NON_TAILSCALE_BIND=true`) is supplied.
6. **No Cross-Boundary Privilege Leaks:**
   The WSL systemd service must operate with least privilege as user `antigravity-proxy`. It must not require root privileges during normal runtime and must never access Windows user DPAPI vaults, host registry, or user profile directories.

---

## 7. Cutover Invariants

During migration and deployment of the two-plane architecture:

1. **Preserve Client Contract:**
   The API contract on `http://127.0.0.1:8045` and existing `AG_PROXY_API_KEY` configurations must remain backward compatible with all downstream tools (e.g., Natively, OpenClaw, client SDKs).
2. **Single Listener Verification:**
   Before launching the standalone proxy, Antigravity Manager's internal proxy must be verified disabled, and port `8045` must be free to prevent address binding collisions (`EADDRINUSE`).
3. **Idempotent Migration:**
   The import command (`antigravity-proxy accounts import`) must be fully idempotent. Re-running imports with overlapping or identical account datasets must update existing records in-place without producing duplicate accounts, corrupting quotas, or dropping valid refresh tokens.
4. **Atomic In-Memory Reload:**
   Importing or modifying accounts via the admin API must immediately trigger an in-memory pool reload (`reloadAllAccounts()`), clearing obsolete rate limits and sessions without requiring service restart.

---

## 8. Follow-up Actions

1. **Tooling & Automation:**
   - Maintain the standard import helper script (`scripts/import-accounts-stdin.sh`) for unprivileged service execution.
   - Document zero-file migration pipelines (e.g., streaming Manager exports over SSH directly into WSL importer).
2. **Administrative Surface:**
   - Retain full CLI parity (`antigravity-proxy accounts list|import|export|remove|reload|refresh-quota`).
   - Support direct OAuth flow (`antigravity-proxy oauth url|exchange`) for environments operating without Antigravity Manager.
3. **Observability:**
   - Expose sanitized pool statistics (`account_count`, `active_account_count`) via `GET /admin/status` for monitoring and health verification without disclosing account identifiers or secrets.
