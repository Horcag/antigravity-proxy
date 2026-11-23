import type http from 'node:http';
import type { Readable } from 'node:stream';
import type { CloudQuotaGroup } from '@/modules/cloud-account/types';
import { classifyQuotaBucketPool } from './account-lease-quota-policy';
import { decompressBody } from './cloudcode-request-adapter';
import { normalizeModelId } from './account-lease-token-types';

export type QuotaProjectionEndpointKind =
  | 'fetchAvailableModels'
  | 'retrieveUserQuotaSummary'
  | 'retrieveUserQuota';

export interface PoolModelQuotaEntry {
  remainingFraction: number;
  resetTime?: string;
}

export interface PoolAccountQuotaProjection {
  accountId: string;
  models: Record<string, PoolModelQuotaEntry>;
  quotaGroups: CloudQuotaGroup[];
}

export interface PoolQuotaProjectionSnapshot {
  accounts: PoolAccountQuotaProjection[];
}

export function getQuotaProjectionEndpointKind(urlPath: string): QuotaProjectionEndpointKind | null {
  let pathname = urlPath;
  try {
    pathname = new URL(urlPath, 'https://cloudcode.googleapis.com').pathname;
  } catch {
    // Use raw urlPath fallback when URL parsing fails.
  }

  if (pathname.endsWith(':fetchAvailableModels')) return 'fetchAvailableModels';
  if (pathname.endsWith(':retrieveUserQuotaSummary')) return 'retrieveUserQuotaSummary';
  if (pathname.endsWith(':retrieveUserQuota')) return 'retrieveUserQuota';
  return null;
}

