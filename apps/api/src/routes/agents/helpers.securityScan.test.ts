import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { commandResultSchema } from './schemas';

/**
 * #6263 W01 — `handleSecurityCommandResult`'s `security_scan` branch ingests
 * partial results, timeouts, and agent-side auto-quarantine. Harness copied
 * from helpers.redaction.test.ts's selectQueue-based db mock.
 */

const { dbMock, insertValuesMock, updateSetMock, selectQueue } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const shift = () => selectQueue.shift() ?? [];

  const insertValuesMock = vi.fn();
  const updateSetMock = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });

  const dbMock = {
    select: vi.fn(() => {
      const rows = shift();
      const terminal = Object.assign(Promise.resolve(rows), {
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      });
      return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(terminal) }) };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((vals: unknown) => {
        insertValuesMock(vals);
        const returning = vi.fn().mockResolvedValue([]);
        return Object.assign(Promise.resolve(undefined), {
          returning,
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        });
      }),
    })),
    update: vi.fn(() => ({ set: updateSetMock })),
  };

  return { dbMock, insertValuesMock, updateSetMock, selectQueue };
});

vi.mock('../../db', () => ({
  db: dbMock,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => new Proxy({}, {
  get: (_t, prop: string) => (prop === 'then' ? undefined : { $inferSelect: {}, name: prop }),
  has: () => true,
}));

vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../jobs/softwareComplianceWorker', () => ({
  scheduleSoftwareComplianceCheck: vi.fn(),
}));
vi.mock('../../services/softwarePolicyService', () => ({
  recordSoftwarePolicyAudit: vi.fn(),
}));
vi.mock('../../services/commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('../../services/filesystemAnalysis', () => ({
  getFilesystemScanState: vi.fn(),
  mergeFilesystemAnalysisPayload: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(),
  readCheckpointPendingDirectories: vi.fn(),
  readHotDirectories: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  upsertFilesystemScanState: vi.fn(),
}));
vi.mock('../../services/cloudflareMtls', () => ({ CloudflareMtlsService: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../metrics', () => ({ recordSoftwareRemediationDecision: vi.fn() }));

import { handleSecurityCommandResult } from './helpers';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const COMMAND_ID = '00000000-0000-4000-8000-000000000004';
const SCAN_ID = '00000000-0000-4000-8000-000000000005';

function makeCommand(type: string, payload: Record<string, unknown>) {
  return {
    id: COMMAND_ID,
    deviceId: DEVICE_ID,
    type,
    payload,
    status: 'completed',
    result: null,
    createdAt: new Date('2026-09-18T00:00:00Z'),
  } as any;
}

function makeResult(
  overrides: Partial<z.infer<typeof commandResultSchema>> = {},
): z.infer<typeof commandResultSchema> {
  return {
    commandId: COMMAND_ID,
    status: 'completed',
    exitCode: 0,
    ...overrides,
  } as z.infer<typeof commandResultSchema>;
}

const scanCommand = makeCommand('security_scan', {});

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
});

it('records a timed-out scan as timed_out and still ingests its partial threats', async () => {
  // device org lookup, existing scan lookup
  selectQueue.push([{ orgId: ORG_ID }], [{ id: SCAN_ID }]);

  await handleSecurityCommandResult(scanCommand, makeResult({
    durationMs: 7_200_000,
    stdout: JSON.stringify({
      scanRecordId: SCAN_ID,
      scanType: 'full',
      threatsFound: 1,
      filesScanned: 41_233,
      timedOut: true,
      partial: true,
      threats: [{ name: 'Test-Threat', path: 'C:\\tmp\\x', severity: 'high', quarantinedTo: '' }],
    }),
  }));

  expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
    status: 'timed_out',
    itemsScanned: 41_233,
  }));
  const threatInsert = insertValuesMock.mock.calls
    .map((call) => call[0])
    .find((vals) => Array.isArray(vals) && vals.some((v: any) => v?.threatName));
  expect(threatInsert).toEqual([
    expect.objectContaining({ status: 'detected' }),
  ]);
});

it('records a threat the agent already quarantined as quarantined, not detected', async () => {
  selectQueue.push([{ orgId: ORG_ID }], [{ id: SCAN_ID }]);

  await handleSecurityCommandResult(scanCommand, makeResult({
    durationMs: 1000,
    stdout: JSON.stringify({
      scanRecordId: SCAN_ID,
      scanType: 'quick',
      threatsFound: 1,
      filesScanned: 12,
      threats: [{
        name: 'Test-Threat', path: 'C:\\tmp\\x', severity: 'high',
        quarantinedTo: 'C:\\ProgramData\\Breeze\\quarantine\\x-1758000000.bqz',
      }],
    }),
  }));

  const threatInsert = insertValuesMock.mock.calls
    .map((call) => call[0])
    .find((vals) => Array.isArray(vals) && vals.some((v: any) => v?.threatName));
  expect(threatInsert).toEqual([
    expect.objectContaining({ status: 'quarantined' }),
  ]);
});

it('still ingests a result from an agent that sends none of the new keys', async () => {
  selectQueue.push([{ orgId: ORG_ID }], [{ id: SCAN_ID }]);

  await handleSecurityCommandResult(scanCommand, makeResult({
    durationMs: 1000,
    stdout: JSON.stringify({ scanRecordId: SCAN_ID, scanType: 'quick', threatsFound: 0, threats: [] }),
  }));

  expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
    status: 'completed', itemsScanned: null,
  }));
});

// #6685 -- updateThreatStatusForAction is now the SOLE place a threat's
// status becomes terminal (the enqueue-time route handler no longer writes
// it optimistically). These prove the agent-result path still flips status
// correctly for each action once the agent actually reports back.
describe('quarantine/remove/restore command results (#6685)', () => {
  const THREAT_ID = '00000000-0000-4000-8000-000000000006';

  it.each([
    ['quarantine' as const, 'security_threat_quarantine', 'quarantined'],
    ['remove' as const, 'security_threat_remove', 'removed'],
    ['restore' as const, 'security_threat_restore', 'allowed'],
  ])('flips the threat to %s only after the agent reports a completed result', async (_label, type, expectedStatus) => {
    // handleSecurityCommandResult: device org lookup only (updateThreatStatusForAction
    // resolves the threat directly via payload.threatId, no extra select).
    selectQueue.push([{ orgId: ORG_ID }]);

    const command = makeCommand(type, { threatId: THREAT_ID, path: 'C:\\tmp\\evil.exe' });

    await handleSecurityCommandResult(command, makeResult({ status: 'completed' }));

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: expectedStatus }),
    );
  });

  it('does not flip the threat status when the agent reports a failed result', async () => {
    selectQueue.push([{ orgId: ORG_ID }]);

    const command = makeCommand('security_threat_quarantine', { threatId: THREAT_ID, path: 'C:\\tmp\\evil.exe' });

    await handleSecurityCommandResult(command, makeResult({ status: 'failed' }));

    expect(updateSetMock).not.toHaveBeenCalled();
  });
});
