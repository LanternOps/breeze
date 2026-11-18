import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #6263 W05 — a cancelled `security_scan` command (user cancel, org move,
 * decommission, claim-time refusal, sweep cancel) leaves its scan row `running`
 * forever otherwise: nothing ingests a result for a command that was never
 * delivered. The scan is found by `security_scans.command_id`, never by the
 * payload (which the cancel erases).
 */

const { updateMock, setSpy, whereSpy } = vi.hoisted(() => {
  const whereSpy = vi.fn((_cond: unknown) => Promise.resolve([]));
  const setSpy = vi.fn((_fields: Record<string, unknown>) => ({ where: whereSpy }));
  return { updateMock: vi.fn((_table: unknown) => ({ set: setSpy })), setSpy, whereSpy };
});

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
  inArray: (left: unknown, right: unknown) => ({ type: 'inArray', left, right }),
}));
vi.mock('../db', () => ({
  db: { update: updateMock, select: vi.fn(), insert: vi.fn() },
  getCurrentDbAccessContext: () => undefined,
  runAfterDbContextExit: vi.fn(),
}));
vi.mock('../db/schema', () => ({
  deploymentResults: { deviceCommandId: 'dr.deviceCommandId', status: 'dr.status' },
  deviceCommands: {},
  deviceFilesystemCleanupRuns: {},
  securityScans: { __table: 'security_scans', commandId: 'scans.commandId', status: 'scans.status' },
}));
vi.mock('./automationActionResults', () => ({ applyAutomationActionTerminal: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./scriptExecutionTerminal', () => ({
  batchIdFromPayload: () => null,
  finalizeScriptExecutionTerminal: vi.fn(),
}));

import { propagateCancelledDeviceCommand } from './commandCancelPropagation';

const completedAt = new Date('2026-10-25T12:00:00Z');
const tx = () => ({ update: updateMock, select: vi.fn(), insert: vi.fn() }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('security_scan cancel propagation (#6263 W05)', () => {
  it('cancels the running scan bound to the command id', async () => {
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1',
      type: 'security_scan',
      payload: null, // erased by the cancel
      completedAt,
      executor: tx(),
    });
    const scanUpdate = updateMock.mock.calls.findIndex(([table]) => (table as { __table?: string }).__table === 'security_scans');
    expect(scanUpdate).toBeGreaterThan(-1);
    expect(setSpy.mock.calls[scanUpdate]![0]).toEqual({ status: 'cancelled', completedAt });
    // CAS on running + the command id, so a result that landed first keeps its outcome.
    expect(whereSpy.mock.calls[scanUpdate]![0]).toEqual({
      type: 'and',
      conditions: [
        { type: 'eq', left: 'scans.commandId', right: 'cmd-1' },
        // queued: a manual Scan now never moves to running before its result.
        { type: 'inArray', left: 'scans.status', right: ['queued', 'running'] },
      ],
    });
  });

  it('leaves security_scans alone for other command types', async () => {
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'script', payload: {}, completedAt, executor: tx(),
    });
    expect(updateMock.mock.calls.some(([table]) => (table as { __table?: string }).__table === 'security_scans')).toBe(false);
  });
});