function clampFraction(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

function roundFraction(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function parseTimestampMs(iso: string | undefined): number | null {
  if (!iso || typeof iso !== 'string' || !iso.trim()) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function pickEarliestResetTime(resetTimes: Array<string | undefined>): string | undefined {
  let bestIso: string | undefined;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const iso of resetTimes) {
    const ms = parseTimestampMs(iso);
    if (ms !== null && ms < bestMs) {
      bestMs = ms;
      bestIso = iso;
    }
  }
  return bestIso;
}

function aggregateSamples(
  samples: Array<{ remainingFraction: number; resetTime?: string }>,
): { remainingFraction: number; resetTime?: string } | null {
  if (samples.length === 0) return null;

  let sum = 0;
  let hasPositive = false;
  for (const sample of samples) {
    const frac = clampFraction(sample.remainingFraction);
    sum += frac;
    if (frac > 0) hasPositive = true;
  }

  if (hasPositive) {
    const avg = sum / samples.length;
    const projected = Math.min(1, Math.max(0.01, roundFraction(avg)));
    const positiveReset = pickEarliestResetTime(
      samples.filter((s) => clampFraction(s.remainingFraction) > 0).map((s) => s.resetTime),
    );
    return {
      remainingFraction: projected,
      ...(positiveReset ? { resetTime: positiveReset } : {}),
    };
  }

  const earliestReset = pickEarliestResetTime(samples.map((s) => s.resetTime));
  return {
    remainingFraction: 0,
    ...(earliestReset ? { resetTime: earliestReset } : {}),
  };
}

function lookupModelEntry(
  models: Record<string, PoolModelQuotaEntry>,
  modelId: string,
): PoolModelQuotaEntry | undefined {
  if (models[modelId]) return models[modelId];
  const normalized = normalizeModelId(modelId);
  if (normalized && models[normalized]) return models[normalized];
  const lower = (normalized ?? modelId).toLowerCase();
  if (models[lower]) return models[lower];
  return undefined;
}

function projectFetchAvailableModels(
  payload: Record<string, unknown>,
  snapshot: PoolQuotaProjectionSnapshot,
  currentAccountId?: string,
): boolean {
  const modelsObj = payload.models;
  if (!modelsObj || typeof modelsObj !== 'object' || Array.isArray(modelsObj)) {
    return false;
  }

  let modified = false;
  for (const [modelId, rawModelInfo] of Object.entries(modelsObj as Record<string, unknown>)) {
    if (!rawModelInfo || typeof rawModelInfo !== 'object' || Array.isArray(rawModelInfo)) {
      continue;
    }
    const modelInfo = rawModelInfo as Record<string, unknown>;
    const rawQuotaInfo = modelInfo.quotaInfo;
    if (!rawQuotaInfo || typeof rawQuotaInfo !== 'object' || Array.isArray(rawQuotaInfo)) {
      continue;
    }
    const quotaInfo = rawQuotaInfo as Record<string, unknown>;
    const liveFraction = clampFraction(quotaInfo.remainingFraction ?? 0);
    const liveResetTime = typeof quotaInfo.resetTime === 'string' ? quotaInfo.resetTime : undefined;

    const samples: Array<{ remainingFraction: number; resetTime?: string }> = [];
    let includedCurrent = false;

    for (const acc of snapshot.accounts) {
      if (currentAccountId && acc.accountId === currentAccountId) {
        samples.push({ remainingFraction: liveFraction, resetTime: liveResetTime });
        includedCurrent = true;
        continue;
      }
      const entry = lookupModelEntry(acc.models, modelId);
      if (entry) {
        samples.push(entry);
      }
    }

    if (!includedCurrent) {
      samples.push({ remainingFraction: liveFraction, resetTime: liveResetTime });
    }

    // Only project when we have multi-account information to aggregate.
    if (samples.length <= 1) continue;

    const aggregated = aggregateSamples(samples);
    if (!aggregated) continue;

    if (aggregated.remainingFraction !== liveFraction) {
      quotaInfo.remainingFraction = aggregated.remainingFraction;
      modified = true;
    }
    if (aggregated.resetTime && aggregated.resetTime !== liveResetTime) {
      quotaInfo.resetTime = aggregated.resetTime;
      modified = true;
    }
  }

  return modified;
}

function makeSummaryBucketKey(groupText: string, bucketText: string, windowValue: string, bucketId: string): string {
  const pool = classifyQuotaBucketPool(groupText, bucketText);
  const groupKey = pool ?? groupText.trim().toLowerCase();
  const windowKey = (windowValue || bucketId).trim().toLowerCase();
  return `${groupKey}::${windowKey}`;
}

function projectRetrieveUserQuotaSummary(
  payload: Record<string, unknown>,
  snapshot: PoolQuotaProjectionSnapshot,
  currentAccountId?: string,
): boolean {
  const groups = payload.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return false;
  }

  // Pre-index other accounts' quota group buckets by (pool/groupKey :: windowKey).
  const cachedByKey = new Map<string, Array<{ remainingFraction: number; resetTime?: string }>>();
  for (const acc of snapshot.accounts) {
    if (currentAccountId && acc.accountId === currentAccountId) continue;
    for (const group of acc.quotaGroups ?? []) {
      const groupText = [group.display_name, group.description].filter(Boolean).join(' ');
      for (const bucket of group.buckets ?? []) {
        const bucketText = [bucket.bucket_id, bucket.window, bucket.display_name, bucket.description]
          .filter(Boolean)
          .join(' ');
        const key = makeSummaryBucketKey(groupText, bucketText, bucket.window || '', bucket.bucket_id || '');
        const list = cachedByKey.get(key) ?? [];
        list.push({
          remainingFraction: clampFraction(bucket.remaining_fraction),
          resetTime: bucket.reset_time || undefined,
        });
        cachedByKey.set(key, list);
      }
    }
  }

  if (cachedByKey.size === 0) return false;

  let modified = false;
  for (const rawGroup of groups) {
    if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) continue;
    const group = rawGroup as Record<string, unknown>;
    const groupText = [group.displayName, group.description].filter((v) => typeof v === 'string').join(' ');
    const buckets = group.buckets;
    if (!Array.isArray(buckets)) continue;

    for (const rawBucket of buckets) {
      if (!rawBucket || typeof rawBucket !== 'object' || Array.isArray(rawBucket)) continue;
      const bucket = rawBucket as Record<string, unknown>;
      const bucketText = [bucket.bucketId, bucket.window, bucket.displayName, bucket.description]
        .filter((v) => typeof v === 'string')
        .join(' ');
      const key = makeSummaryBucketKey(
        groupText,
        bucketText,
        typeof bucket.window === 'string' ? bucket.window : '',
        typeof bucket.bucketId === 'string' ? bucket.bucketId : '',
      );
      const otherSamples = cachedByKey.get(key);
      if (!otherSamples || otherSamples.length === 0) continue;

      const liveFraction = clampFraction(bucket.remainingFraction ?? 0);
      const liveResetTime = typeof bucket.resetTime === 'string' ? bucket.resetTime : undefined;
      const aggregated = aggregateSamples([
        { remainingFraction: liveFraction, resetTime: liveResetTime },
        ...otherSamples,
      ]);
      if (!aggregated) continue;

      if (aggregated.remainingFraction !== liveFraction) {
        bucket.remainingFraction = aggregated.remainingFraction;
        modified = true;
      }
      if (aggregated.resetTime && aggregated.resetTime !== liveResetTime) {
        bucket.resetTime = aggregated.resetTime;
        modified = true;
      }
    }
  }

  return modified;
}

