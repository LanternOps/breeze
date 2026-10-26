import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Concern, WispHomePayload } from '@breeze/shared';

const h = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: h.fetchWithAuth }));

import { briefAge, emptyStateFor, fetchWispHome, fetchWispPartnerEnabled, homeSectionFromHash, needsYouOrder } from './wispHome';

const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const concern = (id: string, severity: Concern['severity'], approvalIntentId: string | null = null) =>
  ({ id, severity, approvalIntentId }) as unknown as Concern;

const homePayload = (over: Partial<WispHomePayload> = {}): WispHomePayload => ({
  thread: { id: 'th-1', grantId: 'g-1', summary: 'Watching Acme', summaryUpdatedAt: null, lastSessionId: null, focusOrgId: null, createdAt: '2026-10-24T08:00:00Z', updatedAt: '2026-10-24T08:00:00Z' },
  focusOrgName: null,
  grant: { id: 'g-1', status: 'active', orgId: null, expiresAt: '2026-11-24T08:00:00Z', currentRevisionId: 'r-1', budgetCentsPerDay: 200, floorTickMinutes: 30, spentTodayCents: 12, budgetResetsAt: '2026-10-25T00:00:00Z', pausedReason: null },
  wideningAvailable: false,
  brief: null,
  needsYou: [],
  activity: { items: [], nextCursor: null },
  current: null,
  links: [],
  partner: { enabled: true },
  ...over,
});

describe('wispHome helpers (W08 Task 9)', () => {
  beforeEach(() => h.fetchWithAuth.mockReset());

  it('homeSectionFromHash maps section fragments and #concern= deep links', () => {
    expect(homeSectionFromHash('#needs-you')).toBe('needs-you');
    expect(homeSectionFromHash('#brief')).toBe('brief');
    expect(homeSectionFromHash('#activity')).toBe('activity');
    expect(homeSectionFromHash('#links')).toBe('links');
    expect(homeSectionFromHash('#thread')).toBe('thread');
    expect(homeSectionFromHash('#concern=abc')).toBe('needs-you');
    expect(homeSectionFromHash('')).toBeNull();
    expect(homeSectionFromHash('#session=abc')).toBeNull();
  });

  it('needsYouOrder puts approvals first, then severity high → info, stable within ties', () => {
    const ordered = needsYouOrder([
      concern('low', 'low'),
      concern('high-1', 'high'),
      concern('info-approval', 'info', 'ai-1'),
      concern('high-2', 'high'),
      concern('medium-approval', 'medium', 'ai-2'),
    ]);
    expect(ordered.map((c) => c.id)).toEqual(['medium-approval', 'info-approval', 'high-1', 'high-2', 'low']);
  });

  it('briefAge: fresh within 20 h, stale after, null for a bad date', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(briefAge('2026-10-24T07:00:00Z', now)).toBe('fresh');
    expect(briefAge('2026-10-23T07:00:00Z', now)).toBe('stale');
    expect(briefAge('not a date', now)).toBeNull();
  });

  it('emptyStateFor flags each empty section', () => {
    expect(emptyStateFor(homePayload())).toEqual({ brief: true, needsYou: true, activity: true, links: true });
    const full = homePayload({
      brief: { sentAt: '2026-10-24T07:00:00Z', sections: [{ heading: 'Overnight', lines: ['2 alerts'] }] },
      needsYou: [concern('c', 'high')],
      activity: { items: [{ id: 'a' } as never], nextCursor: null },
      links: [{ id: 'l' } as never],
    });
    expect(emptyStateFor(full)).toEqual({ brief: false, needsYou: false, activity: false, links: false });
    // A brief with no sections is as good as none.
    expect(emptyStateFor(homePayload({ brief: { sentAt: '2026-10-24T07:00:00Z', sections: [] } })).brief).toBe(true);
  });

  it('fetchWispHome: 200 → ready with the panel Wisp state; grant-addressed (no ambient orgId)', async () => {
    h.fetchWithAuth.mockResolvedValue(res(200, { data: homePayload() }));
    const out = await fetchWispHome();
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/home', { skipOrgIdInjection: true });
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') return;
    expect(out.wisp).toMatchObject({ grantId: 'g-1', threadId: 'th-1', status: 'active', spentTodayCents: 12, pausedReason: null });
    expect(out.payload.partner.enabled).toBe(true);
  });

  it('fetchWispHome: 404 no_grant → noGrant; 403 entitlement_required → locked; other failures throw', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(res(404, { code: 'no_grant' }));
    expect(await fetchWispHome()).toEqual({ kind: 'noGrant' });
    h.fetchWithAuth.mockResolvedValueOnce(res(403, { code: 'entitlement_required' }));
    expect(await fetchWispHome()).toEqual({ kind: 'locked' });
    h.fetchWithAuth.mockResolvedValueOnce(res(500, { error: 'boom' }));
    await expect(fetchWispHome()).rejects.toThrow();
    h.fetchWithAuth.mockResolvedValueOnce(res(200, { data: { thread: {} } }));
    await expect(fetchWispHome()).rejects.toThrow(/malformed/);
  });

  it('fetchWispPartnerEnabled reads data.enabled and throws on a failed or malformed read', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(res(200, { data: { enabled: false } }));
    expect(await fetchWispPartnerEnabled()).toBe(false);
    expect(h.fetchWithAuth).toHaveBeenLastCalledWith('/wisp/partner-settings', { skipOrgIdInjection: true });
    h.fetchWithAuth.mockResolvedValueOnce(res(500, {}));
    await expect(fetchWispPartnerEnabled()).rejects.toThrow();
    h.fetchWithAuth.mockResolvedValueOnce(res(200, { data: {} }));
    await expect(fetchWispPartnerEnabled()).rejects.toThrow();
  });
});
