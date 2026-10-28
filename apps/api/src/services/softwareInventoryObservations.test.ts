import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacySoftwareInventoryReport, SoftwareInventoryObservationV2 } from '@breeze/shared';

// Hoisted so the `vi.mock` factories below (themselves hoisted above these
// imports by Vitest) can close over them. Only `ingestSoftwareInventoryReport`
// touches these — `decideSoftwareInventoryAcceptance` and
// `replaceSoftwareInventoryProjection` take a `tx` argument directly and never
// reach the module-level `db` import, so mocking it here doesn't affect them.
const { transactionMock, tightenLockTimeoutMock, captureMessageMock, requestDeviceGroupReevaluationAfterCommitMock } = vi.hoisted(() => ({
  requestDeviceGroupReevaluationAfterCommitMock: vi.fn(),
  transactionMock: vi.fn(),
  tightenLockTimeoutMock: vi.fn(async () => null),
  captureMessageMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { transaction: transactionMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('../db/lockTimeout', () => ({
  tightenLockTimeout: tightenLockTimeoutMock,
}));

vi.mock('../jobs/deviceGroupJobs', () => ({
  requestDeviceGroupReevaluationAfterCommit: requestDeviceGroupReevaluationAfterCommitMock,
}));

beforeEach(() => requestDeviceGroupReevaluationAfterCommitMock.mockReset());

vi.mock('./sentry', () => ({ captureMessage: captureMessageMock }));

import {
  decideSoftwareInventoryAcceptance,
  replaceSoftwareInventoryProjection,
  ingestSoftwareInventoryReport,
  INVENTORY_LOCK_TIMEOUT_MS,
  SoftwareInventoryLockTimeoutError,
} from './softwareInventoryObservations';

const item = { name: 'Google Chrome', version: '127', vendor: 'Google LLC' };
const receivedAt = new Date('2026-08-24T12:00:00.000Z');

function v2(overrides: Partial<SoftwareInventoryObservationV2> = {}): SoftwareInventoryObservationV2 {
  return {
    schemaVersion: 2,
    observationId: '11111111-1111-4111-8111-111111111111',
    collectorVersion: '0.105.1',
    observedAt: '2026-08-24T11:59:00.000Z',
    completeness: 'complete',
    expectedSources: ['windows:registry:hklm64'],
    succeededSources: ['windows:registry:hklm64'],
    failedSources: [],
    truncated: false,
    itemCount: 1,
    items: [item],
    ...overrides,
  };
}

const emptyState = {
  latestReceivedAt: null,
  latestObservationId: null,
  hasAcceptedV2: false,
  visibleItemCount: 0,
  latestAcceptedExpectedSources: null,
};

describe('decideSoftwareInventoryAcceptance', () => {
  it('accepts a nonempty legacy projection before v2', () => {
    expect(decideSoftwareInventoryAcceptance({ report: { software: [item] }, state: emptyState, receivedAt }))
      .toEqual({ acceptedForInventory: true, absenceResolutionEligible: false, reasonCode: 'accepted_legacy' });
  });

  it.each([
    [{ software: [] } as LegacySoftwareInventoryReport, emptyState, 'retained_legacy_empty'],
    [{ software: [item] } as LegacySoftwareInventoryReport, { ...emptyState, hasAcceptedV2: true }, 'retained_legacy_after_v2'],
    [v2({ completeness: 'partial', expectedSources: ['a', 'b'], succeededSources: ['a'], failedSources: [{ source: 'b', code: 'command_failed' }] }), emptyState, 'rejected_partial'],
    [v2({ completeness: 'failed', succeededSources: [], failedSources: [{ source: 'windows:registry:hklm64', code: 'registry_read_failed' }], itemCount: 0, items: [] }), emptyState, 'rejected_failed'],
    [v2({ completeness: 'partial', truncated: true }), emptyState, 'rejected_truncated'],
  ] as const)('retains projection with stable reason %#', (report, state, reasonCode) => {
    expect(decideSoftwareInventoryAcceptance({ report, state, receivedAt })).toEqual({
      acceptedForInventory: false,
      absenceResolutionEligible: false,
      reasonCode,
    });
  });

  it('uses server receipt time, not observedAt, to reject older evidence', () => {
    expect(decideSoftwareInventoryAcceptance({
      report: v2({ observedAt: '2030-01-01T00:00:00.000Z' }),
      state: { ...emptyState, latestReceivedAt: new Date('2026-08-24T12:00:01.000Z') },
      receivedAt,
    }).reasonCode).toBe('rejected_out_of_order');
  });

  it('uses observation identity as the deterministic tie-break for equal receipts', () => {
    expect(decideSoftwareInventoryAcceptance({
      report: v2({ observationId: '11111111-1111-4111-8111-111111111111' }),
      state: {
        ...emptyState,
        latestReceivedAt: receivedAt,
        latestObservationId: '22222222-2222-4222-8222-222222222222',
      },
      receivedAt,
    }).reasonCode).toBe('rejected_out_of_order');
  });

  it('rejects a strict sub-10% collapse but accepts exactly 10%', () => {
    const state = {
      ...emptyState,
      hasAcceptedV2: true,
      visibleItemCount: 50,
      latestAcceptedExpectedSources: ['a'],
    };
    expect(decideSoftwareInventoryAcceptance({ report: v2({ expectedSources: ['a'], succeededSources: ['a'], itemCount: 4, items: Array(4).fill(item) }), state, receivedAt }).reasonCode)
      .toBe('rejected_count_collapse');
    expect(decideSoftwareInventoryAcceptance({ report: v2({ expectedSources: ['a'], succeededSources: ['a'], itemCount: 5, items: Array(5).fill(item) }), state, receivedAt }).reasonCode)
      .toBe('accepted_complete');
  });

  it('bypasses only collapse when the normalized source set changes', () => {
    const decision = decideSoftwareInventoryAcceptance({
      report: v2({ expectedSources: ['b', 'a'], succeededSources: ['a', 'b'], itemCount: 1, items: [item] }),
      state: { ...emptyState, hasAcceptedV2: true, visibleItemCount: 100, latestAcceptedExpectedSources: ['a'] },
      receivedAt,
    });
    expect(decision.reasonCode).toBe('accepted_complete');
    expect(decision.absenceResolutionEligible).toBe(true);
  });
});

describe('replaceSoftwareInventoryProjection', () => {
  function projectionTx(
    linkedFindings: Array<{ findingId: string; name: string; vendor: string | null }>,
    replacements: Array<{ id: string; name: string; vendor: string | null }>,
  ) {
    const updateSets: Array<Record<string, unknown>> = [];
    const inserted: Array<Record<string, unknown>> = [];
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({ for: vi.fn().mockResolvedValue(linkedFindings) }),
          }),
        }),
        where: vi.fn().mockResolvedValue(replacements),
      }),
    });
    return {
      tx: {
        select,
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn((values: Array<Record<string, unknown>>) => {
            inserted.push(...values);
            return Promise.resolve(undefined);
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn((value: Record<string, unknown>) => {
            updateSets.push(value);
            return { where: vi.fn().mockResolvedValue(undefined) };
          }),
        }),
      },
      inserted,
      select,
      updateSets,
    };
  }

  it('preserves the ordered finding lock and relinks normalized name/vendor matches', async () => {
    const ordered = vi.fn();
    const locked = vi.fn().mockResolvedValue([
      { findingId: 'finding-1', name: ' GOOGLE Chrome ', vendor: 'Google LLC' },
    ]);
    const updateSets: unknown[] = [];
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ orderBy: ordered.mockReturnValue({ for: locked }) }),
          }),
          where: vi.fn().mockResolvedValue([{ id: 'new-row', name: 'Google Chrome', vendor: ' google llc ' }]),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      update: vi.fn().mockReturnValue({
        set: vi.fn((value) => {
          updateSets.push(value);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };

    await replaceSoftwareInventoryProjection(tx as never, {
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '0.105.1' },
      items: [item],
      observationId: '11111111-1111-4111-8111-111111111111',
      receivedAt,
    });

    expect(ordered).toHaveBeenCalledTimes(1);
    expect(locked).toHaveBeenCalledWith('update', expect.any(Object));
    expect(updateSets).toEqual([expect.objectContaining({ softwareInventoryId: 'new-row' })]);
  });

  it('does not re-link a finding when only the normalized name matches but vendor differs', async () => {
    const { tx, updateSets } = projectionTx(
      [{ findingId: 'finding-1', name: 'Agent', vendor: 'Vendor A' }],
      [{ id: 'new-row', name: 'Agent', vendor: 'Vendor B' }],
    );
    await replaceSoftwareInventoryProjection(tx as never, {
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '0.105.1' },
      items: [{ name: 'Agent', vendor: 'Vendor B' }],
      observationId: '11111111-1111-4111-8111-111111111111',
      receivedAt,
    });
    expect(updateSets).toHaveLength(0);
  });

  it('skips replacement-row lookup and relinking when no finding points at the old projection', async () => {
    const { tx, select, updateSets } = projectionTx([], []);
    await replaceSoftwareInventoryProjection(tx as never, {
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '0.105.1' },
      items: [item],
      observationId: '11111111-1111-4111-8111-111111111111',
      receivedAt,
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(updateSets).toHaveLength(0);
  });

  it('normalizes both Breeze Agent editions to the authenticated live version', async () => {
    const { tx, inserted } = projectionTx([], []);
    await replaceSoftwareInventoryProjection(tx as never, {
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '0.105.1' },
      items: [
        { name: 'Breeze Agent', version: '0.100.0' },
        { name: 'Breeze Agent (Self-Hosted)', version: '0.101.0' },
        { name: 'Google Chrome', version: '127' },
      ],
      observationId: '11111111-1111-4111-8111-111111111111',
      receivedAt,
    });
    expect(inserted.map((row) => [row.name, row.version])).toEqual([
      ['Breeze Agent', '0.105.1'],
      ['Breeze Agent (Self-Hosted)', '0.105.1'],
      ['Google Chrome', '127'],
    ]);
  });

  it('does not replace a reported agent version with the provisioning sentinel', async () => {
    const { tx, inserted } = projectionTx([], []);
    await replaceSoftwareInventoryProjection(tx as never, {
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '0.0.0' },
      items: [{ name: 'Breeze Agent', version: '0.100.0' }],
      observationId: '11111111-1111-4111-8111-111111111111',
      receivedAt,
    });
    expect(inserted[0]?.version).toBe('0.100.0');
  });
});

