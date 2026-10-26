import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Concern } from '@breeze/shared';
import type { GrantCeiling } from './grantAuthority';

const h = vi.hoisted(() => ({
  listConcernsForCeiling: vi.fn(),
  listActivity: vi.fn(),
  currentActivity: vi.fn(),
  listLinks: vi.fn(),
  getPartnerSettings: vi.fn(),
  briefRows: [] as unknown[],
  briefWhere: [] as unknown[],
}));

vi.mock('./concerns', () => ({ listConcernsForCeiling: h.listConcernsForCeiling }));
vi.mock('./activity', () => ({ listActivity: h.listActivity, currentActivity: h.currentActivity }));
vi.mock('./threadLinks', () => ({ listLinks: h.listLinks }));
vi.mock('./partnerSettings', () => ({ getPartnerSettings: h.getPartnerSettings }));
vi.mock('./grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inSystemContext: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'orderBy', 'limit']) chain[m] = () => chain;
  chain.where = (w: unknown) => { h.briefWhere.push(w); return chain; };
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(h.briefRows).then(res);
  return { db: { select: () => chain } };
});

const { buildHomeSections, needsYouOrder, BRIEF_MAX_AGE_HOURS } = await import('./home');

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ceiling = { grantId: 'g1', partnerId: 'p1', orgIds: new Set([ORG]), scopeOrgId: null, partnerWide: true, siteIds: null, permissionKeys: new Set(['*:*']), orgTerms: new Map(), toolAllowlist: null, deniedTools: new Set(), status: 'active' } as unknown as GrantCeiling;
const input = (over: Record<string, unknown> = {}) => ({
  auth: { user: { id: 'u1' } } as never, partnerId: 'p1', grantId: 'g1', grantorUserId: 'u1', threadId: 't1', ceiling, ...over,
});

const concern = (id: string, severity: Concern['severity'], approvalIntentId: string | null = null) =>
  ({ id, severity, approvalIntentId, status: 'open' }) as Concern;

beforeEach(() => {
  vi.clearAllMocks();
  h.briefRows = [];
  h.briefWhere = [];
  h.listConcernsForCeiling.mockResolvedValue([]);
  h.listActivity.mockResolvedValue({ items: [], nextCursor: null });
  h.currentActivity.mockResolvedValue(null);
  h.listLinks.mockResolvedValue([]);
  h.getPartnerSettings.mockResolvedValue({ enabled: true, urgentCapableSeverities: [] });
});

describe('needsYouOrder', () => {
  it('approvals first, then severity high → info, stable within a tier', () => {
    const ordered = needsYouOrder([
      concern('a', 'low'), concern('b', 'high'), concern('c', 'info', 'i1'), concern('d', 'high'), concern('e', 'medium', 'i2'),
    ]);
    expect(ordered.map((c) => c.id)).toEqual(['e', 'c', 'b', 'd', 'a']);
  });

  it('caps at 50', () => {
    expect(needsYouOrder(Array.from({ length: 70 }, (_, i) => concern(String(i), 'low')))).toHaveLength(50);
  });
});

describe('buildHomeSections', () => {
  it('every section populated', async () => {
    h.briefRows = [{ createdAt: new Date('2027-01-05T07:00:00Z'), metadata: { grantId: 'g1', brief: [{ heading: 'Overnight', lines: ['2 new tickets'] }] } }];
    h.listConcernsForCeiling.mockResolvedValue([concern('c1', 'high')]);
    h.listActivity.mockResolvedValue({ items: [{ id: 'x', kind: 'assessment', orgId: ORG }], nextCursor: 'n' });
    h.currentActivity.mockResolvedValue({ orgId: ORG, orgName: 'Acme', startedAt: '2027-01-05T08:00:00Z' });
    h.listLinks.mockResolvedValue([{ id: 'l1' }]);
    h.getPartnerSettings.mockResolvedValue({ enabled: false, urgentCapableSeverities: [] });

    const out = await buildHomeSections(input());
    expect(out).toEqual({
      brief: { sentAt: '2027-01-05T07:00:00.000Z', sections: [{ heading: 'Overnight', lines: ['2 new tickets'] }] },
      needsYou: [concern('c1', 'high')],
      activity: { items: [{ id: 'x', kind: 'assessment', orgId: ORG }], nextCursor: 'n' },
      current: { orgId: ORG, orgName: 'Acme', startedAt: '2027-01-05T08:00:00Z' },
      links: [{ id: 'l1' }],
      partner: { enabled: false },
    });
    expect(h.listConcernsForCeiling).toHaveBeenCalledWith(ceiling, { status: ['open', 'snoozed'] });
    expect(h.listActivity).toHaveBeenCalledWith(ceiling, { limit: 20, threadId: 't1' });
    expect(h.listLinks).toHaveBeenCalledWith({ auth: input().auth, ceiling }, 't1');
  });

  it('every section empty', async () => {
    expect(await buildHomeSections(input())).toEqual({
      brief: null, needsYou: [], activity: { items: [], nextCursor: null }, current: null, links: [], partner: { enabled: true },
    });
  });

  it('a paused/ended grant (no ceiling) shows brief + partner only; no ceiling-bound read runs', async () => {
    h.briefRows = [{ createdAt: new Date('2027-01-05T07:00:00Z'), metadata: { grantId: 'g1', brief: [] } }];
    const out = await buildHomeSections(input({ ceiling: null }));
    expect(out.needsYou).toEqual([]);
    expect(out.links).toEqual([]);
    expect(out.current).toBeNull();
    expect(out.brief).toEqual({ sentAt: '2027-01-05T07:00:00.000Z', sections: [] });
    for (const fn of [h.listConcernsForCeiling, h.listActivity, h.currentActivity, h.listLinks]) expect(fn).not.toHaveBeenCalled();
  });

  it('the live line is dropped when its org left the ceiling', async () => {
    h.currentActivity.mockResolvedValue({ orgId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', orgName: 'Gone', startedAt: 'x' });
    expect((await buildHomeSections(input())).current).toBeNull();
  });

  it('a brief row with a malformed metadata.brief renders no sections rather than failing', async () => {
    h.briefRows = [{ createdAt: new Date('2027-01-05T07:00:00Z'), metadata: { grantId: 'g1', brief: 'nope' } }];
    expect((await buildHomeSections(input())).brief).toEqual({ sentAt: '2027-01-05T07:00:00.000Z', sections: [] });
  });

  it('reads briefs from the last 36 h only', () => {
    expect(BRIEF_MAX_AGE_HOURS).toBe(36);
  });
});
