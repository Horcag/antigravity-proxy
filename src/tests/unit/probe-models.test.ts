import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInventory,
  categorizeHttpError,
  detectModelModality,
  fetchAdminAccounts,
  fetchGeminiPublishedModels,
  fetchPublishedModels,
  formatSummary,
  isGenuineFailure,
  parseCliArgs,
  probeModel,
  resolveEnvironmentCredentials,
  resolveRequestTarget,
  runProbeAudit,
  runWithConcurrency,
} from '../../../scripts/probe-models';

describe('probe-models CLI tool', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Security & Environment Credentials', () => {
    it('rejects credential CLI arguments for security', () => {
      expect(() => parseCliArgs(['--api-key', 'secret123'])).toThrow(/Security Error/);
      expect(() => parseCliArgs(['--admin-key', 'admin123'])).toThrow(/Security Error/);
      expect(() => parseCliArgs(['--apikey=secret123'])).toThrow(/Security Error/);
      expect(() => parseCliArgs(['-k', 'secret'])).toThrow(/Security Error/);
    });

    it('resolves credentials only from environment variables', () => {
      process.env.AG_PROXY_API_KEY = 'ag-test-api-key';
      process.env.AG_PROXY_ADMIN_API_KEY = 'ag-test-admin-key';

      const creds = resolveEnvironmentCredentials();
      expect(creds.apiKey).toBe('ag-test-api-key');
      expect(creds.adminKey).toBe('ag-test-admin-key');
    });

    it('falls back to standard proxy environment variables', () => {
      delete process.env.AG_PROXY_API_KEY;
      process.env.PROXY_API_KEY = 'fallback-proxy-key';

      const creds = resolveEnvironmentCredentials();
      expect(creds.apiKey).toBe('fallback-proxy-key');
    });

    it('throws when no API key is configured in environment', () => {
      delete process.env.AG_PROXY_API_KEY;
      delete process.env.PROXY_API_KEY;
      delete process.env.OPENAI_API_KEY;

      expect(() => resolveEnvironmentCredentials()).toThrow(/Missing API key in environment/);
    });
  });

  describe('CLI Argument Parsing', () => {
    it('parses valid options correctly', () => {
      const args = parseCliArgs([
        '--dry-run',
        '-c',
        '8',
        '-t',
        '3000',
        '--url',
        'http://127.0.0.1:9999/',
        '--json',
        '--output',
        '/tmp/audit.json',
        '--models',
        'gemini-3-flash,claude-sonnet-4-6',
      ]);

      expect(args.dryRun).toBe(true);
      expect(args.concurrency).toBe(8);
      expect(args.timeoutMs).toBe(3000);
      expect(args.url).toBe('http://127.0.0.1:9999');
      expect(args.jsonOnly).toBe(true);
      expect(args.outputPath).toBe('/tmp/audit.json');
      expect(args.models).toEqual(['gemini-3-flash', 'claude-sonnet-4-6']);
    });

    it('parses equals-style options', () => {
      const args = parseCliArgs([
        '--concurrency=12',
        '--timeout=5000',
        '--base-url=http://localhost:8080',
        '--summary',
        '--models=gemini-3-flash',
      ]);

      expect(args.concurrency).toBe(12);
      expect(args.timeoutMs).toBe(5000);
      expect(args.url).toBe('http://localhost:8080');
      expect(args.summaryOnly).toBe(true);
      expect(args.models).toEqual(['gemini-3-flash']);
    });

    it('throws on invalid concurrency or timeout', () => {
      expect(() => parseCliArgs(['-c', '0'])).toThrow(/Invalid concurrency/);
      expect(() => parseCliArgs(['--timeout', '50'])).toThrow(/Invalid timeout/);
    });
  });

  describe('Modality Detection', () => {
    it('identifies image models by prefix, suffix, and keywords', () => {
      expect(detectModelModality('gemini-3-pro-image')).toBe('image');
      expect(detectModelModality('gemini-3-pro-image-2k')).toBe('image');
      expect(detectModelModality('gemini-3.1-pro-image')).toBe('image');
      expect(detectModelModality('custom-image')).toBe('image');
      expect(detectModelModality('my-model', { supports_images: true })).toBe('image');
    });

    it('identifies text models', () => {
      expect(detectModelModality('gemini-3-flash')).toBe('text');
      expect(detectModelModality('gemini-3.5-flash-high')).toBe('text');
      expect(detectModelModality('claude-sonnet-4-6-thinking')).toBe('text');
      expect(detectModelModality('gpt-4o')).toBe('text');
      expect(detectModelModality('gpt-oss-120b-medium')).toBe('text');
    });
  });

  describe('Target Resolution & Model Mapping', () => {
    it('uses live admin forwarding rules', () => {
      const forwarding = { 'legacy-target': 'gemini-3.5-flash-high' };
      expect(resolveRequestTarget('legacy-target', forwarding)).toBe('gemini-3.5-flash-high');
    });

    it('preserves every published ID without a live forwarding rule', () => {
      expect(resolveRequestTarget('gemini-3.5-flash-high')).toBe('gemini-3.5-flash-high');
      expect(resolveRequestTarget('gpt-oss-120b-medium')).toBe('gpt-oss-120b-medium');
      expect(resolveRequestTarget('gpt-4o')).toBe('gpt-4o');
      expect(resolveRequestTarget('gemini-3-pro-image-2k')).toBe('gemini-3-pro-image-2k');
    });
  });

  describe('Inventory Construction', () => {
    it('uses live forwarding rules as the only deduplication source', () => {
      const published = ['gemini-3-flash', 'legacy-flash', 'legacy-flash-alt'];
      const rawQuota = ['gemini-2.5-flash', 'gemini-2.5-pro'];

      const inventory = buildInventory(published, rawQuota, {
        'legacy-flash': 'gemini-3-flash',
        'legacy-flash-alt': 'gemini-3-flash',
      });

      expect(inventory.published_count).toBe(3);
      expect(inventory.raw_quota_count).toBe(2);
      expect(inventory.target_count).toBe(1);

      expect(inventory.deduplicated_targets['gemini-3-flash']).toEqual(
        expect.arrayContaining(['gemini-3-flash', 'legacy-flash', 'legacy-flash-alt']),
      );
    });
  });

  describe('Network Operations (Mocked)', () => {
    it('fetches and extracts published models from /v1/models', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          object: 'list',
          data: [{ id: 'gemini-3-flash' }, { id: 'claude-sonnet-4-6-thinking' }],
        }),
      } as Response);

      const models = await fetchPublishedModels('http://proxy', 'key123', 5000);
      expect(models).toEqual(['gemini-3-flash', 'claude-sonnet-4-6-thinking']);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://proxy/v1/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer key123' },
        }),
      );
    });

    it('fetches Gemini catalog models and normalizes models/<id> names', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ name: 'models/gemini-3-pro-image' }, { name: 'gemini-3-flash' }],
        }),
      } as Response);

      await expect(fetchGeminiPublishedModels('http://proxy', 'key123', 5000)).resolves.toEqual([
        'gemini-3-pro-image',
        'gemini-3-flash',
      ]);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://proxy/v1beta/models',
        expect.objectContaining({ headers: { Authorization: 'Bearer key123' } }),
      );
    });

    it('fetches raw quota IDs from /admin/accounts when admin key is supplied', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'acc-1',
            quota: {
              models: {
                'gemini-2.5-flash': {},
                'gemini-2.5-pro': {},
              },
              model_forwarding_rules: {
                'old-model': 'new-model',
              },
            },
          },
        ],
      } as Response);

      const result = await fetchAdminAccounts('http://proxy', 'admin-key', 5000);
      expect(result.rawQuotaIds).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
      expect(result.forwardingRules).toEqual({ 'old-model': 'new-model' });
      expect(result.accountCount).toBe(1);
    });

    it('handles omitted or failed /admin/accounts gracefully without failing', async () => {
      const noKey = await fetchAdminAccounts('http://proxy', undefined, 5000);
      expect(noKey.rawQuotaIds).toEqual([]);
      expect(noKey.accountCount).toBe(0);

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as Response);

      const failed = await fetchAdminAccounts('http://proxy', 'bad-admin-key', 5000);
      expect(failed.rawQuotaIds).toEqual([]);
    });

    it('probes text model via /v1/chat/completions and sanitizes response', async () => {
      let capturedBody: string | undefined;
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
        capturedBody = init?.body as string;
        return {
          status: 200,
          json: async () => ({
            id: 'chatcmpl-123',
            model: 'gemini-3-flash',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'SECRET_GENERATED_CONTENT_DO_NOT_LEAK' },
                finish_reason: 'stop',
              },
            ],
          }),
        } as Response;
      });

      const result = await probeModel('gemini-3-flash', {
        baseUrl: 'http://proxy',
        apiKey: 'test-key',
        timeoutMs: 5000,
      });

      // Verify request payload was tiny
      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.max_tokens).toBe(1);
      expect(parsed.model).toBe('gemini-3-flash');
      expect(parsed.messages).toEqual([{ role: 'user', content: 'hi' }]);

      // Verify sanitized result
      expect(result.model).toBe('gemini-3-flash');
      expect(result.modality).toBe('text');
      expect(result.http_status).toBe(200);
      expect(result.response_model).toBe('gemini-3-flash');
      expect(result.payload_present).toBe(true);
      expect(result.error_category).toBeNull();

      // STRICT SANITIZATION CHECK: no prompt or generated content in result
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('SECRET_GENERATED_CONTENT_DO_NOT_LEAK');
      expect(serialized).not.toContain('hi');
      expect(isGenuineFailure(result)).toBe(false);
    });

    it('probes image model via /v1/images/generations and sanitizes image bytes', async () => {
      let capturedUrl: string | undefined;
      let capturedBody: string | undefined;

      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (url, init) => {
        capturedUrl = String(url);
        capturedBody = init?.body as string;
        return {
          status: 200,
          json: async () => ({
            created: 123456789,
            model: 'gemini-3-pro-image',
            data: [
              {
                b64_json: 'VERY_LONG_IMAGE_BYTES_BASE64_DATA_DO_NOT_STORE',
              },
            ],
          }),
        } as Response;
      });

      const result = await probeModel('gemini-3-pro-image', {
        baseUrl: 'http://proxy',
        apiKey: 'test-key',
        timeoutMs: 5000,
      });

      expect(capturedUrl).toContain('/v1/images/generations');
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.prompt).toBe('probe');

      expect(result.model).toBe('gemini-3-pro-image');
      expect(result.modality).toBe('image');
      expect(result.http_status).toBe(200);
      expect(result.payload_present).toBe(true);
      expect(result.error_category).toBeNull();

      // STRICT SANITIZATION CHECK: no image bytes in result
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('VERY_LONG_IMAGE_BYTES_BASE64_DATA_DO_NOT_STORE');
      expect(isGenuineFailure(result)).toBe(false);
    });

    it('tolerates thinking models that return empty content when token budget is consumed', async () => {
      // Upstream thinking model returns 200 with empty content and finish_reason: "length"
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          id: 'chatcmpl-think',
          model: 'gemini-3.5-flash-high',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '' },
              finish_reason: 'length',
            },
          ],
        }),
      } as Response);

      const result = await probeModel('gemini-3.5-flash-high', {
        baseUrl: 'http://proxy',
        apiKey: 'test-key',
        timeoutMs: 5000,
      });

      expect(result.http_status).toBe(200);
      expect(result.payload_present).toBe(true);
      expect(result.error_category).toBeNull();
      // Crucial requirement: thinking responses that are 200 must NOT be treated as genuine failures!
      expect(isGenuineFailure(result)).toBe(false);
    });

    it('identifies and categorizes various genuine HTTP errors', async () => {
      // 404 Model not found
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        status: 404,
        text: async () => 'Model not found',
      } as Response);

      const r404 = await probeModel('invalid-model', {
        baseUrl: 'http://proxy',
        apiKey: 'test-key',
        timeoutMs: 5000,
      });
      expect(r404.http_status).toBe(404);
      expect(r404.error_category).toBe('model_not_found');
      expect(isGenuineFailure(r404)).toBe(true);

      // 429 Quota exhausted
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        status: 429,
        text: async () => 'Resource exhausted: quota exceeded',
      } as Response);

      const r429Quota = await probeModel('gemini-3-flash', {
        baseUrl: 'http://proxy',
        apiKey: 'test-key',
        timeoutMs: 5000,
      });
      expect(r429Quota.http_status).toBe(429);
      expect(r429Quota.error_category).toBe('quota_exhausted');
      expect(isGenuineFailure(r429Quota)).toBe(true);

      // 503 Service unavailable
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        status: 503,
        text: async () => 'Backend down',
      } as Response);

      const r503 = await probeModel('gemini-3-flash', {
        baseUrl: 'http://proxy',
        apiKey: 'test-key',
        timeoutMs: 5000,
      });
      expect(r503.http_status).toBe(503);
      expect(r503.error_category).toBe('service_unavailable');
      expect(isGenuineFailure(r503)).toBe(true);
    });

    it('handles network timeouts cleanly', async () => {
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(timeoutErr);

      const result = await probeModel('gemini-3-flash', {
        baseUrl: 'http://proxy',
        apiKey: 'test-key',
        timeoutMs: 1000,
      });

      expect(result.http_status).toBe(0);
      expect(result.error_category).toBe('timeout');
      expect(result.payload_present).toBe(false);
      expect(isGenuineFailure(result)).toBe(true);
    });
  });

  describe('Error Categorization', () => {
    it('categorizes HTTP status codes properly', () => {
      expect(categorizeHttpError(401)).toBe('auth_error');
      expect(categorizeHttpError(403)).toBe('auth_error');
      expect(categorizeHttpError(404)).toBe('model_not_found');
      expect(categorizeHttpError(429, 'rate limit exceeded')).toBe('rate_limit');
      expect(categorizeHttpError(429, 'RESOURCE_EXHAUSTED: quota exceeded')).toBe('quota_exhausted');
      expect(categorizeHttpError(502)).toBe('service_unavailable');
      expect(categorizeHttpError(503)).toBe('service_unavailable');
      expect(categorizeHttpError(500)).toBe('server_error');
      expect(categorizeHttpError(400)).toBe('client_error');
    });
  });

  describe('Bounded Concurrency', () => {
    it('executes tasks within the bounded concurrency limit', async () => {
      let activeWorkers = 0;
      let maxActiveWorkers = 0;

      const items = [1, 2, 3, 4, 5, 6, 7, 8];
      const concurrency = 3;

      const results = await runWithConcurrency(items, concurrency, async (val) => {
        activeWorkers++;
        if (activeWorkers > maxActiveWorkers) {
          maxActiveWorkers = activeWorkers;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeWorkers--;
        return val * 10;
      });

      expect(maxActiveWorkers).toBeLessThanOrEqual(concurrency);
      expect(results).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    });
  });

  describe('End-to-End Audit Runner', () => {
    it('runs in dry-run mode without probing endpoints and exits 0', async () => {
      process.env.AG_PROXY_API_KEY = 'test-api-key';

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const u = String(url);
        if (u.endsWith('/v1/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              object: 'list',
              data: [{ id: 'gemini-3-flash' }, { id: 'gpt-4o' }],
            }),
          } as Response;
        }
        if (u.endsWith('/v1beta/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'models/gemini-3-pro-image' }] }),
          } as Response;
        }
        throw new Error(`Unexpected endpoint called in dry-run: ${u}`);
      });

      const { report, exitCode } = await runProbeAudit(['--dry-run']);
      expect(exitCode).toBe(0);
      expect(report.summary.dry_run).toBe(true);
      expect(report.summary.probed).toBe(0);
      expect(report.summary.total_published).toBe(3);
      expect(report.inventory.published_ids).toEqual([
        'gemini-3-flash',
        'gemini-3-pro-image',
        'gpt-4o',
      ]);
      expect(report.inventory.catalog_sources).toEqual({
        openai: ['gemini-3-flash', 'gpt-4o'],
        gemini: ['gemini-3-pro-image'],
      });
      expect(report.results).toEqual([]);

      const summaryText = formatSummary(report);
      expect(summaryText).toContain('Dry Run:         Yes');
      expect(summaryText).toContain('INVENTORY READY');
    });

    it('returns exit code 0 when all probed models succeed', async () => {
      process.env.AG_PROXY_API_KEY = 'test-api-key';

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const u = String(url);
        if (u.endsWith('/v1/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              object: 'list',
              data: [{ id: 'gemini-3-flash' }],
            }),
          } as Response;
        }
        if (u.endsWith('/v1beta/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'models/gemini-3-pro-image' }] }),
          } as Response;
        }
        if (u.endsWith('/v1/images/generations')) {
          return {
            status: 200,
            json: async () => ({
              model: 'gemini-3-pro-image',
              data: [{ b64_json: 'sanitized' }],
            }),
          } as Response;
        }
        if (u.endsWith('/v1/chat/completions')) {
          return {
            status: 200,
            json: async () => ({
              model: 'gemini-3-flash',
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            }),
          } as Response;
        }
        return { status: 404 } as Response;
      });

      const { report, exitCode } = await runProbeAudit([]);
      expect(exitCode).toBe(0);
      expect(report.summary.probed).toBe(2);
      expect(report.summary.passed).toBe(2);
      expect(report.summary.failed).toBe(0);

      const summaryText = formatSummary(report);
      expect(summaryText).toContain('ALL PASSED');
    });

    it('returns exit code 1 when at least one published model genuinely fails', async () => {
      process.env.AG_PROXY_API_KEY = 'test-api-key';

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const u = String(url);
        if (u.endsWith('/v1/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              object: 'list',
              data: [{ id: 'gemini-3-flash' }, { id: 'broken-model' }],
            }),
          } as Response;
        }
        if (u.endsWith('/v1beta/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ models: [{ name: 'models/gemini-3-pro-image' }] }),
          } as Response;
        }
        if (u.endsWith('/v1/chat/completions')) {
          return {
            status: 500,
            text: async () => 'Internal Error',
          } as Response;
        }
        return { status: 404 } as Response;
      });

      const { report, exitCode } = await runProbeAudit([]);
      expect(exitCode).toBe(1);
      expect(report.summary.failed).toBe(3);

      const summaryText = formatSummary(report);
      expect(summaryText).toContain('MODEL(S) FAILED');
      expect(summaryText).toContain('FAILED MODELS:');
    });
  });
});
