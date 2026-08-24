#!/usr/bin/env node
import 'reflect-metadata';
import fs from 'node:fs';
import process from 'node:process';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { bootstrapNestServer, stopNestServer } from '@/server/main';

interface ParsedArgs {
  command: string[];
  options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      command.push(value);
      continue;
    }

    const option = value.slice(2);
    const equalsIndex = option.indexOf('=');
    const rawKey = equalsIndex >= 0 ? option.slice(0, equalsIndex) : option;
    const inlineValue = equalsIndex >= 0 ? option.slice(equalsIndex + 1) : undefined;
    const key = rawKey.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }

  return { command, options };
}

function getStringOption(options: ParsedArgs['options'], key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

function getBooleanOption(options: ParsedArgs['options'], key: string): boolean {
  return options[key] === true || options[key] === 'true' || options[key] === '1';
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function readImportPayload(options: ParsedArgs['options']): Promise<string> {
  const filePath = getStringOption(options, 'file');
  if (filePath) {
    return Promise.resolve(fs.readFileSync(filePath, 'utf8'));
  }
  return readStdin();
}

function resolveBaseUrl(options: ParsedArgs['options']): string {
  const explicit = getStringOption(options, 'url');
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }

  const config = ConfigManager.loadConfig();
  return `http://${config.proxy.host}:${config.proxy.port}`;
}

function resolveAdminKey(options: ParsedArgs['options']): string {
  const explicit = getStringOption(options, 'adminKey');
  if (explicit) {
    return explicit;
  }

  const config = ConfigManager.loadConfig();
  if (!config.proxy.admin_api_key) {
    throw new Error(
      'Admin API key is not configured. Set AG_PROXY_ADMIN_API_KEY or config.proxy.admin_api_key.',
    );
  }
  return config.proxy.admin_api_key;
}

async function requestAdmin(
  options: ParsedArgs['options'],
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${resolveBaseUrl(options)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${resolveAdminKey(options)}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new Error(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  return payload;
}

async function serve(): Promise<void> {
  const config = ConfigManager.loadConfig();
  const result = await bootstrapNestServer(config.proxy);
  if (!result.success) {
    throw new Error(result.message);
  }
  writeJson(result);

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    await stopNestServer();
    CloudAccountRepo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

async function run(parsed: ParsedArgs): Promise<void> {
  const [primary, secondary] = parsed.command;
  const { options } = parsed;

  if (primary === 'serve') {
    await serve();
    return;
  }

  if (primary === 'health') {
    const response = await fetch(`${resolveBaseUrl(options)}/health`);
    writeJson(await response.json());
    return;
  }

  if (primary === 'status') {
    writeJson(await requestAdmin(options, '/admin/status'));
    return;
  }

  if (primary === 'accounts' && secondary === 'list') {
    writeJson(await requestAdmin(options, '/admin/accounts'));
    return;
  }

  if (primary === 'accounts' && secondary === 'import') {
    const input = await readImportPayload(options);
    const result = (await requestAdmin(options, '/admin/accounts/import', {
      method: 'POST',
      body: input,
    })) as {
      imported?: number;
      skipped?: number;
      errors?: unknown[];
    };
    writeJson({
      imported: result.imported ?? 0,
      skipped: result.skipped ?? 0,
      errorCount: Array.isArray(result.errors) ? result.errors.length : 0,
    });
    return;
  }

  if (primary === 'accounts' && secondary === 'export') {
    const includeTokens = getBooleanOption(options, 'includeTokens');
    const suffix = includeTokens ? '?include_tokens=true' : '';
    writeJson(await requestAdmin(options, `/admin/accounts/export${suffix}`));
    return;
  }

  if (primary === 'accounts' && secondary === 'remove') {
    const accountId = getStringOption(options, 'id') ?? parsed.command[2];
    if (!accountId) {
      throw new Error('Account id is required: accounts remove --id <account-id>');
    }
    writeJson(
      await requestAdmin(options, `/admin/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
      }),
    );
    return;
  }

  if (primary === 'accounts' && secondary === 'reload') {
    writeJson(
      await requestAdmin(options, '/admin/accounts/reload', {
        method: 'POST',
      }),
    );
    return;
  }

  if (primary === 'oauth' && secondary === 'url') {
    const clientKey = getStringOption(options, 'clientKey');
    const suffix = clientKey ? `?client_key=${encodeURIComponent(clientKey)}` : '';
    writeJson(await requestAdmin(options, `/admin/oauth/url${suffix}`));
    return;
  }

  if (primary === 'oauth' && secondary === 'exchange') {
    const code = getStringOption(options, 'code');
    if (!code) {
      throw new Error('OAuth code is required: oauth exchange --code <code>');
    }
    writeJson(
      await requestAdmin(options, '/admin/oauth/exchange', {
        method: 'POST',
        body: JSON.stringify({
          code,
          proxy_url: getStringOption(options, 'proxyUrl'),
          oauth_client_key: getStringOption(options, 'clientKey'),
          fetch_quota: !getBooleanOption(options, 'skipQuota'),
        }),
      }),
    );
    return;
  }

  throw new Error(
    [
      'Usage:',
      '  antigravity-proxy serve',
      '  antigravity-proxy health [--url http://127.0.0.1:8045]',
      '  antigravity-proxy status [--admin-key key] [--url http://127.0.0.1:8045]',
      '  antigravity-proxy accounts list|import|export|remove|reload',
      '  antigravity-proxy oauth url|exchange',
    ].join('\n'),
  );
}

run(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
