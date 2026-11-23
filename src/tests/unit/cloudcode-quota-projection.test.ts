import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  getQuotaProjectionEndpointKind,
  projectPoolQuotaPayload,
  projectPoolQuotaResponseBuffer,
  tryBufferAndProjectQuotaResponse,
  type PoolQuotaProjectionSnapshot,
} from '@/modules/proxy-gateway/server/cloudcode-quota-projection';
import { classifyUpstreamFailure } from '@/modules/proxy-gateway/server/upstream-failure';
import { CloudCodeFailoverGateway } from '@/modules/proxy-gateway/server/cloudcode-failover-gateway';

describe('cloudcode-quota-projection', () => {
  const multiAccountSnapshot: PoolQuotaProjectionSnapshot = {
    accounts: [
      {
        accountId: 'acc-1',
        models: {
          'gemini-4-neon': { remainingFraction: 0, resetTime: '2026-11-23T08:38:36Z' },
          'claude-sonnet-5-5': { remainingFraction: 0, resetTime: '2026-11-23T12:00:00Z' },
        },
        quotaGroups: [
          {
            display_name: 'Gemini Pro',
            buckets: [
              { bucket_id: '5h', window: '5h', remaining_fraction: 0, reset_time: '2026-11-23T08:38:36Z' },
              { bucket_id: 'weekly', window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-11-28T00:00:00Z' },
            ],
          },
        ],
      },
      {
        accountId: 'acc-2',
        models: {
          'gemini-4-neon': { remainingFraction: 1, resetTime: '2026-11-23T11:00:00Z' },
          'claude-sonnet-5-5': { remainingFraction: 0, resetTime: '2026-11-23T09:15:00Z' },
        },
        quotaGroups: [
          {
            display_name: 'Gemini Pro',
            buckets: [
              { bucket_id: '5h', window: '5h', remaining_fraction: 1, reset_time: '2026-11-23T11:00:00Z' },
              { bucket_id: 'weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-29T00:00:00Z' },
            ],
          },
        ],
      },
      {
        accountId: 'acc-3',
        models: {
          'gemini-4-neon': { remainingFraction: 0.5, resetTime: '2026-11-23T10:00:00Z' },
          'claude-sonnet-5-5': { remainingFraction: 0, resetTime: '2026-11-23T10:30:00Z' },
        },
        quotaGroups: [
          {
            display_name: 'Gemini Pro',
            buckets: [
              { bucket_id: '5h', window: '5h', remaining_fraction: 0.5, reset_time: '2026-11-23T10:00:00Z' },
              { bucket_id: 'weekly', window: 'weekly', remaining_fraction: 0.8, reset_time: '2026-11-28T12:00:00Z' },
            ],
          },
        ],
      },
    ],
  };

  it('recognizes quota metadata endpoints and ignores inference endpoints', () => {
    expect(getQuotaProjectionEndpointKind('/v1internal:fetchAvailableModels')).toBe('fetchAvailableModels');
    expect(getQuotaProjectionEndpointKind('/v1internal:retrieveUserQuotaSummary?alt=json')).toBe('retrieveUserQuotaSummary');
    expect(getQuotaProjectionEndpointKind('/v1internal:retrieveUserQuota')).toBe('retrieveUserQuota');
    expect(getQuotaProjectionEndpointKind('/v1internal:streamGenerateContent')).toBeNull();
  });

  it('projects non-zero pool quota in fetchAvailableModels when queried account has proto3-omitted 0% baseline quota', () => {
    const upstreamPayload = {
      models: {
        'gemini-4-neon': {
          displayName: 'Gemini 4 Neon',
          quotaInfo: {
            // Proto3 JSON omits remainingFraction when 0
            resetTime: '2026-11-23T08:38:36Z',
          },
        },
        'claude-sonnet-5-5': {
          displayName: 'Claude Sonnet',
          quotaInfo: {
            resetTime: '2026-11-23T12:00:00Z',
          },
        },
      },
    };

    const result = projectPoolQuotaPayload('fetchAvailableModels', upstreamPayload, multiAccountSnapshot, 'acc-1');
    expect(result.modified).toBe(true);
    const models = (result.payload as any).models;
    // (0 + 1 + 0.5) / 3 = 0.5
    expect(models['gemini-4-neon'].quotaInfo.remainingFraction).toBe(0.5);
    expect(models['gemini-4-neon'].quotaInfo.resetTime).toBe('2026-11-23T10:00:00Z');
    // All 3 accounts are 0% for claude-sonnet-5-5 -> stays 0, earliest resetTime selected
    expect(models['claude-sonnet-5-5'].quotaInfo.remainingFraction).toBeUndefined();
    expect(models['claude-sonnet-5-5'].quotaInfo.resetTime).toBe('2026-11-23T09:15:00Z');
  });

  it('projects non-zero pool quota in retrieveUserQuotaSummary when queried account 5h bucket is exhausted', () => {
    const upstreamPayload = {
      groups: [
        {
          displayName: 'Gemini Pro',
          buckets: [
            { bucketId: '5h', window: '5h', resetTime: '2026-11-23T08:38:36Z' },
            { bucketId: 'weekly', window: 'weekly', remainingFraction: 0.5, resetTime: '2026-11-28T00:00:00Z' },
          ],
        },
      ],
    };

    const result = projectPoolQuotaPayload('retrieveUserQuotaSummary', upstreamPayload, multiAccountSnapshot, 'acc-1');
    expect(result.modified).toBe(true);
    const buckets = (result.payload as any).groups[0].buckets;
    expect(buckets[0].remainingFraction).toBe(0.5);
    expect(buckets[1].remainingFraction).toBeCloseTo(0.7667, 4);
  });

  it('projects gzipped retrieveUserQuota response buffers cleanly', () => {
    const rawJson = JSON.stringify({
      buckets: [
        { modelId: 'gemini-4-neon', resetTime: '2026-11-23T08:38:36Z' },
      ],
    });
    const gzipped = zlib.gzipSync(Buffer.from(rawJson, 'utf-8'));

    const res = projectPoolQuotaResponseBuffer(
      '/v1internal:retrieveUserQuota',
      gzipped,
      'gzip',
      multiAccountSnapshot,
      'acc-1',
    );
    expect(res.modified).toBe(true);
    const decoded = JSON.parse(res.body.toString('utf-8'));
    expect(decoded.buckets[0].remainingFraction).toBe(0.5);
  });

  it('fails open without modifying payload for single-account pools or malformed JSON', () => {
    const singleAccount: PoolQuotaProjectionSnapshot = {
      accounts: [multiAccountSnapshot.accounts[0]],
    };
    const raw = Buffer.from(JSON.stringify({ models: { 'gemini-4-neon': { quotaInfo: { resetTime: '2026-11-23T08:38:36Z' } } } }));
    expect(projectPoolQuotaResponseBuffer('/v1internal:fetchAvailableModels', raw, undefined, singleAccount, 'acc-1').modified).toBe(false);

    const broken = Buffer.from('{not-valid-json', 'utf-8');
    const brokenRes = projectPoolQuotaResponseBuffer('/v1internal:fetchAvailableModels', broken, undefined, multiAccountSnapshot, 'acc-1');
    expect(brokenRes.modified).toBe(false);
    expect(brokenRes.body).toBe(broken);
  });

  it('classifies Baseline model quota reached / AI Credit overages errors as failover-eligible quota errors', () => {
    const msg = 'Baseline model quota reached. Your plan\'s baseline quota will refresh on 11/23/2026, 12:38:36 PM. To continue using this model now, enable AI Credit overages.';
    const evidence = classifyUpstreamFailure({
      statusCode: 400,
      headers: {},
      errorText: msg,
      urlPath: '/v1internal:streamGenerateContent',
      source: 'http',
    });
    expect(evidence.category).toBe('quota');
    expect(evidence.isQuota).toBe(true);

    const gateway = new CloudCodeFailoverGateway();
    const frame = gateway.classifyProtocolFrame(
      'application/json',
      Buffer.from(JSON.stringify({ error: { code: 400, message: msg } }), 'utf-8'),
      {},
      undefined,
      true,
      200,
      true,
    );
    expect(frame.state).toBe('VALIDATED_ERROR');
    expect(frame.isQuota).toBe(true);
    expect(frame.category).toBe('account-quota');
  });

  it('rejects cleanly when upstream quota metadata stream closes prematurely without end', async () => {
    const bodyStream = new PassThrough();
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { destroyed: false });

    const promise = tryBufferAndProjectQuotaResponse({
      urlPath: '/v1internal:fetchAvailableModels',
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      firstChunk: Buffer.from('{"models":', 'utf-8'),
      bodyStream,
      req,
      res,
      isClientAborted: () => false,
      getSnapshot: () => multiAccountSnapshot,
      currentAccountId: 'acc-1',
    });

    bodyStream.destroy();
    await expect(promise).rejects.toThrow(/closed prematurely/i);
  });

  it('does not truncate multi-chunk response when req emits normal close', async () => {
    const bodyStream = new PassThrough();
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { destroyed: false });

    const fullJson = JSON.stringify({
      models: {
        'gemini-4-neon': {
          quotaInfo: { resetTime: '2026-11-23T08:38:36Z' },
        },
      },
    });
    const splitAt = Math.floor(fullJson.length / 2);

    const promise = tryBufferAndProjectQuotaResponse({
      urlPath: '/v1internal:fetchAvailableModels',
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      firstChunk: Buffer.from(fullJson.slice(0, splitAt), 'utf-8'),
      bodyStream,
      req,
      res,
      isClientAborted: () => false,
      getSnapshot: () => multiAccountSnapshot,
      currentAccountId: 'acc-1',
    });

    // Normal request-body completion emits 'close' on req while response is still streaming.
    req.emit('close');
    bodyStream.end(Buffer.from(fullJson.slice(splitAt), 'utf-8'));

    const outcome = await promise;
    expect(outcome.handled).toBe(true);
    if (outcome.handled && !outcome.aborted) {
      const parsed = JSON.parse(outcome.body.toString('utf-8'));
      expect(parsed.models['gemini-4-neon'].quotaInfo.remainingFraction).toBe(0.5);
    }
  });
});