function projectRetrieveUserQuota(
  payload: Record<string, unknown>,
  snapshot: PoolQuotaProjectionSnapshot,
  currentAccountId?: string,
): boolean {
  const buckets = payload.buckets;
  if (!Array.isArray(buckets) || buckets.length === 0) {
    return false;
  }

  let modified = false;
  for (const rawBucket of buckets) {
    if (!rawBucket || typeof rawBucket !== 'object' || Array.isArray(rawBucket)) continue;
    const bucket = rawBucket as Record<string, unknown>;
    const modelId = typeof bucket.modelId === 'string' ? bucket.modelId : '';
    if (!modelId) continue;

    const liveFraction = clampFraction(bucket.remainingFraction ?? 0);
    const liveResetTime = typeof bucket.resetTime === 'string' ? bucket.resetTime : undefined;
    const samples: Array<{ remainingFraction: number; resetTime?: string }> = [];
    let includedCurrent = false;

    for (const acc of snapshot.accounts) {
      if (currentAccountId && acc.accountId === currentAccountId) {
        samples.push({ remainingFraction: liveFraction, resetTime: liveResetTime });
        includedCurrent = true;
        continue;
      }
      const entry = lookupModelEntry(acc.models, modelId);
      if (entry) samples.push(entry);
    }

    if (!includedCurrent) {
      samples.push({ remainingFraction: liveFraction, resetTime: liveResetTime });
    }
    if (samples.length <= 1) continue;

    const aggregated = aggregateSamples(samples);
    if (!aggregated) continue;

    if (aggregated.remainingFraction !== liveFraction) {
      bucket.remainingFraction = aggregated.remainingFraction;
      modified = true;
    }
    if (aggregated.resetTime && aggregated.resetTime !== liveResetTime) {
      bucket.resetTime = aggregated.resetTime;
      modified = true;
    }
  }

  return modified;
}

export function projectPoolQuotaPayload(
  endpointKind: QuotaProjectionEndpointKind,
  payload: unknown,
  snapshot: PoolQuotaProjectionSnapshot,
  currentAccountId?: string,
): { modified: boolean; payload: unknown } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { modified: false, payload };
  }
  if (!snapshot || !Array.isArray(snapshot.accounts) || snapshot.accounts.length <= 1) {
    return { modified: false, payload };
  }

  const record = payload as Record<string, unknown>;
  let modified = false;
  switch (endpointKind) {
    case 'fetchAvailableModels':
      modified = projectFetchAvailableModels(record, snapshot, currentAccountId);
      break;
    case 'retrieveUserQuotaSummary':
      modified = projectRetrieveUserQuotaSummary(record, snapshot, currentAccountId);
      break;
    case 'retrieveUserQuota':
      modified = projectRetrieveUserQuota(record, snapshot, currentAccountId);
      break;
  }

  return { modified, payload: record };
}

export function projectPoolQuotaResponseBuffer(
  urlPath: string,
  rawBuffer: Buffer,
  contentEncoding: string | string[] | undefined,
  snapshot: PoolQuotaProjectionSnapshot | undefined,
  currentAccountId?: string,
): { body: Buffer; modified: boolean } {
  const endpointKind = getQuotaProjectionEndpointKind(urlPath);
  if (!endpointKind || !snapshot || snapshot.accounts.length <= 1 || rawBuffer.length === 0) {
    return { body: rawBuffer, modified: false };
  }

  const decomp = decompressBody(rawBuffer, contentEncoding);
  if (decomp.error || !decomp.text) {
    return { body: rawBuffer, modified: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decomp.text);
  } catch {
    return { body: rawBuffer, modified: false };
  }

  const result = projectPoolQuotaPayload(endpointKind, parsed, snapshot, currentAccountId);
  if (!result.modified) {
    return { body: rawBuffer, modified: false };
  }

  return {
    body: Buffer.from(JSON.stringify(result.payload), 'utf-8'),
    modified: true,
  };
}

