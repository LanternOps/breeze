import { beforeEach, describe, expect, it, vi } from 'vitest';

// The existing softwarePolicyService.test.ts is pure-function only and declares
// no vi.mock at all, so the upsert's SQL shape needs its own rig here. We
// capture the exact objects handed to values()/onConflictDoUpdate() rather than
// asserting on compiled SQL: the property this guards is "which columns does
// the ON CONFLICT set clause name", and that is visible in the set object's
// own keys.
type CapturedInsert = {
  values: Record<string, unknown>[];
  setKeys: string[];
};

const { captured, insertMock } = vi.hoisted(() => {
  const captured: CapturedInsert[] = [];
  const insertMock = vi.fn(() => ({
    values: (rows: Record<string, unknown>[]) => ({
      onConflictDoUpdate: async (config: { set: Record<string, unknown> }) => {
        captured.push({ values: rows, setKeys: Object.keys(config.set) });
      },
    }),
  }));
  return { captured, insertMock };
});

vi.mock('../db', () => ({
  db: { insert: insertMock },
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { upsertSoftwareComplianceStatuses } from './softwarePolicyService';

const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';
const POLICY = '33333333-3333-4333-8333-333333333333';

function baseInput(deviceId: string) {
  return {
    deviceId,
    policyId: POLICY,
    status: 'violation' as const,
    violations: [],
    checkedAt: new Date('2026-09-10T00:00:00.000Z'),
  };
}

/** Throws rather than returning undefined, so a missing statement fails loudly. */
function statement(index: number): CapturedInsert {
  const entry = captured[index];
  if (!entry) throw new Error(`no captured insert statement at index ${index}`);
  return entry;
}

function row(statementIndex: number, rowIndex: number): Record<string, unknown> {
  const value = statement(statementIndex).values[rowIndex];
  if (!value) throw new Error(`no row ${rowIndex} in statement ${statementIndex}`);
  return value;
}

describe('upsertSoftwareComplianceStatuses — per-column non-clobber contract', () => {
  beforeEach(() => {
    captured.length = 0;
    vi.clearAllMocks();
  });

  it('omits every optional column from the set clause when the input carries none', async () => {
    await upsertSoftwareComplianceStatuses([baseInput(DEVICE_A)]);

    expect(captured).toHaveLength(1);
    expect(statement(0).setKeys.sort()).toEqual(['lastChecked', 'status', 'violations']);
    expect(row(0, 0)).not.toHaveProperty('remediationStatus');
    expect(row(0, 0)).not.toHaveProperty('installRemediationStatus');
    expect(row(0, 0)).not.toHaveProperty('installRemediationAttempts');
  });

  it('writes remediationStatus WITHOUT touching either install column (existing behaviour, unchanged)', async () => {
    await upsertSoftwareComplianceStatuses([
      { ...baseInput(DEVICE_A), remediationStatus: 'pending' },
    ]);

    expect(captured).toHaveLength(1);
    expect(statement(0).setKeys.sort()).toEqual(['lastChecked', 'remediationStatus', 'status', 'violations']);
  });

  it('writes installRemediationStatus WITHOUT touching remediationStatus', async () => {
    await upsertSoftwareComplianceStatuses([
      { ...baseInput(DEVICE_A), installRemediationStatus: 'skipped' },
    ]);

    expect(captured).toHaveLength(1);
    expect(statement(0).setKeys.sort()).toEqual([
      'installRemediationStatus', 'lastChecked', 'status', 'violations',
    ]);
    expect(row(0, 0).installRemediationStatus).toBe('skipped');
  });

  // The discriminating case: 0 is falsy. A `if (input.installRemediationAttempts)`
  // guard would silently drop the counter reset and leave a device stuck one
  // attempt short of 'gave_up' forever. The guard must be `!== undefined`.
  it('treats installRemediationAttempts: 0 as a value to write, not as absent', async () => {
    await upsertSoftwareComplianceStatuses([
      { ...baseInput(DEVICE_A), installRemediationAttempts: 0 },
    ]);

    expect(captured).toHaveLength(1);
    expect(statement(0).setKeys).toContain('installRemediationAttempts');
    expect(row(0, 0).installRemediationAttempts).toBe(0);
  });

  it('splits a mixed batch into one statement per column shape', async () => {
    await upsertSoftwareComplianceStatuses([
      baseInput(DEVICE_A),
      { ...baseInput(DEVICE_B), installRemediationStatus: 'gave_up', installRemediationAttempts: 3 },
    ]);

    expect(captured).toHaveLength(2);
    const shapes = captured.map((c) => c.setKeys.sort().join(',')).sort();
    expect(shapes).toEqual([
      'installRemediationAttempts,installRemediationStatus,lastChecked,status,violations',
      'lastChecked,status,violations',
    ]);
  });

  it('still skips inputs with a blank deviceId or policyId', async () => {
    await upsertSoftwareComplianceStatuses([
      { ...baseInput(''), installRemediationStatus: 'pending' },
    ]);

    expect(captured).toHaveLength(0);
  });
});
