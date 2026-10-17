import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG = '77777777-7777-4777-8777-777777777777';
const SITE_A = '5a000000-0000-4000-8000-00000000000a';

// db.select() chain: every builder method returns the builder; awaiting it
// pops the next queued result, so the test pins the ORDER of queries too.
const h = vi.hoisted(() => ({ queue: [] as unknown[][], calls: 0 }));
vi.mock('../../db', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'groupBy']) builder[m] = () => builder;
  builder.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
    h.calls += 1;
    return Promise.resolve(h.queue.shift() ?? []).then(res, rej);
  };
  return { db: { select: () => builder } };
});

import { getEndpointMessageDetail, messageReachesAllowedSites } from './history';

const auth = { orgCondition: () => undefined, canAccessOrg: (id: string) => id === ORG };
const row = {
  id: MSG, orgId: ORG, batchId: 'b', title: 'Reboot', body: 'Secret body text', severity: 'info',
  requiresAck: false, createdBy: null, createdAt: new Date('2026-12-01T10:00:00Z'),
  expiresAt: new Date('2026-12-01T11:00:00Z'), retractedAt: null, bodyPurgedAt: null,
  aiInitiatorKind: null, resendOfId: null,
};
const delivery = {
  id: 'd1', deviceId: 'dev1', hostname: 'h', siteId: SITE_A, status: 'queued', surface: null, errorCode: null,
  deliveredAt: null, displayedAt: null, acknowledgedAt: null, dismissedAt: null, retractedAt: null,
};

describe('getEndpointMessageDetail site scope (#9014)', () => {
  beforeEach(() => { h.queue = []; h.calls = 0; });

  it('unrestricted caller: no site probe, full detail', async () => {
    h.queue = [[row], [delivery], []];
    const out = await getEndpointMessageDetail({ auth, messageRowId: MSG });
    expect(out?.body).toBe('Secret body text');
    expect(out?.deliveries).toHaveLength(1);
  });

  it('site-clamped caller with no in-scope delivery gets null (no body leak, no further reads)', async () => {
    h.queue = [[row], [] /* visibility probe: none */];
    const out = await getEndpointMessageDetail({ auth, permissions: { allowedSiteIds: [SITE_A] }, messageRowId: MSG });
    expect(out).toBeNull();
    expect(h.calls).toBe(2);
  });

  it('site-clamped caller with one in-scope delivery gets the detail', async () => {
    h.queue = [[row], [{ id: 'd1' }], [delivery], []];
    const out = await getEndpointMessageDetail({ auth, permissions: { allowedSiteIds: [SITE_A] }, messageRowId: MSG });
    expect(out?.id).toBe(MSG);
    expect(out?.deliveries.map((d) => d.siteId)).toEqual([SITE_A]);
  });

  it.each([[[]], [null], ['not-an-array']])('denies a degenerate allowlist %j without a probe query', async (allowed) => {
    h.queue = [[row], [{ id: 'would-leak' }]];
    const out = await getEndpointMessageDetail({ auth, permissions: { allowedSiteIds: allowed as never }, messageRowId: MSG });
    expect(out).toBeNull();
    expect(h.calls).toBe(1); // only the message-row read
  });
});

describe('messageReachesAllowedSites', () => {
  beforeEach(() => { h.queue = []; h.calls = 0; });

  it('true without a query when unrestricted', async () => {
    expect(await messageReachesAllowedSites(MSG, undefined)).toBe(true);
    expect(await messageReachesAllowedSites(MSG, { allowedSiteIds: undefined })).toBe(true);
    expect(h.calls).toBe(0);
  });
  it('false without a query for an empty/non-array allowlist', async () => {
    expect(await messageReachesAllowedSites(MSG, { allowedSiteIds: [] })).toBe(false);
    expect(await messageReachesAllowedSites(MSG, { allowedSiteIds: null as never })).toBe(false);
    expect(h.calls).toBe(0);
  });
  it('reflects whether a delivery is in the allowed sites', async () => {
    h.queue = [[{ id: 'd1' }]];
    expect(await messageReachesAllowedSites(MSG, { allowedSiteIds: [SITE_A] })).toBe(true);
    h.queue = [[]];
    expect(await messageReachesAllowedSites(MSG, { allowedSiteIds: [SITE_A] })).toBe(false);
  });
});