export async function tryBufferAndProjectQuotaResponse(params: {
  urlPath: string;
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  firstChunk: Buffer | null;
  bodyStream: Readable;
  req: { once?: (...args: any[]) => any; removeListener?: (...args: any[]) => any };
  res: { once?: (...args: any[]) => any; removeListener?: (...args: any[]) => any; destroyed?: boolean };
  isClientAborted: () => boolean;
  getSnapshot?: () => PoolQuotaProjectionSnapshot;
  currentAccountId?: string;
}): Promise<
  | { handled: false; initialChunk: Buffer | null }
  | { handled: true; aborted: true }
  | { handled: true; aborted: false; headers: http.IncomingHttpHeaders; body: Buffer }
> {
  if (params.statusCode !== 200 || !params.getSnapshot || !getQuotaProjectionEndpointKind(params.urlPath)) {
    return { handled: false, initialChunk: params.firstChunk };
  }

  const MAX_BYTES = 4 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let overflowed = false;
  if (params.firstChunk && params.firstChunk.length > 0) {
    chunks.push(params.firstChunk);
    totalBytes += params.firstChunk.length;
    if (totalBytes > MAX_BYTES) overflowed = true;
  }

  if (!overflowed && !params.bodyStream.readableEnded) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finishResolve = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
      const finishReject = (err: Error) => { if (!settled) { settled = true; cleanup(); reject(err); } };
      const onData = (chunk: Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        chunks.push(buf);
        if (totalBytes > MAX_BYTES) {
          overflowed = true;
          params.bodyStream.pause();
          finishResolve();
        }
      };
      const onEnd = () => finishResolve();
      const onClose = () => {
        if (params.bodyStream.readableEnded || params.isClientAborted() || params.res.destroyed) {
          finishResolve();
        } else {
          finishReject(new Error('Upstream quota metadata stream closed prematurely'));
        }
      };
      const onError = (err: Error) => finishReject(err);
      const onClientAbort = () => {
        if (params.isClientAborted() || params.res.destroyed) {
          finishResolve();
        }
      };
      const cleanup = () => {
        params.bodyStream.removeListener('data', onData);
        params.bodyStream.removeListener('end', onEnd);
        params.bodyStream.removeListener('close', onClose);
        params.bodyStream.removeListener('error', onError);
        params.req.removeListener?.('aborted', onClientAbort);
        params.res.removeListener?.('close', onClientAbort);
      };
      params.bodyStream.on('data', onData);
      params.bodyStream.once('end', onEnd);
      params.bodyStream.once('close', onClose);
      params.bodyStream.once('error', onError);
      params.req.once?.('aborted', onClientAbort);
      params.res.once?.('close', onClientAbort);
      params.bodyStream.resume();
    });
  }

  if (params.isClientAborted() || params.res.destroyed) {
    params.bodyStream.destroy();
    return { handled: true, aborted: true };
  }

  if (overflowed) {
    return { handled: false, initialChunk: Buffer.concat(chunks) };
  }

  if (!params.bodyStream.readableEnded) {
    throw new Error('Upstream quota metadata stream did not reach EOF');
  }

  const rawPayload = Buffer.concat(chunks);
  const projected = projectPoolQuotaResponseBuffer(
    params.urlPath,
    rawPayload,
    params.headers['content-encoding'],
    params.getSnapshot(),
    params.currentAccountId,
  );
  if (projected.modified) {
    const outHeaders: http.IncomingHttpHeaders = { ...params.headers };
    delete outHeaders['content-encoding'];
    delete outHeaders['transfer-encoding'];
    outHeaders['content-length'] = String(projected.body.length);
    return { handled: true, aborted: false, headers: outHeaders, body: projected.body };
  }
  return { handled: true, aborted: false, headers: params.headers, body: rawPayload };
}
