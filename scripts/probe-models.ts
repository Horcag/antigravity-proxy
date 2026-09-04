#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export type ModelModality = 'text' | 'image';

export type ErrorCategory =
  | 'timeout'
  | 'network_error'
  | 'auth_error'
  | 'model_not_found'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'service_unavailable'
  | 'server_error'
  | 'client_error'
  | 'empty_payload'
  | 'http_error';

export interface ModelProbeResult {
  model: string;
  modality: ModelModality;
  attempt_count: number;
  http_status: number;
  latency_ms: number;
  response_model: string | null;
  payload_present: boolean;
  error_category: ErrorCategory | null;
}

type ModelProbeAttemptResult = Omit<ModelProbeResult, 'attempt_count'>;

const MAX_PROBE_ATTEMPTS = 2;

export interface ModelInventory {
  published_ids: string[];
  catalog_sources: {
    openai: string[];
    gemini: string[];
  };
  provider_raw_quota_ids: string[];
  deduplicated_targets: Record<string, string[]>;
  published_count: number;
  target_count: number;
  raw_quota_count: number;
}

export interface ProbeReport {
  timestamp: string;
  summary: {
    total_published: number;
    total_targets: number;
    probed: number;
    passed: number;
    failed: number;
    dry_run: boolean;
    duration_ms: number;
  };
  inventory: ModelInventory;
  results: ModelProbeResult[];
}

export interface ParsedCliArgs {
  dryRun: boolean;
  concurrency: number;
  timeoutMs: number;
  url: string;
  jsonOnly: boolean;
  summaryOnly: boolean;
  outputPath?: string;
  models?: string[];
  help: boolean;
}

export interface ResolvedCredentials {
  apiKey: string;
  adminKey?: string;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  // Check for forbidden credential CLI options
  for (const arg of argv) {
    const lower = arg.toLowerCase();
    if (
      lower.startsWith('--api-key') ||
      lower.startsWith('--admin-key') ||
      lower.startsWith('--apikey') ||
      lower.startsWith('--adminkey') ||
      lower === '-k' ||
      lower.startsWith('--key') ||
      lower.startsWith('--secret')
    ) {
      throw new Error(
        'Security Error: API and admin keys must NOT be passed via command-line arguments. ' +
          'Configure AG_PROXY_API_KEY and AG_PROXY_ADMIN_API_KEY in the environment instead.',
      );
    }
  }

  let dryRun = false;
  let concurrency = 4;
  let timeoutMs = 10000;
  let jsonOnly = false;
  let summaryOnly = false;
  let outputPath: string | undefined;
  let models: string[] | undefined;
  let help = false;

  const defaultHost = process.env.AG_PROXY_HOST || '127.0.0.1';
  const defaultPort = process.env.AG_PROXY_PORT || '8045';
  let url = process.env.AG_PROXY_BASE_URL || `http://${defaultHost}:${defaultPort}`;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--json') {
      jsonOnly = true;
    } else if (arg === '--summary') {
      summaryOnly = true;
    } else if (arg === '-c' || arg === '--concurrency') {
      const val = argv[++i];
      const parsed = parseInt(val, 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        throw new Error(`Invalid concurrency value: "${val}". Must be a positive integer.`);
      }
      concurrency = parsed;
    } else if (arg.startsWith('--concurrency=')) {
      const val = arg.slice('--concurrency='.length);
      const parsed = parseInt(val, 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        throw new Error(`Invalid concurrency value: "${val}". Must be a positive integer.`);
      }
      concurrency = parsed;
    } else if (arg === '-t' || arg === '--timeout') {
      const val = argv[++i];
      const parsed = parseInt(val, 10);
      if (Number.isNaN(parsed) || parsed < 100) {
        throw new Error(`Invalid timeout value: "${val}". Must be at least 100 ms.`);
      }
      timeoutMs = parsed;
    } else if (arg.startsWith('--timeout=')) {
      const val = arg.slice('--timeout='.length);
      const parsed = parseInt(val, 10);
      if (Number.isNaN(parsed) || parsed < 100) {
        throw new Error(`Invalid timeout value: "${val}". Must be at least 100 ms.`);
      }
      timeoutMs = parsed;
    } else if (arg === '--url' || arg === '--base-url') {
      url = argv[++i];
    } else if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length);
    } else if (arg.startsWith('--base-url=')) {
      url = arg.slice('--base-url='.length);
    } else if (arg === '-o' || arg === '--output') {
      outputPath = argv[++i];
    } else if (arg.startsWith('--output=')) {
      outputPath = arg.slice('--output='.length);
    } else if (arg === '--models') {
      const val = argv[++i];
      models = val.split(',').map((m) => m.trim()).filter(Boolean);
    } else if (arg.startsWith('--models=')) {
      models = arg.slice('--models='.length).split(',').map((m) => m.trim()).filter(Boolean);
    }
  }

  // Normalize base URL (strip trailing slashes)
  url = url.replace(/\/+$/, '');

  return {
    dryRun,
    concurrency,
    timeoutMs,
    url,
    jsonOnly,
    summaryOnly,
    outputPath,
    models,
    help,
  };
}

