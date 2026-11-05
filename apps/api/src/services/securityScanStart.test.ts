import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tableOf, whereText } from '../testUtils/recordingDb';

/**
 * startDeviceScan (#6263 W05-11, #10057 gap 2): the single-device "Scan now"
 * shared by POST /security/scan/:deviceId and the AI `security_scan scan`
 * action. It no longer dispatches: it writes a queued row carrying everything
 * the dispatch claim needs (jobs/securityScanClaim.ts), commits, and enqueues
 * the claim job. Policy settings, rule sets and the quarantine decision are
 * resolved at the claim (covered in securityScanClaim.test.ts).
 */

const h = vi.hoisted(() => ({
  device: null as Record<string, unknown> | null,
  existingQueued: [] as Array<Record<string, unknown>>,
  scanSelects: [] as Array<Array<Record<string, unknown>>>,
  updateReturns: [] as Array<Array<Record<string, unknown>>>,
  cancelCommands: vi.fn(),
  events: [] as string[],
  enqueue: vi.fn(),
  perms: vi.fn(),
  aiPolicy: vi.fn(),
  queueCommand: vi.fn(),
  recording: null as null | ReturnType<typeof import('../testUtils/recordingDb').createRecordingDb>,
}));

vi.mock('../db', async () => {
  const { createRecordingDb, tableOf: tbl } = await import('../testUtils/recordingDb');
  h.recording = createRecordingDb((op) => {
    if (op.kind === 'select' && tbl(op) === 'security_scans') return h.scanSelects.shift() ?? h.existingQueued;
    if (op.kind === 'update') return h.updateReturns.shift() ?? [];
    if (op.kind === 'select') return h.device ? [h.device] : [];
    if (op.kind === 'insert') h.events.push('db:insert');
    return [];
  });
  return { db: h.recording.db };
});
vi.mock('../middleware/auth', () => ({
  withAuthDbAccessContext: async (_auth: unknown, fn: () => Promise<unknown>) => {
    h.events.push('context:open');
    try {
      return await fn();
    } finally {
      h.events.push('context:commit');
    }
  },
}));
vi.mock('../jobs/securityScanJobs', () => ({
  enqueueSecurityScan: (...a: unknown[]) => {
    h.events.push('enqueue');
    return h.enqueue(...a);
  },
}));
vi.mock('./commandQueue', () => ({
  CommandTypes: { SECURITY_SCAN: 'security_scan' },
  queueCommand: (...a: unknown[]) => h.queueCommand(...a),
}));
vi.mock('./permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./permissions')>()),
  getUserPermissions: (...a: unknown[]) => h.perms(...a),
}));
vi.mock('./aiRemoteToolsPolicy', () => ({ checkAiRemoteToolsPolicy: (...a: unknown[]) => h.aiPolicy(...a) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./commandCancelPropagation', () => ({ cancelDeviceCommands: (...a: unknown[]) => h.cancelCommands(...a) }));

import type { AuthContext } from '../middleware/auth';
import { cancelDeviceScan, startDeviceScan } from './securityScanStart';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';
const QUEUED_ID = '55555555-5555-4555-8555-555555555555';

const auth = {
  principal: { kind: 'user_session' },
  scope: 'organization',
  orgId: ORG_ID,
  partnerId: null,
  accessibleOrgIds: [ORG_ID],
  user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
  canAccessOrg: () => true,
  orgCondition: () => undefined,
  token: null,
} as unknown as AuthContext;

const scanInserts = () => h.recording!.ops.filter((o) => o.kind === 'insert' && tableOf(o) === 'security_scans');
const insertedRow = () => (scanInserts()[0]!.chain.find(([m]) => m === 'values')![1][0]) as Record<string, unknown>;

beforeEach(() => {
  h.recording!.ops.length = 0;
  h.events.length = 0;
  h.existingQueued = [];
  h.device = { id: DEVICE_ID, hostname: 'test-host', orgId: ORG_ID, siteId: SITE_ID, agentVersion: '0.124.0' };
  h.enqueue.mockReset().mockResolvedValue('job-1');
  h.perms.mockReset().mockResolvedValue({ permissions: [], allowedSiteIds: undefined });
  h.aiPolicy.mockReset().mockResolvedValue({ allowed: true });
  h.queueCommand.mockReset();
  h.scanSelects = [];
  h.updateReturns = [];
  h.cancelCommands.mockReset().mockResolvedValue([]);
  delete process.env.SECURITY_SCAN_MANUAL_QUEUE_TTL_MINUTES;
});

describe('startDeviceScan', () => {
  it('404 for a device the caller cannot see; nothing written or enqueued', async () => {
    h.device = null;
    expect(await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true })).toEqual({
      ok: false, status: 404, error: 'Device not found',
    });
    expect(scanInserts()).toEqual([]);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('403 outside the caller site allowlist', async () => {
    h.perms.mockResolvedValue({ permissions: [], allowedSiteIds: ['other-site'] });
    expect(await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true })).toEqual({
      ok: false, status: 403, error: 'Access to this site denied',
    });
    expect(scanInserts()).toEqual([]);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('never dispatches a command directly: the claim applies the concurrency caps (#10057 gap 2)', async () => {
    const result = await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true });
    expect(result.ok).toBe(true);
    expect(h.queueCommand).not.toHaveBeenCalled();
    expect(insertedRow()).toMatchObject({ status: 'queued', commandId: null, deviceId: DEVICE_ID, orgId: ORG_ID, initiatedBy: 'user-1' });
  });

  it('stores the dispatch inputs on the row: paths, caller MFA, queue expiry (24 h default)', async () => {
    const before = Date.now();
    const result = await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'custom', paths: ['/srv'], mfaSatisfied: false });
    const row = insertedRow();
    expect(row).toMatchObject({ scanType: 'custom', paths: ['/srv'], callerMfaSatisfied: false, aiOrigin: null });
    const expiresMs = (row.queueExpiresAt as Date).getTime();
    expect(expiresMs - before).toBeGreaterThanOrEqual(24 * 3_600_000 - 1000);
    expect(expiresMs - before).toBeLessThanOrEqual(24 * 3_600_000 + 1000);
    if (!result.ok) throw new Error('expected ok');
    expect(result.scan).toMatchObject({ status: 'queued', queueExpiresAt: (row.queueExpiresAt as Date).toISOString() });
  });

  it('honours SECURITY_SCAN_MANUAL_QUEUE_TTL_MINUTES', async () => {
    process.env.SECURITY_SCAN_MANUAL_QUEUE_TTL_MINUTES = '30';
    const before = Date.now();
    await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true });
    const ms = (insertedRow().queueExpiresAt as Date).getTime() - before;
    expect(ms).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect(ms).toBeLessThanOrEqual(30 * 60_000 + 1000);
  });

  it('a non-custom scan stores no paths', async () => {
    await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', paths: ['/srv'], mfaSatisfied: true });
    expect(insertedRow().paths).toBeNull();
  });

  it('enqueues the claim job only after the write context has committed', async () => {
    const result = await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true });
    if (!result.ok) throw new Error('expected ok');
    expect(h.events).toEqual(['context:open', 'db:insert', 'context:commit', 'enqueue']);
    expect(h.enqueue).toHaveBeenCalledWith(result.scan.id);
  });

  it('an enqueue failure still returns the queued scan (the pump re-admits it)', async () => {
    h.enqueue.mockRejectedValue(new Error('redis down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true });
    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('409 with the existing scan id when this device already has an undispatched Scan now queued; nothing written', async () => {
    h.existingQueued = [{ id: QUEUED_ID }];
    const result = await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true });
    expect(result).toEqual({ ok: false, status: 409, error: 'A scan is already queued for this device', scanId: QUEUED_ID });
    expect(scanInserts()).toEqual([]);
    expect(h.enqueue).not.toHaveBeenCalled();
    const dup = h.recording!.ops.find((o) => o.kind === 'select' && tableOf(o) === 'security_scans')!;
    const text = whereText(dup);
    expect(text).toContain('command_id');
    expect(text).toContain('caller_mfa_satisfied');
  });

  it('aiOrigin → remote-tools policy checked at request time and aiOrigin stored on the row', async () => {
    const aiOrigin = { kind: 'chat', sessionId: 's-1' } as never;
    await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: false, aiOrigin });
    expect(h.aiPolicy).toHaveBeenCalledWith(DEVICE_ID, 'security_scan');
    expect(insertedRow()).toMatchObject({ aiOrigin });
  });

  it('aiOrigin and policy deny → 403, no row', async () => {
    h.aiPolicy.mockResolvedValue({ allowed: false, reason: 'disabled', error: 'REMOTE_TOOLS_DISABLED_BY_POLICY: disabled' });
    const result = await startDeviceScan(auth, {
      deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: false, aiOrigin: { kind: 'chat', sessionId: 's-1' } as never,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'REMOTE_TOOLS_DISABLED_BY_POLICY: disabled' });
    expect(scanInserts()).toEqual([]);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('a human scan never consults the AI policy', async () => {
    await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true });
    expect(h.aiPolicy).not.toHaveBeenCalled();
  });
});

