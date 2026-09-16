import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured: { sets: Record<string, unknown>[]; wheres: unknown[] } = { sets: [], wheres: [] };
let updateReturning: unknown[] = [];

vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured.sets.push(values);
        return {
          where: (condition: unknown) => {
            captured.wheres.push(condition);
            return { returning: () => Promise.resolve(updateReturning) };
          },
        };
      },
    }),
  },
}));

import {
  buildProbeCommandId,
  parseProbeCommandId,
  awaitProbeResult,
  applyProbeResult,
} from './assetProbe';

const ASSET = '33333333-3333-4333-8333-333333333333';

beforeEach(() => { captured.sets = []; captured.wheres = []; updateReturning = []; });

describe('probe command ids', () => {
  it('round-trips the asset id', () => {
    const id = buildProbeCommandId(ASSET);
    expect(id.startsWith(`probe-${ASSET}-`)).toBe(true);
    expect(parseProbeCommandId(id)).toBe(ASSET);
  });

  it('rejects ids that are not probes', () => {
    expect(parseProbeCommandId('snmp-abc-123')).toBeNull();
    expect(parseProbeCommandId(`mon-${ASSET}-1`)).toBeNull();
    expect(parseProbeCommandId('probe-not-a-uuid-1')).toBeNull();
    expect(parseProbeCommandId(`probe-${ASSET}`)).toBeNull();
  });

  it('never collides with the software-install id shape', () => {
    expect(parseProbeCommandId('sw-install-a-b-0')).toBeNull();
  });
});

describe('applyProbeResult', () => {
  const base = {
    commandId: buildProbeCommandId(ASSET),
    assetId: ASSET,
    expectedIp: '10.0.0.5',
    expectedSiteId: '44444444-4444-4444-8444-444444444444',
    status: 'ok' as const,
    responseMs: 4,
    error: null,
  };

  it('writes the outcome and reports true when the CAS matches', async () => {
    updateReturning = [{ id: ASSET }];
    await expect(applyProbeResult(base)).resolves.toBe(true);
    expect(captured.sets[0]).toMatchObject({ lastProbeStatus: 'ok', lastProbeResponseMs: 4 });
  });

  it('reports false and writes nothing durable when the asset moved', async () => {
    updateReturning = [];
    await expect(applyProbeResult({ ...base, expectedSiteId: 'other-site' })).resolves.toBe(false);
  });

  it('resolves a waiting awaitProbeResult with the outcome', async () => {
    updateReturning = [{ id: ASSET }];
    const waiting = awaitProbeResult(base.commandId, 1_000);
    await applyProbeResult(base);
    await expect(waiting).resolves.toEqual({ status: 'ok', responseMs: 4, error: null });
  });

  it('does NOT resolve the waiter when the CAS rejected the result', async () => {
    updateReturning = [];
    const waiting = awaitProbeResult(base.commandId, 60);
    await applyProbeResult(base);
    await expect(waiting).resolves.toBeNull();
  });
});

describe('awaitProbeResult', () => {
  it('resolves null on timeout and leaves no registry entry behind', async () => {
    await expect(awaitProbeResult('probe-nobody-1', 20)).resolves.toBeNull();
    // A second wait on the same id must not see a stale resolver.
    await expect(awaitProbeResult('probe-nobody-1', 20)).resolves.toBeNull();
  });
});