export function resolveEnvironmentCredentials(): ResolvedCredentials {
  const apiKey =
    process.env.AG_PROXY_API_KEY ||
    process.env.PROXY_API_KEY ||
    process.env.OPENAI_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      'Missing API key in environment. Set AG_PROXY_API_KEY (or PROXY_API_KEY, OPENAI_API_KEY).',
    );
  }

  const adminKey =
    process.env.AG_PROXY_ADMIN_API_KEY ||
    process.env.ADMIN_API_KEY;

  return {
    apiKey: apiKey.trim(),
    adminKey: adminKey?.trim() || undefined,
  };
}

export function detectModelModality(
  modelId: string,
  quotaInfo?: { supports_images?: boolean },
): ModelModality {
  const normalized = modelId.toLowerCase().trim();
  if (
    normalized.startsWith('gemini-3-pro-image') ||
    normalized.startsWith('gemini-3.1-pro-image') ||
    normalized.includes('-image') ||
    quotaInfo?.supports_images === true
  ) {
    return 'image';
  }
  return 'text';
}

export function resolveRequestTarget(
  modelId: string,
  forwardingRules?: Record<string, string>,
): string {
  const normalized = modelId.trim().toLowerCase();
  if (forwardingRules && forwardingRules[normalized]) {
    return forwardingRules[normalized];
  }
  return modelId.trim();
}

export function buildInventory(
  publishedIds: string[],
  rawQuotaIds: string[],
  forwardingRules: Record<string, string> = {},
  catalogSources: ModelInventory['catalog_sources'] = { openai: publishedIds, gemini: [] },
): ModelInventory {
  const deduplicatedTargets: Record<string, string[]> = {};
  const sortedPublished = [...new Set(publishedIds)].sort();
  const sortedRaw = [...new Set(rawQuotaIds)].sort();

  for (const modelId of sortedPublished) {
    const target = resolveRequestTarget(modelId, forwardingRules);
    if (!deduplicatedTargets[target]) {
      deduplicatedTargets[target] = [];
    }
    deduplicatedTargets[target].push(modelId);
  }

  return {
    published_ids: sortedPublished,
    catalog_sources: {
      openai: [...new Set(catalogSources.openai)].sort(),
      gemini: [...new Set(catalogSources.gemini)].sort(),
    },
    provider_raw_quota_ids: sortedRaw,
    deduplicated_targets: deduplicatedTargets,
    published_count: sortedPublished.length,
    target_count: Object.keys(deduplicatedTargets).length,
    raw_quota_count: sortedRaw.length,
  };
}

