import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('preferred account CLI', () => {
  const requests: Array<{ method?: string; path?: string; authorization?: string; body?: string }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: body || undefined,
      });
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(
          request.url === '/admin/accounts/export'
            ? {
                version: '1.0',
                exportedAt: 1,
                accounts: [
                  { email: 'user@example.test', proxy_url: 'https://proxy.example.test:8443' },
                ],
              }
            : request.url === '/admin/accounts/quota-diagnostics'
              ? {
                  refresh_interval_seconds: 600,
                  accounts: [{ account_label: 'account-1', refresh_state: 'unknown', models: [] }],
                }
            : {
                preferred_account_id: request.method === 'DELETE' ? null : 'acc-1',
                account: request.method === 'DELETE' ? null : { id: 'acc-1', provider: 'google' },
              },
        ),
      );
    });
  });
  let baseUrl = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('uses the admin API for get, set, and clear', async () => {
    const commonArgs = ['--url', baseUrl, '--admin-key', 'admin-key'];
    const get = await runCli(['accounts', 'preferred', 'get', ...commonArgs]);
    const set = await runCli(['accounts', 'preferred', 'set', '--id', 'acc-1', ...commonArgs]);
    const clear = await runCli(['accounts', 'preferred', 'clear', ...commonArgs]);

    expect(get).toMatchObject({ code: 0, stderr: '' });
    expect(set).toMatchObject({ code: 0, stderr: '' });
    expect(clear).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(get.stdout)).toMatchObject({ preferred_account_id: 'acc-1' });
    expect(JSON.parse(set.stdout)).toMatchObject({ preferred_account_id: 'acc-1' });
    expect(JSON.parse(clear.stdout)).toEqual({ preferred_account_id: null, account: null });
    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/admin/accounts/preferred',
        authorization: 'Bearer admin-key',
        body: undefined,
      },
      {
        method: 'PUT',
        path: '/admin/accounts/preferred',
        authorization: 'Bearer admin-key',
        body: JSON.stringify({ account_id: 'acc-1' }),
      },
      {
        method: 'DELETE',
        path: '/admin/accounts/preferred',
        authorization: 'Bearer admin-key',
        body: undefined,
      },
    ]);
  }, 15_000);

  it('prints quota diagnostics fetched with the admin key', async () => {
    requests.length = 0;
    const result = await runCli([
      'accounts',
      'quota-diagnostics',
      '--url',
      baseUrl,
      '--admin-key',
      'cli-admin-key-must-not-print',
    ]);

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      refresh_interval_seconds: 600,
      accounts: [{ account_label: 'account-1', refresh_state: 'unknown', models: [] }],
    });
    for (const sensitiveValue of [
      'acc-1',
      'secret@example.test',
      'access-token-must-not-leak',
      'project-must-not-leak',
      'cli-admin-key-must-not-print',
    ]) {
      expect(result.stdout).not.toContain(sensitiveValue);
      expect(result.stdout).not.toContain(Buffer.from(sensitiveValue).toString('base64'));
      expect(result.stdout).not.toContain(createHash('sha256').update(sensitiveValue).digest('hex'));
    }
    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/admin/accounts/quota-diagnostics',
        authorization: 'Bearer cli-admin-key-must-not-print',
        body: undefined,
      },
    ]);
  }, 15_000);

  it('prints only the safe default tokenless account export', async () => {
    const rawProxyUrl =
      'https://proxy-user:proxy-password@proxy.example.test:8443/tunnel?proxy-query=secret#proxy-fragment';
    const rawValues = [
      rawProxyUrl,
      'proxy-user',
      'proxy-password',
      '/tunnel',
      'proxy-query=secret',
      'proxy-fragment',
    ];
    const canaries = rawValues.flatMap((value) => [
      value,
      Buffer.from(value).toString('base64'),
      createHash('sha256').update(value).digest('hex'),
    ]);

    const result = await runCli(['accounts', 'export', '--url', baseUrl, '--admin-key', 'admin-key']);

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      accounts: [{ proxy_url: 'https://proxy.example.test:8443' }],
    });
    for (const canary of canaries) {
      expect(result.stdout).not.toContain(canary);
    }
    expect(requests.at(-1)).toEqual({
      method: 'GET',
      path: '/admin/accounts/export',
      authorization: 'Bearer admin-key',
      body: undefined,
    });
  }, 15_000);
});