describe('ingestSoftwareInventoryReport lock_timeout wiring (#3925)', () => {
  beforeEach(() => {
    transactionMock.mockReset();
    tightenLockTimeoutMock.mockReset();
    tightenLockTimeoutMock.mockResolvedValue(null);
  });

  // A regression this test exists to catch: the call being dropped in a bad
  // merge, moved to after the device row lock, or its bound quietly changed —
  // any of which would silently reopen #3925 without a real Postgres to
  // notice, since `pgErrors.test.ts` only exercises the generic retry
  // mechanism, never this call site.
  it('tightens lock_timeout to INVENTORY_LOCK_TIMEOUT_MS as the FIRST statement in the transaction, before the device row lock', async () => {
    const callOrder: string[] = [];
    tightenLockTimeoutMock.mockImplementation(async () => {
      callOrder.push('tighten');
      return null;
    });
    const execute = vi.fn().mockImplementation(async () => {
      callOrder.push('execute');
      // Stop right after the first statement so this stays a narrow unit
      // test of the wiring, not a re-implementation of the whole ingest flow.
      throw new Error('stub boundary: stop before the real device lookup');
    });
    transactionMock.mockImplementation(async (cb: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      cb({ execute }));

    const report: LegacySoftwareInventoryReport = { software: [] };
    await expect(ingestSoftwareInventoryReport({
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '1.0.0' },
      report,
      receivedAt: new Date('2026-08-24T12:00:00.000Z'),
    })).rejects.toThrow('stub boundary');

    expect(callOrder).toEqual(['tighten', 'execute']);
    expect(tightenLockTimeoutMock).toHaveBeenCalledTimes(1);
    expect(tightenLockTimeoutMock).toHaveBeenCalledWith({ execute }, INVENTORY_LOCK_TIMEOUT_MS);
    expect(INVENTORY_LOCK_TIMEOUT_MS).toBe(5000);
  });

  it('re-tightens lock_timeout on every retry attempt, not just the first (SAVEPOINT rollback undoes SET LOCAL)', async () => {
    let attempt = 0;
    tightenLockTimeoutMock.mockResolvedValue(null);
    const lockNotAvailable = Object.assign(new Error('lock timeout'), { code: '55P03' });
    transactionMock.mockImplementation(async (cb: (tx: { execute: () => Promise<never> }) => Promise<unknown>) => {
      attempt += 1;
      return cb({
        execute: async () => {
          if (attempt < 2) throw lockNotAvailable;
          throw new Error('stub boundary: stop after the retry we care about');
        },
      });
    });

    const report: LegacySoftwareInventoryReport = { software: [] };
    await expect(ingestSoftwareInventoryReport({
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '1.0.0' },
      report,
      receivedAt: new Date('2026-08-24T12:00:00.000Z'),
    })).rejects.toThrow('stub boundary');

    expect(attempt).toBe(2);
    expect(tightenLockTimeoutMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * #5181 / BREEZE-2F. Exhausting the 55P03 retries is the #3925 bound doing its
 * job under contention — nothing was written, and the agent re-sends the same
 * report on its next push. Before this, it rethrew a bare `PostgresError` that
 * `scrubEvent` stripped to an anonymous error-level Sentry event and the route
 * turned into a 500.
 */
describe('ingestSoftwareInventoryReport lock-timeout give-up reporting (#5181)', () => {
  const report: LegacySoftwareInventoryReport = { software: [] };
  const ingest = () => ingestSoftwareInventoryReport({
    device: { id: 'device-1', orgId: 'org-1', agentVersion: '1.0.0' },
    report,
    receivedAt: new Date('2026-09-07T12:00:00.000Z'),
  });

  beforeEach(() => {
    transactionMock.mockReset();
    tightenLockTimeoutMock.mockReset();
    tightenLockTimeoutMock.mockResolvedValue(null);
    captureMessageMock.mockReset();
  });

  /** Every attempt loses the same lock race, so the retry budget runs out. */
  function alwaysFailWith(error: unknown) {
    transactionMock.mockImplementation(async (cb: (tx: { execute: () => Promise<never> }) => Promise<unknown>) =>
      cb({ execute: async () => { throw error; } }));
  }

  it('reports the exhausted give-up as a warning under its event code and throws SoftwareInventoryLockTimeoutError', async () => {
    const lockNotAvailable = Object.assign(new Error('lock timeout'), { code: '55P03' });
    alwaysFailWith(lockNotAvailable);

    const thrown = await ingest().then(() => undefined, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(SoftwareInventoryLockTimeoutError);
    expect((thrown as SoftwareInventoryLockTimeoutError).errorCode).toBe('software_inventory_lock_timeout');
    // Must NOT be `code`: `pgErrorCode` reads the outer error's `.code` before
    // walking `.cause`, so that name would shadow the real 55P03 SQLSTATE.
    expect((thrown as { code?: unknown }).code).toBeUndefined();
    expect((thrown as Error).cause).toBe(lockNotAvailable);
    // All three attempts were spent before giving up.
    expect(tightenLockTimeoutMock).toHaveBeenCalledTimes(3);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock).toHaveBeenCalledWith(expect.any(String), {
      eventCode: 'software_inventory_lock_timeout_exhausted',
      level: 'warning',
      tags: { pg_code: '55P03' },
    });
  });

  it('leaves a deadlock give-up on the loud error path — no warning, no wrapper', async () => {
    // 40P01 exhaustion means three consecutive deadlocks, which points at a
    // lock-ordering regression rather than contention, so it must keep its 500.
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    alwaysFailWith(deadlock);

    const thrown = await ingest().then(() => undefined, (error: unknown) => error);

    expect(thrown).toBe(deadlock);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('leaves a non-lock failure untouched', async () => {
    const boom = new Error('something else broke');
    alwaysFailWith(boom);

    const thrown = await ingest().then(() => undefined, (error: unknown) => error);

    expect(thrown).toBe(boom);
    expect(tightenLockTimeoutMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });
});

function nameDiffTx(previous: string[]) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({ for: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(previous.map((name) => ({ name }))) }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn(),
  };
}

const inventoryDevice = { id: '11111111-1111-4111-8111-111111111112', orgId: '11111111-1111-4111-8111-111111111113', agentVersion: '1.0.0' };

describe('replaceSoftwareInventoryProjection installed-name diff (#10497)', () => {
  it.each([
    ['names change', ['A', 'B'], ['A', 'C'], true],
    ['only versions change', ['A', 'B'], ['A', 'B'], false],
    ['order and duplicates differ only', ['A', 'B', 'A'], ['B', 'A', 'B'], false],
    ['case-only rename', ['chrome'], ['Chrome'], true],
    ['non-empty becomes empty', ['A'], [], true],
    ['empty remains empty', [], [], false],
  ] as const)('returns the name-set difference when %s', async (_label, previous, next, changed) => {
    const tx = nameDiffTx([...previous]);
    const result = await replaceSoftwareInventoryProjection(tx as never, {
      device: inventoryDevice,
      items: next.map((name) => ({ name, version: '2.0' })),
      observationId: v2().observationId,
      receivedAt,
    });
    expect(result).toEqual({ installedNamesChanged: changed });
    expect(tx.select).toHaveBeenCalledTimes(1);
  });
});

describe('ingestSoftwareInventoryReport group re-evaluation (#10497)', () => {
  beforeEach(() => {
    transactionMock.mockReset();
    tightenLockTimeoutMock.mockReset();
    tightenLockTimeoutMock.mockResolvedValue(null);
  });

  function ingestTx(previous: string[], stateOverrides = {}, existing: unknown[] = []) {
    const tx = {
      ...nameDiffTx(previous),
      execute: vi.fn()
        .mockResolvedValueOnce([{ id: inventoryDevice.id, org_id: inventoryDevice.orgId }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          latest_observation_id: null,
          latest_received_at: null,
          has_accepted_v2: false,
          visible_item_count: previous.length,
          latest_accepted_expected_sources: null,
          ...stateOverrides,
        }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    };
    transactionMock.mockImplementation(async (callback) => callback(tx));
    return tx;
  }

  const report = v2({ itemCount: 2, items: [{ name: 'A', version: '2' }, { name: 'C', version: '2' }] });
  const ingest = (inventory = report) => ingestSoftwareInventoryReport({ device: inventoryDevice, report: inventory, receivedAt });

  it('requests a software re-evaluation when the installed-name set changes', async () => {
    const tx = ingestTx(['A', 'B']);
    await ingest();
    expect(requestDeviceGroupReevaluationAfterCommitMock).toHaveBeenCalledExactlyOnceWith({
      deviceId: inventoryDevice.id,
      orgId: inventoryDevice.orgId,
      eventType: 'device.updated',
      changedFields: ['software.installed', 'software.notInstalled'],
      reason: 'software_inventory_change',
    });
    expect(tx.execute).toHaveBeenCalledTimes(7);
    expect(requestDeviceGroupReevaluationAfterCommitMock.mock.invocationCallOrder[0])
      .toBeGreaterThan(tx.execute.mock.invocationCallOrder[6]!);
  });

  it('does not request one when only versions change', async () => {
    const tx = ingestTx(['A', 'C']);
    await ingest();
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(requestDeviceGroupReevaluationAfterCommitMock).not.toHaveBeenCalled();
  });

  it('does not request one for a rejected_out_of_order report', async () => {
    const tx = ingestTx(['A', 'B'], { latest_received_at: new Date(receivedAt.getTime() + 1000) });
    expect((await ingest()).reasonCode).toBe('rejected_out_of_order');
    expect(tx.delete).not.toHaveBeenCalled();
    expect(requestDeviceGroupReevaluationAfterCommitMock).not.toHaveBeenCalled();
  });

  it('does not request one on an idempotent V2 replay', async () => {
    const first = ingestTx(['A', 'B']);
    const result = await ingest();
    const inserted = new PgDialect().sqlToQuery(first.execute.mock.calls[5]![0]);
    const digest = inserted.params[16];
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    requestDeviceGroupReevaluationAfterCommitMock.mockReset();
    const tx = ingestTx([], {}, [{
      id: report.observationId,
      org_id: inventoryDevice.orgId,
      device_id: inventoryDevice.id,
      report_digest: digest,
      accepted_for_inventory: true,
      absence_resolution_eligible: true,
      reason_code: 'accepted_complete',
      visible_item_count: 2,
    }]);
    expect(await ingest()).toEqual(result);
    expect(tx.execute).toHaveBeenCalledTimes(3);
    expect(tx.delete).not.toHaveBeenCalled();
    expect(requestDeviceGroupReevaluationAfterCommitMock).not.toHaveBeenCalled();
  });
});
