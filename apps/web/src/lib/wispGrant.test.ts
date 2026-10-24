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
