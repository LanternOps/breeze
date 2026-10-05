import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the attestation step concludes about a result with no attestation
 * depends on what the device's helper reported it can do. A device that has
 * not reported (the stored protocol is NULL) is neither "capable" nor "an
 * older helper": it must not be filed as an older helper that never offers
 * attestations.
 */

const state = vi.hoisted(() => ({
  integrityVersion: null as number | null,
  updates: [] as Array<Record<string, unknown>>,
}));

function chain(rows: unknown[]) {
  const terminal = Promise.resolve(rows) as Promise<unknown[]> & {
    limit: () => Promise<unknown[]>;
    for: () => Promise<unknown[]>;
  };
  terminal.limit = async () => rows;
  terminal.for = async () => rows;
  return { from: () => ({ where: () => terminal }) };
}

vi.mock('../db', () => ({
  db: {
    select: (cols: Record<string, unknown>) => {
      const keys = Object.keys(cols);
      if (keys.includes('integrityVersion')) {
        return chain([{ agentId: 'agent-1', integrityVersion: state.integrityVersion }]);
      }
      if (keys.includes('integrityStatus')) return chain([{ integrityStatus: 'unattested_legacy' }]);
      if (keys.includes('statementSha256')) return chain([]);
      throw new Error(`unexpected select shape: ${JSON.stringify(keys)}`);
    },
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push(payload);
        },
      }),
    }),
  },
  hasDbAccessContext: () => false,
  withDbTransaction: <T>(fn: () => Promise<T>) => fn(),
  runAfterDbContextExit: vi.fn(),
}));

vi.mock('./auditService', () => ({ createAuditLogAsync: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

const { attestAgentResultSnapshot, evaluateSnapshotAttestation } = await import('./backupAttestation');

const PARAMS = {
  snapshotDbId: 'snap-row-1',
  orgId: 'org-1',
  jobId: 'job-1',
  deviceId: 'device-1',
  providerSnapshotId: 'snap-1',
  storageIdentity: 's3::https://storage.example::bucket-a',
  pinnedBaseProviderSnapshotId: null,
  dispatchExpectationVerified: true,
  resultReceivedAt: new Date('2026-10-05T00:00:00Z'),
  result: {},
};
const deps = { enqueueVerification: vi.fn(async () => undefined) };

describe('attestation step: helper integrity capability not reported', () => {
  beforeEach(() => {
    state.updates.length = 0;
    state.integrityVersion = null;
  });

  it('reports capability_unknown (not not_offered) for an unreported helper', () => {
    const base = {
      snapshotDbId: 'snap-row-1', orgId: 'org-1', jobId: 'job-1', deviceId: 'device-1',
      providerSnapshotId: 'snap-1', storageIdentity: 's3::x::y', pinnedBaseProviderSnapshotId: null,
      reportsLayout: false, reportsSystemState: false, referencedFiles: undefined,
      deviceAgentId: 'agent-1', acceptedVia: 'agent_result' as const,
      dispatchExpectationVerified: true, resultReceivedAt: new Date(), attestation: undefined,
    };
    expect(evaluateSnapshotAttestation({ ...base, deviceIntegrityProtocolVersion: null }))
      .toEqual({ kind: 'absent', outcome: 'capability_unknown' });
    expect(evaluateSnapshotAttestation({ ...base, deviceIntegrityProtocolVersion: 0 }))
      .toEqual({ kind: 'absent', outcome: 'not_offered' });
  });

  it('passes a NULL stored protocol through and marks the snapshot unattested', async () => {
    const outcome = await attestAgentResultSnapshot(PARAMS, deps);
    expect(outcome).toBe('capability_unknown');
    expect(state.updates).toContainEqual({ integrityStatus: 'unattested' });
  });

  it('still files a reported older helper as not_offered without touching the projection', async () => {
    state.integrityVersion = 0;
    const outcome = await attestAgentResultSnapshot(PARAMS, deps);
    expect(outcome).toBe('not_offered');
    expect(state.updates).toEqual([]);
  });

  it('still files a reported capable helper as missing_from_capable', async () => {
    state.integrityVersion = 1;
    const outcome = await attestAgentResultSnapshot(PARAMS, deps);
    expect(outcome).toBe('missing_from_capable');
    expect(state.updates).toContainEqual({ integrityStatus: 'unattested' });
  });
});
