import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG = '77777777-7777-4777-8777-777777777777';
const SITE_A = '5a000000-0000-4000-8000-00000000000a';

const h = vi.hoisted(() => ({ queue: [] as unknown[][], updates: 0, reaches: vi.fn() }));
vi.mock('../../db', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'set', 'returning']) builder[m] = () => builder;
  builder.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(h.queue.shift() ?? []).then(res, rej);
  return {
    db: {
      select: () => builder,
      update: () => { h.updates += 1; return builder; },
    },
  };
});
vi.mock('./history', () => ({ messageReachesAllowedSites: h.reaches }));
vi.mock('../commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('../commandOfflinePolicy', () => ({ deliveryTtlMs: () => 1000 }));
vi.mock('../commandMinVersion', () => ({ agentSupportsRetract: () => true }));

import { retractEndpointMessage } from './retract';

const auth = {
  user: { id: 'u1' }, orgCondition: () => undefined, canAccessOrg: (id: string) => id === ORG,
} as never;
const message = { id: MSG, orgId: ORG, clientMessageId: 'c1', expiresAt: new Date(Date.now() + 60_000), retractedAt: null };

describe('retractEndpointMessage site scope (#9014)', () => {
  beforeEach(() => { h.queue = []; h.updates = 0; h.reaches.mockReset(); });

  it('404s (not_found), touching nothing, when no delivery is in the caller sites — even if none are live', async () => {
    // All deliveries out of scope and already terminal => the old "live devices all in my sites"
    // check was vacuously true and would have stamped the message retracted.
    h.queue = [[message], []];
    h.reaches.mockResolvedValue(false);
    const out = await retractEndpointMessage({ auth, permissions: { allowedSiteIds: [SITE_A] }, messageRowId: MSG });
    expect(out).toEqual({ kind: 'not_found' });
    expect(h.reaches).toHaveBeenCalledWith(MSG, { allowedSiteIds: [SITE_A] });
    expect(h.updates).toBe(0);
  });

  it('with an in-scope delivery and no live out-of-scope device, retracts', async () => {
    h.queue = [[message], []];
    h.reaches.mockResolvedValue(true);
    const out = await retractEndpointMessage({ auth, permissions: { allowedSiteIds: [SITE_A] }, messageRowId: MSG });
    expect(out).toMatchObject({ kind: 'ok', id: MSG, alreadyRetracted: false });
    expect(h.updates).toBe(1);
  });

  it('unrestricted caller never probes', async () => {
    h.queue = [[message], []];
    h.reaches.mockResolvedValue(true);
    const out = await retractEndpointMessage({ auth, messageRowId: MSG });
    expect(out.kind).toBe('ok');
  });
});
