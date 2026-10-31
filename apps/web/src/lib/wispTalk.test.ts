import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetchWispThread: vi.fn() }));
vi.mock('./wispGrant', () => ({
  fetchWispThread: h.fetchWispThread,
  isNoActiveGrant: (error: unknown) => error instanceof Error && error.message === 'no_active_grant',
}));
import { activeThreadFor, resetWispTalkTargetCache } from './wispTalk';
import { runLogoutHooks } from '@/stores/logoutHooks';

beforeEach(() => { vi.clearAllMocks(); resetWispTalkTargetCache(); });
describe('activeThreadFor', () => {
  it('shares one partner-wide-first full-state lookup per org', async () => {
    const grant = { status: 'active', threadId: 'thread-1', grantId: 'grant-1', scopeOrgId: null };
    h.fetchWispThread.mockResolvedValue(grant);
    const first = activeThreadFor('org-b');
    const second = activeThreadFor('org-b');
    expect(await first).toEqual(grant);
    expect(await second).toEqual(grant);
    expect(h.fetchWispThread).toHaveBeenCalledTimes(1);
    expect(h.fetchWispThread).toHaveBeenCalledWith(null);
  });
  it('falls through a paused partner grant to the record org', async () => {
    const active = { status: 'active', threadId: 'thread-org', grantId: 'grant-org' };
    h.fetchWispThread.mockResolvedValueOnce({ status: 'paused' }).mockResolvedValueOnce(active);
    expect(await activeThreadFor('org-b')).toEqual(active);
    expect(h.fetchWispThread.mock.calls).toEqual([[null], ['org-b']]);
  });
  it('returns null only on confirmed no-grant answers', async () => {
    h.fetchWispThread.mockRejectedValue(new Error('no_active_grant'));
    expect(await activeThreadFor('org-b')).toBeNull();
    expect(h.fetchWispThread).toHaveBeenCalledTimes(2);
  });
  it('evicts a failed lookup so a later mount retries', async () => {
    h.fetchWispThread.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ status: 'active', threadId: 'thread-1' });
    await expect(activeThreadFor(null)).rejects.toThrow('network');
    expect(await activeThreadFor(null)).toMatchObject({ threadId: 'thread-1' });
    expect(h.fetchWispThread).toHaveBeenCalledTimes(2);
  });
});


it('clears the full-state grant cache on logout before another user signs in', async () => {
  h.fetchWispThread.mockResolvedValueOnce({ status: 'active', threadId: 'thread-first' }).mockResolvedValueOnce({ status: 'active', threadId: 'thread-next' });
  expect(await activeThreadFor('org-b')).toMatchObject({ threadId: 'thread-first' });
  runLogoutHooks();
  expect(await activeThreadFor('org-b')).toMatchObject({ threadId: 'thread-next' });
  expect(h.fetchWispThread).toHaveBeenCalledTimes(2);
});
