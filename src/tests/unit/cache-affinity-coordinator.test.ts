import { describe, expect, it, vi } from 'vitest';
import { authorizesMigration, CacheAffinityCoordinator } from '@/modules/proxy-gateway/server/cache-affinity-coordinator';

describe('CacheAffinityCoordinator', () => {
  it('requires the exact request owner for migration authorization', () => {
    const authorization = { reason: 'account-cooldown' as const, sessionKey: 'session:owner', expectedGeneration: 1, expectedTableIncarnation: 1, ownerRequestId: 'owner-a' };
    const binding = { generation: 1, tableIncarnation: 1 };
    expect(authorizesMigration(authorization, authorization.sessionKey, binding, undefined)).toBe(false);
    expect(authorizesMigration(authorization, authorization.sessionKey, binding, 'owner-b')).toBe(false);
    expect(authorizesMigration(authorization, authorization.sessionKey, binding, 'owner-a')).toBe(true);
  });
  it('allows one owner and wakes followers only after the owner commits', async () => {
    const coordinator = new CacheAffinityCoordinator();
    const owner = await coordinator.acquire('openai:conversation-1');
    const followerPromise = coordinator.acquire('openai:conversation-1');

    expect(owner.kind).toBe('owner');
    if (owner.kind !== 'owner') throw new Error('expected placement owner');
    expect(coordinator.getStateForTesting()).toEqual({ owners: 1, waiters: 1 });

    owner.complete('committed');

    await expect(followerPromise).resolves.toMatchObject({ kind: 'follower', outcome: 'committed' });
    expect(coordinator.getStateForTesting()).toEqual({ owners: 0, waiters: 0 });
  });

  it('rejects queue overflow and cleans cancelled or timed out followers', async () => {
    vi.useFakeTimers();
    const coordinator = new CacheAffinityCoordinator({
      maxWaitersPerSession: 1,
      ownerTimeoutMs: 50,
      waitTimeoutMs: 25,
    });
    const owner = await coordinator.acquire('openai:conversation-2');
    if (owner.kind !== 'owner') throw new Error('expected placement owner');
    const abortController = new AbortController();
    const cancelledFollower = coordinator.acquire('openai:conversation-2', {
      signal: abortController.signal,
    });

    await expect(coordinator.acquire('openai:conversation-2')).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'queue-full',
    });

    abortController.abort();
    await expect(cancelledFollower).resolves.toMatchObject({ kind: 'rejected', reason: 'cancelled' });
    expect(coordinator.getStateForTesting()).toEqual({ owners: 1, waiters: 0 });

    const timedOutFollower = coordinator.acquire('openai:conversation-2');
    await vi.advanceTimersByTimeAsync(26);
    await expect(timedOutFollower).resolves.toMatchObject({ kind: 'rejected', reason: 'timeout' });

    owner.complete('aborted');
    expect(coordinator.getStateForTesting()).toEqual({ owners: 0, waiters: 0 });
    vi.useRealTimers();
  });

  it('bounds distinct owner sessions and frees capacity when an owner aborts', async () => {
    const coordinator = new CacheAffinityCoordinator({ maxOwners: 2 });
    const ownerAbort = new AbortController();
    const first = await coordinator.acquire('openai:conversation-owner-1', { signal: ownerAbort.signal });
    const second = await coordinator.acquire('openai:conversation-owner-2');

    expect(first.kind).toBe('owner');
    expect(second.kind).toBe('owner');
    await expect(coordinator.acquire('openai:conversation-owner-3')).resolves.toMatchObject({
      kind: 'rejected', reason: 'queue-full',
    });
    ownerAbort.abort();
    expect(coordinator.getStateForTesting()).toEqual({ owners: 1, waiters: 0 });
    const replacement = await coordinator.acquire('openai:conversation-owner-3');
    expect(replacement).toMatchObject({ kind: 'owner' });

    if (second.kind === 'owner') second.complete('aborted');
    if (replacement.kind === 'owner') replacement.complete('aborted');
    expect(coordinator.getStateForTesting()).toEqual({ owners: 0, waiters: 0 });
  });

  it('times out an owner, wakes followers as aborted, and cleans its session entry', async () => {
    vi.useFakeTimers();
    const coordinator = new CacheAffinityCoordinator({ ownerTimeoutMs: 25, waitTimeoutMs: 100 });
    const owner = await coordinator.acquire('openai:conversation-owner-timeout');
    const follower = coordinator.acquire('openai:conversation-owner-timeout');

    expect(owner.kind).toBe('owner');
    expect(coordinator.getStateForTesting()).toEqual({ owners: 1, waiters: 1 });
    await vi.advanceTimersByTimeAsync(26);

    await expect(follower).resolves.toMatchObject({ kind: 'follower', outcome: 'aborted' });
    expect(coordinator.getStateForTesting()).toEqual({ owners: 0, waiters: 0 });
    vi.useRealTimers();
  });

  it('cancels the timed-out owner before it releases the placement fence', async () => {
    vi.useFakeTimers();
    const coordinator = new CacheAffinityCoordinator({ ownerTimeoutMs: 25 });
    const owner = await coordinator.acquire('openai:conversation-fenced-timeout');
    if (owner.kind !== 'owner') throw new Error('expected placement owner');
    const cancelled = vi.fn(() => {
      expect(coordinator.getStateForTesting()).toEqual({ owners: 1, waiters: 0 });
    });
    owner.signal.addEventListener('abort', cancelled, { once: true });

    await vi.advanceTimersByTimeAsync(26);

    expect(cancelled).toHaveBeenCalledOnce();
    expect(owner.signal.aborted).toBe(true);
    expect(coordinator.getStateForTesting()).toEqual({ owners: 0, waiters: 0 });
    vi.useRealTimers();
  });
});
