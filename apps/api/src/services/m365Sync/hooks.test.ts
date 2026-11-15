import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    capture: vi.fn(),
    order: [] as string[],
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
  upsertPostureRollup: async (...args: unknown[]) => {
    mocks.depthAtRollup = mocks.depth; mocks.order.push('rollup'); return mocks.rollup(...args);
  },
}));
vi.mock('../portalDirectory/entraCapture', () => ({
  captureEntraDirectoryRun: async (...args: unknown[]) => { mocks.order.push('capture'); return mocks.capture(...args); },
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
  mocks.depth = 0; mocks.depthAtRollup = -1; mocks.depthAtLinks = -1; mocks.order = [];
  mocks.capture.mockResolvedValue({ recorded: false, reason: 'no_identities' });
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

describe('afterDomainPersisted — Entra directory capture (portal W8 D4)', () => {
  it('a users run calls the capture LAST, with the run\'s own fence facts', async () => {
    const ctx = hookCtx({ domain: 'users' });
    await afterDomainPersisted(ctx);
    expect(mocks.order).toEqual(['rollup', 'capture']);
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledWith({
      orgId: ORG, tenantId: TENANT, connectionId: 'c', generation: 3, now: ctx.now, persisted: PERSISTED,
    });
  });

  it('captures on every terminal users outcome — an incomplete run records `incomplete`', async () => {
    for (const outcome of ['partial', 'error', 'needs_consent']) {
      await afterDomainPersisted(hookCtx({ domain: 'users', outcome }));
    }
    expect(mocks.capture).toHaveBeenCalledTimes(3);
  });

  it('a capture throw does not skip the posture rollup and does not throw', async () => {
    mocks.capture.mockRejectedValueOnce(new Error('capture boom'));
    await expect(afterDomainPersisted(hookCtx({ domain: 'users' }))).resolves.toBeUndefined();
    expect(mocks.rollup).toHaveBeenCalledOnce();
  });

  it('a rollup failure still captures, then the rollup error surfaces', async () => {
    mocks.rollup.mockRejectedValueOnce(new Error('rollup boom'));
    await expect(afterDomainPersisted(hookCtx({ domain: 'users' }))).rejects.toThrow('rollup boom');
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.order).toEqual(['rollup', 'capture']);
  });

  it('other domains never capture', async () => {
    for (const domain of ['intune_devices', 'signin_activity', 'secure_score', 'skus', 'ca_policies', 'signin_events']) {
      await afterDomainPersisted(hookCtx({ domain }));
    }
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});

/**
 * The two facts the Entra capture's generation fence rests on (plan D4, Task 6
 * step 0). If either stops holding, the capture can read a cache that a newer
 * run is rewriting: stop and re-plan, never loosen these.
 */
describe('m365 sync generation fence facts (portal W8 D4)', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('claim increments run_generation, so a newer run never persists under the old generation', () => {
    expect(read('./claim.ts')).toMatch(/"run_generation" = t\."run_generation" \+ 1/);
  });

  it('the single completion writer is guarded on run_generation and stamps last_complete_snapshot_at = now', () => {
    const src = read('./run.ts');
    const start = src.indexOf('async function writeCompletion(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toContain('eq(m365SyncState.runGeneration, data.generation)');
    expect(body).toMatch(/args\.persisted\.complete \? \{ lastCompleteSnapshotAt: now \}/);
  });
});
