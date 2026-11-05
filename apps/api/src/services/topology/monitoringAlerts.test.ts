import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TopologyPolicyDefinition } from '@breeze/shared';
import { openTopologyPolicyAlert } from './monitoringAlerts';

const mocks = vi.hoisted(() => ({ insert: vi.fn(), alertValues: vi.fn() }));
vi.mock('../../db', () => ({
  db: { insert: mocks.insert },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../eventBus', () => ({ publishEvent: vi.fn() }));

const ids = {
  org: '00000000-0000-4000-8000-000000000001', site: '00000000-0000-4000-8000-000000000002',
  policy: '00000000-0000-4000-8000-000000000003', device: '00000000-0000-4000-8000-000000000004',
  iface: '00000000-0000-4000-8000-000000000005', alert: '00000000-0000-4000-8000-000000000006',
};

function baseInput() {
  return {
    scope: { orgId: ids.org, siteId: ids.site },
    policy: { id: ids.policy, key: 'wan-dns', definition: { recipeId: 'dns_resolution' } as unknown as TopologyPolicyDefinition },
    contextKey: 'default', family: 'ipv4' as const, occurrenceKey: 'occ-1', originDeviceId: ids.device,
    runId: 'run-1', consecutiveFailures: 3, notify: true, now: new Date('2026-10-01T00:00:00Z'),
  };
}

async function openAndGetContext(extra: { interfaceId?: string | null; interfaceEpoch?: string | null }) {
  await openTopologyPolicyAlert({ ...baseInput(), ...extra });
  const [values] = mocks.alertValues.mock.calls[0]!;
  return values.context as Record<string, unknown>;
}

describe('openTopologyPolicyAlert interface provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insert.mockImplementation(() => ({
      values: (v: Record<string, unknown>) => {
        // The first insert is the alert; the second is the outbox transition.
        if (mocks.alertValues.mock.calls.length === 0) mocks.alertValues(v);
        const chain = { onConflictDoNothing: () => ({ returning: async () => [{ id: ids.alert }], then: (r: (x: unknown) => void) => r(undefined) }) };
        return chain;
      },
    }));
  });

  it('copies the origin interface into context when present', async () => {
    const context = await openAndGetContext({ interfaceId: ids.iface, interfaceEpoch: 'gen:2' });
    expect(context.interface).toEqual({ interfaceId: ids.iface, interfaceEpoch: 'gen:2', basis: 'origin' });
  });

  it('omits the interface key for a null interface (ECMP)', async () => {
    const context = await openAndGetContext({ interfaceId: null, interfaceEpoch: null });
    expect('interface' in context).toBe(false);
  });

  it('omits the interface key when the fields are not supplied', async () => {
    const context = await openAndGetContext({});
    expect('interface' in context).toBe(false);
  });

  it('keeps the existing context keys unchanged', async () => {
    const context = await openAndGetContext({ interfaceId: ids.iface, interfaceEpoch: 'gen:2' });
    const { interface: _interface, ...rest } = context;
    expect(rest).toEqual({
      source: 'topology_monitoring', policyId: ids.policy, policyKey: 'wan-dns', contextKey: 'default', family: 'ipv4',
      runId: 'run-1', occurrenceKey: 'occ-1', consecutiveFailures: 3,
    });
  });
});
