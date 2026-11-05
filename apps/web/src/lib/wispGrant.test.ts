import { describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { wispStateFromThread } from './wispGrant';

const body = (grant: Record<string, unknown> = {}) => ({
  data: {
    thread: { id: 't1', summary: 'All quiet.', focusOrgId: null },
    grant: { id: 'g1', status: 'active', orgId: null, expiresAt: '2027-01-17T00:00:00.000Z', budgetCentsPerDay: 200, floorTickMinutes: 30, ...grant },
  },
});

describe('wispStateFromThread W06 fields (A32 spend, A29 pause reason)', () => {
  it('carries the spend meter only when both halves are present', () => {
    expect(wispStateFromThread(body({ spentTodayCents: 42, budgetResetsAt: '2026-10-25T00:00:00.000Z' })))
      .toMatchObject({ spentTodayCents: 42, budgetResetsAt: '2026-10-25T00:00:00.000Z' });
    const half = wispStateFromThread(body({ spentTodayCents: 42 }))!;
    expect('spentTodayCents' in half).toBe(false);
  });
  it('leaves pausedReason unknown when the payload omits it, and reads it when present', () => {
    expect('pausedReason' in wispStateFromThread(body({ status: 'paused' }))!).toBe(false);
    expect(wispStateFromThread(body({ status: 'paused', pausedReason: 'user_paused' }))!.pausedReason).toBe('user_paused');
    expect(wispStateFromThread(body({ pausedReason: null }))!.pausedReason).toBeNull();
  });
});

// Partner-wide scope (orgId null) must reach the server WITHOUT the switcher's
// ambient `?orgId=`: `/wisp/thread` and `/wisp/grants/preview` resolve the grant
// by exact scope, so an injected org turns a partner-wide read into a 404
// `no_active_grant` and mints the step-up against an org-scoped ceiling hash the
// partner-wide POST /wisp/grants then refuses (STEP_UP_REQUIRED, forever).
describe('wispGrant owns its org scoping (no ambient orgId injection)', () => {
  const res = (body: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

  it('fetchWispThread(null) skips injection; fetchWispThread(org) names the org in the URL and still skips injection', async () => {
    const { fetchWithAuth } = await import('@/stores/auth');
    const { fetchWispThread } = await import('./wispGrant');
    vi.mocked(fetchWithAuth).mockResolvedValue(res(body()));
    await fetchWispThread(null);
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/wisp/thread', { skipOrgIdInjection: true });
    await fetchWispThread('org-1');
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/wisp/thread?orgId=org-1', { skipOrgIdInjection: true });
  });

  it('fetchWispThread: no grant for the scope (200 { data: null }, or a pre-#10200 404 no_active_grant) rejects as isNoActiveGrant (#10200)', async () => {
    const { fetchWithAuth } = await import('@/stores/auth');
    const { fetchWispThread, isNoActiveGrant } = await import('./wispGrant');
    const outcome = (p: Promise<unknown>) => p.then(() => 'resolved', (err: unknown) => (isNoActiveGrant(err) ? 'noGrant' : 'failed'));
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(res({ data: null }));
    expect(await outcome(fetchWispThread('org-1'))).toBe('noGrant');
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(res({ code: 'no_active_grant', error: 'none' }, 404));
    expect(await outcome(fetchWispThread('org-1'))).toBe('noGrant');
    // A bare 404 (Wisp switched off at the hub), an unreadable 200 and a 500 are failures.
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(res({ error: 'Not found' }, 404));
    expect(await outcome(fetchWispThread('org-1'))).toBe('failed');
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(res({ data: { thread: {} } }));
    expect(await outcome(fetchWispThread('org-1'))).toBe('failed');
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(res({ code: 'no_active_grant' }, 500));
    expect(await outcome(fetchWispThread('org-1'))).toBe('failed');
  });

  it('mintWispGrantStepUp({ orgId: null }) previews the partner-wide ceiling without the ambient org', async () => {
    vi.doMock('./mfaStepUp', () => ({ mintStepUpGrant: vi.fn(async () => 'su-1') }));
    vi.resetModules();
    const { fetchWithAuth } = await import('@/stores/auth');
    const { mintWispGrantStepUp } = await import('./wispGrant');
    vi.mocked(fetchWithAuth).mockResolvedValue(res({ scope: {}, ceilingSnapshot: {}, ceilingHash: 'h1' }));
    await mintWispGrantStepUp({ partnerId: 'p-1', orgId: null, reauth: { method: 'totp', code: '000000' } as never });
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/wisp/grants/preview', { skipOrgIdInjection: true });
    vi.doUnmock('./mfaStepUp');
  });
});