/**
 * cancelDeviceScan (#10057 gap 2): a Scan now that is still waiting for a slot
 * is cancelled outright; one dispatched but not yet delivered is cancelled
 * through its command (the propagation hook flips the scan row); one the
 * agent already has cannot be stopped.
 */
describe('cancelDeviceScan', () => {
  const SCAN_ID = '66666666-6666-4666-8666-666666666666';
  const COMMAND_ID = '77777777-7777-4777-8777-777777777777';
  const scan = (over: Record<string, unknown> = {}) => ({
    id: SCAN_ID, deviceId: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID, sweepId: null, status: 'queued', commandId: null, ...over,
  });
  const scanUpdates = () => h.recording!.ops.filter((o) => o.kind === 'update' && tableOf(o) === 'security_scans');

  it('404 for a scan the caller cannot see', async () => {
    h.scanSelects = [[]];
    expect(await cancelDeviceScan(auth, SCAN_ID)).toEqual({ ok: false, status: 404, error: 'Scan not found' });
    expect(scanUpdates()).toEqual([]);
  });

  it('403 outside the caller site allowlist; nothing changed', async () => {
    h.scanSelects = [[scan()]];
    h.perms.mockResolvedValue({ permissions: [], allowedSiteIds: ['other-site'] });
    expect(await cancelDeviceScan(auth, SCAN_ID)).toEqual({ ok: false, status: 403, error: 'Access to this site denied' });
    expect(scanUpdates()).toEqual([]);
  });

  it('a sweep scan is refused (cancel the sweep instead)', async () => {
    h.scanSelects = [[scan({ sweepId: 'sweep-1' })]];
    expect(await cancelDeviceScan(auth, SCAN_ID)).toMatchObject({ ok: false, status: 409, code: 'SWEEP_SCAN' });
    expect(scanUpdates()).toEqual([]);
  });

  it('an undispatched queued scan is cancelled by a CAS on queued + no command, inside the write context', async () => {
    h.scanSelects = [[scan()]];
    h.updateReturns = [[{ id: SCAN_ID }]];
    expect(await cancelDeviceScan(auth, SCAN_ID)).toEqual({ ok: true, scan: { id: SCAN_ID, status: 'cancelled' }, orgId: ORG_ID });
    const [update] = scanUpdates();
    expect(update!.chain.find(([m]) => m === 'set')![1][0]).toMatchObject({ status: 'cancelled' });
    const text = whereText(update!);
    expect(text).toContain('"status" = $');
    expect(text).toContain('"command_id" is null');
    expect(h.cancelCommands).not.toHaveBeenCalled();
    expect(h.events[0]).toBe('context:open');
  });

  it('lost the CAS to the claim: cancels the still-pending command; the propagation hook flips the scan', async () => {
    h.scanSelects = [[scan()], [{ status: 'running', commandId: COMMAND_ID }]];
    h.updateReturns = [[]];
    h.cancelCommands.mockResolvedValue([{ id: COMMAND_ID, type: 'security_scan', payload: null }]);
    expect(await cancelDeviceScan(auth, SCAN_ID)).toEqual({ ok: true, scan: { id: SCAN_ID, status: 'cancelled' }, orgId: ORG_ID });
    const call = h.cancelCommands.mock.calls[0]![0] as { where: unknown; result: Record<string, unknown> };
    expect(call.result).toMatchObject({ status: 'cancelled', reason: 'user_cancelled', cancelledBy: 'user-1' });
  });

  it('409 SCAN_RUNNING when the agent already has the command', async () => {
    h.scanSelects = [[scan({ status: 'running', commandId: COMMAND_ID })], [{ status: 'running', commandId: COMMAND_ID }]];
    h.updateReturns = [[]];
    h.cancelCommands.mockResolvedValue([]);
    expect(await cancelDeviceScan(auth, SCAN_ID)).toMatchObject({ ok: false, status: 409, code: 'SCAN_RUNNING' });
  });

  it('409 SCAN_FINISHED for a terminal scan; no command touched', async () => {
    h.scanSelects = [[scan({ status: 'completed', commandId: COMMAND_ID })], [{ status: 'completed', commandId: COMMAND_ID }]];
    h.updateReturns = [[]];
    expect(await cancelDeviceScan(auth, SCAN_ID)).toMatchObject({ ok: false, status: 409, code: 'SCAN_FINISHED' });
    expect(h.cancelCommands).not.toHaveBeenCalled();
  });
});
