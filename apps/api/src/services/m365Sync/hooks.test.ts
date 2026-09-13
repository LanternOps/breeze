import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    depth: 0,
    depthAtRollup: -1,
    depthAtLinks: -1,
    systemContext: vi.fn(),
    outside: vi.fn(),
    rollup: vi.fn(),
    links: vi.fn(),
    ambiguous: vi.fn(),
  },
}));

vi.mock('../../db', () => ({
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    mocks.systemContext();
    mocks.depth += 1;
    try { return await fn(); } finally { mocks.depth -= 1; }
  },
  runOutsideDbContext: (fn: () => unknown) => { mocks.outside(); return fn(); },
}));
vi.mock('./rollup', () => ({
  upsertPostureRollup: async (...args: unknown[]) => { mocks.depthAtRollup = mocks.depth; return mocks.rollup(...args); },
}));
vi.mock('./links', () => ({
  reconcileDeviceLinks: async (...args: unknown[]) => { mocks.depthAtLinks = mocks.depth; return mocks.links(...args); },
}));
vi.mock('./metrics', () => ({ recordM365SyncLinkAmbiguous: mocks.ambiguous }));

import { afterDomainPersisted } from './hooks';

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const PERSISTED = { inserted: 0, updated: 0, stale: 0, unchanged: 0, counts: {}, complete: true };

function hookCtx(over: Partial<{ domain: string; outcome: string }> = {}) {
  return {
    orgId: ORG, tenantId: TENANT, connectionId: 'c', generation: 3,
    existing: new Map(), now: new Date('2026-09-08T23:59:00.000Z'),
    domain: 'users', outcome: 'success', persisted: PERSISTED,
    ...over,
  } as Parameters<typeof afterDomainPersisted>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.depth = 0; mocks.depthAtRollup = -1; mocks.depthAtLinks = -1;
  mocks.rollup.mockResolvedValue(undefined);
  mocks.links.mockResolvedValue({ linkedBySerial: 0, linkedByHostname: 0, ambiguous: 0 });
});

describe('afterDomainPersisted (spec §5.6, §5.9)', () => {
  it('upserts the rollup for the run UTC day inside its OWN system context', async () => {
    await afterDomainPersisted(hookCtx());
    expect(mocks.outside).toHaveBeenCalled();
    expect(mocks.systemContext).toHaveBeenCalledOnce();
    expect(mocks.rollup).toHaveBeenCalledWith(ORG, TENANT, '2026-09-08');
    expect(mocks.depthAtRollup).toBe(1);
  });

  it('refreshes the rollup on every outcome — a needs_consent run still changes freshness', async () => {
    await afterDomainPersisted(hookCtx({ outcome: 'needs_consent' }));
    expect(mocks.rollup).toHaveBeenCalledOnce();
  });

  it('reconciles device links only for a persisted intune_devices run', async () => {
    await afterDomainPersisted(hookCtx({ domain: 'users' }));
    expect(mocks.links).not.toHaveBeenCalled();

    await afterDomainPersisted(hookCtx({ domain: 'intune_devices', outcome: 'error' }));
    expect(mocks.links).not.toHaveBeenCalled();

    await afterDomainPersisted(hookCtx({ domain: 'intune_devices', outcome: 'partial' }));
    expect(mocks.links).toHaveBeenCalledWith(ORG);
    expect(mocks.depthAtLinks).toBe(1);
  });

  it('reports ambiguity with ONE numeric argument (no org label) and only when there is some', async () => {
    mocks.links.mockResolvedValueOnce({ linkedBySerial: 2, linkedByHostname: 1, ambiguous: 3 });
    await afterDomainPersisted(hookCtx({ domain: 'intune_devices' }));
    expect(mocks.ambiguous).toHaveBeenCalledWith(3);

    mocks.ambiguous.mockClear();
    await afterDomainPersisted(hookCtx({ domain: 'intune_devices' }));
    expect(mocks.ambiguous).not.toHaveBeenCalled();
  });

  it('surfaces BOTH errors when the link pass and the rollup both fail', async () => {
    mocks.links.mockRejectedValueOnce(new Error('links boom'));
    mocks.rollup.mockRejectedValueOnce(new Error('rollup boom'));
    const error = await afterDomainPersisted(hookCtx({ domain: 'intune_devices' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual(['links boom', 'rollup boom']);
  });

  it('a link failure does not stop the rollup, and the failure still surfaces', async () => {
    mocks.links.mockRejectedValueOnce(new Error('links boom'));
    await expect(afterDomainPersisted(hookCtx({ domain: 'intune_devices' }))).rejects.toThrow('links boom');
    expect(mocks.rollup).toHaveBeenCalledOnce();
  });
});