export async function fetchPublishedModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<string[]> {
  const res = await fetch(`${baseUrl}/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch /v1/models: HTTP ${res.status}`);
  }

  const json = (await res.json()) as { data?: Array<{ id: string }> };
  if (!json || !Array.isArray(json.data)) {
    throw new Error('Invalid /v1/models response structure (missing data array)');
  }

  return json.data.map((item) => item.id).filter(Boolean);
}

export async function fetchGeminiPublishedModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<string[]> {
  const res = await fetch(`${baseUrl}/v1beta/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch /v1beta/models: HTTP ${res.status}`);
  }

  const json = (await res.json()) as { models?: Array<{ name: string }> };
  if (!json || !Array.isArray(json.models)) {
    throw new Error('Invalid /v1beta/models response structure (missing models array)');
  }

  return json.models
    .map((item) => item.name?.replace(/^models\//, '').trim())
    .filter((name): name is string => Boolean(name));
}

export interface AdminAccountsResult {
  rawQuotaIds: string[];
  forwardingRules: Record<string, string>;
  accountCount: number;
}

export async function fetchAdminAccounts(
  baseUrl: string,
  adminKey: string | undefined,
  timeoutMs: number,
): Promise<AdminAccountsResult> {
  if (!adminKey) {
    return {
      rawQuotaIds: [],
      forwardingRules: {},
      accountCount: 0,
    };
  }

  try {
    const res = await fetch(`${baseUrl}/admin/accounts`, {
      headers: {
        Authorization: `Bearer ${adminKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return {
        rawQuotaIds: [],
        forwardingRules: {},
        accountCount: 0,
      };
    }

    const accounts = (await res.json()) as Array<{
      quota?: {
        models?: Record<string, unknown>;
        model_forwarding_rules?: Record<string, string>;
      };
    }>;

    if (!Array.isArray(accounts)) {
      return {
        rawQuotaIds: [],
        forwardingRules: {},
        accountCount: 0,
      };
    }

    const rawQuotaIds = new Set<string>();
    const forwardingRules: Record<string, string> = {};

    for (const account of accounts) {
      if (account.quota?.models) {
        for (const quotaModelId of Object.keys(account.quota.models)) {
          rawQuotaIds.add(quotaModelId);
        }
      }
      if (account.quota?.model_forwarding_rules) {
        for (const [k, v] of Object.entries(account.quota.model_forwarding_rules)) {
          forwardingRules[k.toLowerCase().trim()] = v.trim();
        }
      }
    }

    return {
      rawQuotaIds: [...rawQuotaIds].sort(),
      forwardingRules,
      accountCount: accounts.length,
    };
  } catch {
    return {
      rawQuotaIds: [],
      forwardingRules: {},
      accountCount: 0,
    };
  }
}

export function categorizeHttpError(
  status: number,
  bodySnippet?: string,
): ErrorCategory {
  if (status === 401 || status === 403) {
    return 'auth_error';
  }
  if (status === 404) {
    return 'model_not_found';
  }
  if (status === 429) {
    const lower = (bodySnippet || '').toLowerCase();
    if (
      lower.includes('quota') ||
      lower.includes('resource_exhausted') ||
      lower.includes('credit')
    ) {
      return 'quota_exhausted';
    }
    return 'rate_limit';
  }
  if (status === 502 || status === 503 || status === 504) {
    return 'service_unavailable';
  }
  if (status >= 500 && status < 600) {
    return 'server_error';
  }
  if (status >= 400 && status < 500) {
    return 'client_error';
  }
  return 'http_error';
}

async function probeModelAttempt(
  modelId: string,
  options: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    modality?: ModelModality;
  },
): Promise<ModelProbeAttemptResult> {
  const modality = options.modality ?? detectModelModality(modelId);
  const startTime = performance.now();

  const isImage = modality === 'image';
  const endpoint = isImage
    ? `${options.baseUrl}/v1/images/generations`
    : `${options.baseUrl}/v1/chat/completions`;

  // The smallest general contract that still allows reasoning models to produce a payload.
  const payload = isImage
    ? JSON.stringify({ model: modelId, prompt: 'probe' })
    : JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 64,
        stream: false,
      });

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: payload,
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    const latencyMs = Math.round(performance.now() - startTime);

    if (res.status === 200) {
      const json = (await res.json().catch(() => null)) as any;
      if (!json || typeof json !== 'object') {
        return {
          model: modelId,
          modality,
          http_status: 200,
          latency_ms: latencyMs,
          response_model: null,
          payload_present: false,
          error_category: 'empty_payload',
        };
      }

      if (isImage) {
        const hasImageData =
          Array.isArray(json.data) &&
          json.data.length > 0 &&
          Boolean(json.data[0]?.b64_json || json.data[0]?.url);

        return {
          model: modelId,
          modality,
          http_status: 200,
          latency_ms: latencyMs,
          response_model: typeof json.model === 'string' ? json.model : null,
          payload_present: hasImageData,
          error_category: hasImageData ? null : 'empty_payload',
        };
      } else {
        // For text models: check choices array
        const hasChoices = Array.isArray(json.choices) && json.choices.length > 0;
        const choice = hasChoices ? json.choices[0] : undefined;
        // payload_present is true if choice exists and has message/text or finish_reason
        const payloadPresent = Boolean(
          choice && (choice.message !== undefined || choice.text !== undefined || choice.finish_reason),
        );

        return {
          model: modelId,
          modality,
          http_status: 200,
          latency_ms: latencyMs,
          response_model: typeof json.model === 'string' ? json.model : null,
          payload_present: payloadPresent,
          error_category: payloadPresent ? null : 'empty_payload',
        };
      }
    } else {
      // Non-200 HTTP status
      const text = await res.text().catch(() => '');
      const errorCategory = categorizeHttpError(res.status, text);

      return {
        model: modelId,
        modality,
        http_status: res.status,
        latency_ms: latencyMs,
        response_model: null,
        payload_present: false,
        error_category: errorCategory,
      };
    }
  } catch (err: any) {
    const latencyMs = Math.round(performance.now() - startTime);
    const isTimeout =
      err?.name === 'TimeoutError' ||
      err?.name === 'AbortError' ||
      err?.code === 23 || // DOMException TIMEOUT_ERR
      (err?.message && String(err.message).toLowerCase().includes('timeout'));

    return {
      model: modelId,
      modality,
      http_status: 0,
      latency_ms: latencyMs,
      response_model: null,
      payload_present: false,
      error_category: isTimeout ? 'timeout' : 'network_error',
    };
  }
}

export function isTransientProbeFailure(result: ModelProbeAttemptResult): boolean {
  return (
    result.http_status === 0 ||
    result.http_status === 429 ||
    (result.http_status >= 500 && result.http_status < 600) ||
    (result.http_status === 200 && !result.payload_present)
  );
}

export async function probeModel(
  modelId: string,
  options: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    modality?: ModelModality;
  },
): Promise<ModelProbeResult> {
  let result: ModelProbeAttemptResult | undefined;

  for (let attempt = 1; attempt <= MAX_PROBE_ATTEMPTS; attempt++) {
    result = await probeModelAttempt(modelId, options);
    if (!isTransientProbeFailure(result) || attempt === MAX_PROBE_ATTEMPTS) {
      return { ...result, attempt_count: attempt };
    }
  }

  throw new Error('Probe attempts exhausted without a result');
}

export function isGenuineFailure(result: ModelProbeResult): boolean {
  if (result.http_status === 200) {
    // If status 200, it is a success as long as a valid response structure is returned.
    // Note: models with thinking budgets might return empty string content with finish_reason="length",
    // which still has payload_present=true and is a successful probe.
    return !result.payload_present;
  }
  return true;
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  let currentIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  const workers = Array.from({ length: workerCount }, async () => {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

export function formatSummary(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push('====================================================');
  lines.push('            MODEL CATALOG PROBE AUDIT               ');
  lines.push('====================================================');
  lines.push(`Timestamp:       ${report.timestamp}`);
  lines.push(`Dry Run:         ${report.summary.dry_run ? 'Yes (inventory only)' : 'No'}`);
  lines.push(`Published IDs:   ${report.summary.total_published}`);
  lines.push(`Unique Targets:  ${report.summary.total_targets}`);
  lines.push(`Raw Quota IDs:   ${report.inventory.raw_quota_count}`);

  if (!report.summary.dry_run) {
    lines.push(`Probed Models:   ${report.summary.probed}`);
    lines.push(`Passed Models:   ${report.summary.passed}`);
    lines.push(`Failed Models:   ${report.summary.failed}`);
    lines.push(`Audit Duration:  ${report.summary.duration_ms} ms`);
    lines.push('----------------------------------------------------');

    // Grouping by status
    const failed = report.results.filter((r) => isGenuineFailure(r));

    if (failed.length > 0) {
      lines.push('FAILED MODELS:');
      for (const r of failed) {
        lines.push(
          `  - ${r.model.padEnd(30)} [${r.modality}] HTTP ${r.http_status} (${r.error_category}) latency=${r.latency_ms}ms`,
        );
      }
      lines.push('----------------------------------------------------');
    }

    lines.push(`Result:          ${failed.length === 0 ? 'ALL PASSED' : `${failed.length} MODEL(S) FAILED`}`);
  } else {
    lines.push('----------------------------------------------------');
    lines.push('Inventory Sample (Deduplicated Targets):');
    const targetEntries = Object.entries(report.inventory.deduplicated_targets);
    for (const [target, aliases] of targetEntries.slice(0, 10)) {
      lines.push(`  * ${target} (${aliases.length} aliases: ${aliases.slice(0, 4).join(', ')}${aliases.length > 4 ? ', ...' : ''})`);
    }
    if (targetEntries.length > 10) {
      lines.push(`  ... and ${targetEntries.length - 10} more targets`);
    }
    lines.push('----------------------------------------------------');
    lines.push('Result:          INVENTORY READY');
  }
  lines.push('====================================================');
  return lines.join('\n');
}

export async function runProbeAudit(argv: string[]): Promise<{ report: ProbeReport; exitCode: number }> {
  const startTime = performance.now();
  const cliArgs = parseCliArgs(argv);

  if (cliArgs.help) {
    printHelp();
    return {
      report: {
        timestamp: new Date().toISOString(),
        summary: {
          total_published: 0,
          total_targets: 0,
          probed: 0,
          passed: 0,
          failed: 0,
          dry_run: true,
          duration_ms: 0,
        },
        inventory: {
          published_ids: [],
          catalog_sources: { openai: [], gemini: [] },
          provider_raw_quota_ids: [],
          deduplicated_targets: {},
          published_count: 0,
          target_count: 0,
          raw_quota_count: 0,
        },
        results: [],
      },
      exitCode: 0,
    };
  }

  const credentials = resolveEnvironmentCredentials();

  // 1. Fetch both public catalogs. /v1/models intentionally omits image-only models.
  const [openaiPublishedIds, geminiPublishedIds] = await Promise.all([
    fetchPublishedModels(cliArgs.url, credentials.apiKey, cliArgs.timeoutMs),
    fetchGeminiPublishedModels(cliArgs.url, credentials.apiKey, cliArgs.timeoutMs),
  ]);
  const publishedIds = [...new Set([...openaiPublishedIds, ...geminiPublishedIds])].sort();

  // 2. Fetch /admin/accounts if admin key available
  const adminResult = await fetchAdminAccounts(cliArgs.url, credentials.adminKey, cliArgs.timeoutMs);

  // 3. Build inventory
  const inventory = buildInventory(publishedIds, adminResult.rawQuotaIds, adminResult.forwardingRules, {
    openai: openaiPublishedIds,
    gemini: geminiPublishedIds,
  });

  const modelsToProbe = cliArgs.models && cliArgs.models.length > 0
    ? cliArgs.models.filter((m) => publishedIds.includes(m))
    : publishedIds;

  let results: ModelProbeResult[] = [];

  if (!cliArgs.dryRun) {
    results = await runWithConcurrency(modelsToProbe, cliArgs.concurrency, async (modelId) => {
      return probeModel(modelId, {
        baseUrl: cliArgs.url,
        apiKey: credentials.apiKey,
        timeoutMs: cliArgs.timeoutMs,
      });
    });
  }

  const durationMs = Math.round(performance.now() - startTime);
  const failedCount = results.filter((r) => isGenuineFailure(r)).length;
  const passedCount = results.length - failedCount;

  const report: ProbeReport = {
    timestamp: new Date().toISOString(),
    summary: {
      total_published: publishedIds.length,
      total_targets: inventory.target_count,
      probed: results.length,
      passed: passedCount,
      failed: failedCount,
      dry_run: cliArgs.dryRun,
      duration_ms: durationMs,
    },
    inventory,
    results,
  };

  const exitCode = cliArgs.dryRun ? 0 : failedCount === 0 ? 0 : 1;
  return { report, exitCode };
}

function printHelp(): void {
  const helpText = `
Antigravity Proxy Model Catalog Probe Tool

Usage:
  node scripts/probe-models.ts [options]

Options:
  --dry-run                 Inventory mode: discover OpenAI and Gemini models without probes.
  -c, --concurrency <num>   Max concurrent requests during probe (default: 4).
  -t, --timeout <ms>        Request timeout in milliseconds (default: 10000).
  --url, --base-url <url>   Proxy base URL (default: AG_PROXY_BASE_URL or http://127.0.0.1:8045).
  --json                    Output pure JSON to stdout.
  --summary                 Output only the human-readable summary.
  -o, --output <file>       Write the complete JSON report to a file.
  --models <m1,m2,...>      Probe only IDs published by either catalog.
  -h, --help                Show this help message.

Environment Variables:
  AG_PROXY_API_KEY          Bearer API key for catalogs and completion endpoints (required).
  AG_PROXY_ADMIN_API_KEY    Bearer admin API key for /admin/accounts (optional for quota IDs).
  AG_PROXY_BASE_URL         Proxy base URL override (optional).
  AG_PROXY_HOST / PORT      Host/Port fallback for base URL (defaults: 127.0.0.1:8045).

Security Notes:
  - API/admin keys must NEVER be passed as CLI arguments.
  - All output is strictly sanitized; prompt texts, responses, and image bytes are never logged.
`;
  process.stdout.write(helpText);
}

export async function main(): Promise<void> {
  try {
    const rawArgs = process.argv.slice(2);
    const { report, exitCode } = await runProbeAudit(rawArgs);
    const cliArgs = parseCliArgs(rawArgs);

    if (cliArgs.help) {
      process.exit(0);
    }

    if (cliArgs.outputPath) {
      fs.writeFileSync(cliArgs.outputPath, JSON.stringify(report, null, 2), 'utf8');
    }

    const summaryStr = formatSummary(report);
    const jsonStr = JSON.stringify(report, null, 2);

    if (cliArgs.jsonOnly) {
      process.stdout.write(`${jsonStr}\n`);
    } else if (cliArgs.summaryOnly) {
      process.stdout.write(`${summaryStr}\n`);
    } else {
      // Default: concise summary on stderr, JSON on stdout
      // This allows piping stdout to jq or files while keeping summary visible in terminals
      process.stderr.write(`${summaryStr}\n`);
      process.stdout.write(`${jsonStr}\n`);
    }

    process.exit(exitCode);
  } catch (err: any) {
    process.stderr.write(`Error: ${err?.message || err}\n`);
    process.exit(1);
  }
}

// Only execute main if invoked directly as CLI script
const currentFile = path.resolve(process.argv[1] || '');
const scriptFile = path.resolve(import.meta.filename || '');
if (currentFile === scriptFile) {
  main();
}
