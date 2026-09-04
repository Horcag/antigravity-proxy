# Antigravity Proxy Model Catalog Probe Tool

`scripts/probe-models.ts` is a safe, reproducible CLI audit tool for verifying model catalogs, route mapping, and endpoint health across Antigravity Proxy deployments.

---

## Key Features

1. **Strict Credential Security (Environment Only)**:
   - Credentials (`AG_PROXY_API_KEY`, `AG_PROXY_ADMIN_API_KEY`) are read **strictly from the process environment**.
   - Passing API or admin keys via command-line arguments (e.g. `--api-key`) is explicitly forbidden and rejected at startup to prevent key exposure via process tables (`ps`), shell histories, or CI logs.
2. **Catalog Inventory & Deduplication**:
   - Fetches published model IDs from `GET /v1/models`.
   - Fetches provider raw quota IDs from `GET /admin/accounts` (when `AG_PROXY_ADMIN_API_KEY` is present).
   - Distinguishes and maps published IDs to underlying deduplicated request targets (e.g., `gpt-4o` -> `gemini-3-flash`, `claude-sonnet-4-6` -> `claude-sonnet-4-6-thinking`).
3. **Modality-Specific Minimal Probing**:
   - Automatically classifies models by modality (`text` vs `image`).
   - Text models are probed via `POST /v1/chat/completions` using a tiny payload (`max_tokens: 1`, prompt `"hi"`).
   - Image models are probed via `POST /v1/images/generations` using a tiny payload (prompt `"probe"`).
4. **Strict Sanitization & Zero Content Leakage**:
   - The probe records **only sanitized metadata**:
     - `model` (published ID)
     - `modality` (`text` | `image`)
     - `http_status` (HTTP response code or 0 for network/timeout errors)
     - `latency_ms` (round-trip latency)
     - `response_model` (model reported in upstream header/body)
     - `payload_present` (boolean flag indicating whether a valid payload choice was returned)
     - `error_category` (compact normalized category: `timeout`, `network_error`, `auth_error`, `model_not_found`, `rate_limit`, `quota_exhausted`, `service_unavailable`, `server_error`, `client_error`, `empty_payload`)
   - **Never writes response text, generated content, prompts, tokens, or image base64 bytes to logs, stdout, stderr, or reports**.
5. **Thinking Model Tolerance**:
   - Models with thinking budgets (e.g. `gemini-3.5-flash-high`, `claude-sonnet-4-6-thinking`) might consume the 1-token output budget purely on internal reasoning, returning HTTP 200 with empty assistant content and `finish_reason: "length"`.
   - Such responses have `payload_present: true` and are recognized as **successful probes**, not failures.
   - The tool exits non-zero **only for genuine failures** (HTTP non-200, missing payload structure, network timeout/error).
6. **Bounded Concurrency & Timeout**:
   - Configurable bounded concurrency (default: `4`) prevents overwhelming upstream rate limits.
   - Per-request timeout (default: `10000 ms`) prevents hangs.
7. **Dry-Run Inventory Mode**:
   - `--dry-run` performs catalog discovery and target resolution without sending any generation requests.

---

## Installation & Execution

The script runs directly on Node.js (>= 22.14.0) with native TypeScript support:

```bash
# Run directly with node
node scripts/probe-models.ts [options]

# Or with execution permissions
chmod +x scripts/probe-models.ts
./scripts/probe-models.ts [options]
```

---

## Environment Variables

| Variable | Description | Required | Default |
| :--- | :--- | :--- | :--- |
| `AG_PROXY_API_KEY` | Bearer API key used for `/v1/models` and completion endpoints | **Yes** | Fallback to `PROXY_API_KEY` / `OPENAI_API_KEY` |
| `AG_PROXY_ADMIN_API_KEY` | Bearer Admin key used for `/admin/accounts` quota inspection | No | Fallback to `ADMIN_API_KEY` (skipped if unset) |
| `AG_PROXY_BASE_URL` | Base URL of the running proxy instance | No | Derived from host & port |
| `AG_PROXY_HOST` | Proxy host address | No | `127.0.0.1` |
| `AG_PROXY_PORT` | Proxy port | No | `8045` |

---

## CLI Options

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--dry-run` | Inventory mode: inspects `/v1/models` and `/admin/accounts`, outputs target mapping, skips probe requests | `false` |
| `-c`, `--concurrency <N>` | Maximum concurrent probe requests | `4` |
| `-t`, `--timeout <ms>` | Per-request timeout in milliseconds | `10000` |
| `--url`, `--base-url <url>` | Override proxy base URL | `http://127.0.0.1:8045` |
| `--json` | Output pure JSON to `stdout` | `false` |
| `--summary` | Output human-readable summary to `stdout` | `false` |
| `-o`, `--output <file>` | Save complete JSON audit report to a file | `undefined` |
| `--models <m1,m2>` | Comma-separated list of specific models to probe | All published models |
| `-h`, `--help` | Display help and usage information | `false` |

---

## Output Format

### Default Mode
In default mode, the tool writes the human-readable summary to `stderr` and the structured JSON report to `stdout`. This allows piping `stdout` directly into `jq` or file redirects while keeping live terminal progress visible.

```bash
export AG_PROXY_API_KEY="your-api-key"
export AG_PROXY_ADMIN_API_KEY="your-admin-key"

node scripts/probe-models.ts > audit.json
```

### JSON Report Structure

```json
{
  "timestamp": "2026-09-04T17:30:00.000Z",
  "summary": {
    "total_published": 15,
    "total_targets": 6,
    "probed": 15,
    "passed": 15,
    "failed": 0,
    "dry_run": false,
    "duration_ms": 1420
  },
  "inventory": {
    "published_ids": [
      "claude-sonnet-4-6",
      "claude-sonnet-4-6-thinking",
      "gemini-3-flash",
      "gemini-3-pro-image",
      "gpt-4o"
    ],
    "provider_raw_quota_ids": [
      "gemini-2.5-flash",
      "gemini-2.5-pro"
    ],
    "deduplicated_targets": {
      "gemini-3-flash": ["gemini-3-flash", "gpt-4o"],
      "claude-sonnet-4-6-thinking": ["claude-sonnet-4-6", "claude-sonnet-4-6-thinking"],
      "gemini-3-pro-image": ["gemini-3-pro-image"]
    },
    "published_count": 5,
    "target_count": 3,
    "raw_quota_count": 2
  },
  "results": [
    {
      "model": "gemini-3-flash",
      "modality": "text",
      "http_status": 200,
      "latency_ms": 128,
      "response_model": "gemini-3-flash",
      "payload_present": true,
      "error_category": null
    },
    {
      "model": "gemini-3-pro-image",
      "modality": "image",
      "http_status": 200,
      "latency_ms": 340,
      "response_model": "gemini-3-pro-image",
      "payload_present": true,
      "error_category": null
    }
  ]
}
```

---

## Exit Codes

- `0`: All published models probed successfully (or completed `--dry-run` inventory).
- `1`: One or more published models genuinely failed (HTTP non-200, corrupt payload, timeout, or configuration error).
