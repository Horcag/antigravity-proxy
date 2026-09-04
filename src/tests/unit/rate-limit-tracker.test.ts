import { describe, expect, it } from 'vitest';
import {
  parseRetryDelayMilliseconds,
  RateLimitTracker,
} from '@/modules/proxy-gateway/server/rate-limit-tracker';

function track(
  tracker: RateLimitTracker,
  model: string,
  body: string,
  backoffSteps = [60, 120, 300],
) {
  return tracker.trackFromUpstreamError({
    accountId: 'account-1',
    status: 429,
    body,
    model,
    backoffSteps,
  });
}

describe('RateLimitTracker', () => {
  it('isolates backoff escalation by account, reason, and normalized model', () => {
    const tracker = new RateLimitTracker();

    expect(track(tracker, 'models/gemini-3-flash', 'quota exhausted')).toMatchObject({
      retryAfterSec: 60,
    });
    expect(track(tracker, 'gemini-3-flash', 'quota exhausted')).toMatchObject({
      retryAfterSec: 120,
    });
    expect(
      track(
        tracker,
        'gemini-3-flash',
        '{"error":{"details":[{"reason":"MODEL_CAPACITY_EXHAUSTED"}]}}',
      ),
    ).toMatchObject({ retryAfterSec: 5 });
    expect(
      track(
        tracker,
        'gemini-3-flash',
        '{"error":{"details":[{"reason":"MODEL_CAPACITY_EXHAUSTED"}]}}',
      ),
    ).toMatchObject({ retryAfterSec: 10 });
    expect(track(tracker, 'gemini-3-pro', 'quota exhausted')).toMatchObject({
      retryAfterSec: 60,
    });
  });

  it('clears only the successful model failure state', () => {
    const tracker = new RateLimitTracker();

    track(tracker, 'gemini-3-flash', 'quota exhausted');
    track(tracker, 'gemini-3-flash', 'quota exhausted');
    track(tracker, 'gemini-3-pro', 'quota exhausted');
    track(tracker, 'gemini-3-pro', 'quota exhausted');
    tracker.trackFromUpstreamError({
      accountId: 'account-2',
      status: 429,
      body: 'quota exhausted',
      model: 'gemini-3-flash',
      backoffSteps: [60, 120, 300],
    });

    tracker.markModelSuccess('account-1', 'models/gemini-3-flash');

    expect(track(tracker, 'gemini-3-flash', 'quota exhausted')).toMatchObject({
      retryAfterSec: 60,
    });
    expect(track(tracker, 'gemini-3-pro', 'quota exhausted')).toMatchObject({
      retryAfterSec: 300,
    });
    expect(
      tracker.trackFromUpstreamError({
        accountId: 'account-2',
        status: 429,
        body: 'quota exhausted',
        model: 'gemini-3-flash',
        backoffSteps: [60, 120, 300],
      }),
    ).toMatchObject({ retryAfterSec: 120 });
  });

  it('parses bounded RetryInfo retryDelay values and rejects malformed durations', () => {
    expect(
      parseRetryDelayMilliseconds(
        '{"error":{"details":[{"retryDelay":"1500ms"}]}}',
      ),
    ).toBe(1500);
    expect(
      parseRetryDelayMilliseconds(
        '{"error":{"details":[{"retryDelay":{"seconds":1,"nanos":500000000}}]}}',
      ),
    ).toBe(1500);
    expect(
      parseRetryDelayMilliseconds(
        '{"error":{"details":[{"retryDelay":"999h"}]}}',
      ),
    ).toBe(24 * 60 * 60 * 1000);
    expect(
      parseRetryDelayMilliseconds(
        '{"error":{"details":[{"retryDelay":{"seconds":1,"nanos":-1}}]}}',
      ),
    ).toBeNull();
    expect(
      parseRetryDelayMilliseconds(
        '{"error":{"details":[{"retryDelay":{"seconds":1,"nanos":1000000000}}]}}',
      ),
    ).toBeNull();
  });
});
