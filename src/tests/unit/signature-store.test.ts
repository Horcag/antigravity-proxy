import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

const key = (toolCallId: string) => ({ accountId: 'account-a', model: 'gemini-3-flash', toolCallId });

afterEach(() => {
  SignatureStore.clear();
  SignatureStore.resetConfig();
  vi.useRealTimers();
});

describe('SignatureStore', () => {
  it('touches LRU recency on get without extending the original TTL', () => {
    vi.useFakeTimers();
    SignatureStore.configure({ maxEntries: 2, ttlMs: 100 });
    SignatureStore.store(key('first'), 'first-signature');
    vi.advanceTimersByTime(10);
    SignatureStore.store(key('second'), 'second-signature');

    expect(SignatureStore.get(key('first'))).toBe('first-signature');
    SignatureStore.store(key('third'), 'third-signature');
    expect(SignatureStore.get(key('second'))).toBeNull();
    expect(SignatureStore.get(key('first'))).toBe('first-signature');

    vi.advanceTimersByTime(90);
    expect(SignatureStore.get(key('first'))).toBeNull();
  });
});
