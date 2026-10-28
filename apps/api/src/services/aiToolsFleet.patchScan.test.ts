import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * #10383: `manage_patches action=scan` used to validate `deviceIds` and return
 * `{ success: true, message: 'Patch scan requested …' }` without dispatching
 * anything. A technician approved a Tier-2 card for a no-op and the model told
 * them results were on the way. These tests pin that a scan queues one
 * `patch_scan` device command per device — and says so honestly when it can't.
 */

const { mockAiQueue, mockSelect } = vi.hoisted(() => ({
  mockAiQueue: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: mockSelect,
    insert: vi.fn(() => {
      throw new Error('scan must not insert rows directly');
    }),
  },
}));

vi.mock('./aiDispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiDispatch')>();
  return { ...actual, aiQueueCommandForExecution: mockAiQueue };
});

import { registerFleetTools } from './aiToolsFleet';
import type { AiTool } from './aiTools';

const toolMap = new Map<string, AiTool>();
registerFleetTools(toolMap);
const tool = toolMap.get('manage_patches')!;

const DEV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const baseAuth = {
  user: { id: 'u1', email: 'tech@example.com', name: 'Tech' },
  orgId: null,
  partnerId: 'partner-1',
  scope: 'partner',
  accessibleOrgIds: ['org-first', 'org-device'],
  partnerOrgAccess: 'all',
  canAccessOrg: () => true,
  orgCondition: () => undefined,
  aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
} as any;

/** The single device lookup the scan branch makes: select → from → where. */
function deviceRows(rows: Array<{ id: string; siteId: string | null; orgId: string }>) {
  const where = vi.fn().mockResolvedValue(rows);
  mockSelect.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where }) });
  return where;
}

const queued = (id: string, status = 'sent', delivery = 'delivered') => ({
  command: { id, status },
  delivery,
  deliverBy: null,
});

beforeEach(() => {
  mockAiQueue.mockReset();
  mockSelect.mockReset();
});

describe('manage_patches:scan dispatches a patch_scan command (#10383)', () => {
  it('queues one patch_scan command per device and returns the command ids', async () => {
    deviceRows([
      { id: DEV_A, siteId: null, orgId: 'org-device' },
      { id: DEV_B, siteId: null, orgId: 'org-device' },
    ]);
    mockAiQueue
      .mockResolvedValueOnce(queued('cmd-a'))
      .mockResolvedValueOnce(queued('cmd-b', 'pending', 'queued_offline'));

    const result = JSON.parse(await tool.handler({ action: 'scan', deviceIds: [DEV_A, DEV_B] }, baseAuth));

    expect(mockAiQueue).toHaveBeenCalledTimes(2);
    for (const deviceId of [DEV_A, DEV_B]) {
      expect(mockAiQueue).toHaveBeenCalledWith(
        baseAuth,
        'manage_patches',
        deviceId,
        'patch_scan',
        expect.any(Object),
        expect.objectContaining({ userId: 'u1', expectedOrgId: 'org-device' }),
      );
    }
    expect(result.success).toBe(true);
    expect(result.queued).toEqual([
      { deviceId: DEV_A, commandId: 'cmd-a', delivery: 'delivered' },
      { deviceId: DEV_B, commandId: 'cmd-b', delivery: 'queued_offline' },
    ]);
    expect(result.failed).toEqual([]);
  });

  it("binds each command to the device's own org, not accessibleOrgIds[0] (#7827)", async () => {
    const where = deviceRows([{ id: DEV_A, siteId: null, orgId: 'org-device' }]);
    mockAiQueue.mockResolvedValueOnce(queued('cmd-a'));

    await tool.handler({ action: 'scan', deviceIds: [DEV_A] }, baseAuth);

    const params = new PgDialect().sqlToQuery(where.mock.calls[0]![0]).params;
    expect(params).not.toContain('org-first');
    expect(mockAiQueue.mock.calls[0]![5]).toEqual(expect.objectContaining({ expectedOrgId: 'org-device' }));
  });

  it('reports a per-device dispatch refusal as a failure, not success', async () => {
    deviceRows([
      { id: DEV_A, siteId: null, orgId: 'org-device' },
      { id: DEV_B, siteId: null, orgId: 'org-device' },
    ]);
    mockAiQueue
      .mockResolvedValueOnce(queued('cmd-a'))
      .mockResolvedValueOnce({ error: 'Device is decommissioned, cannot execute command', refusal: 'device_decommissioned' });

    const result = JSON.parse(await tool.handler({ action: 'scan', deviceIds: [DEV_A, DEV_B] }, baseAuth));

    expect(result.success).toBe(false);
    expect(result.queued).toEqual([{ deviceId: DEV_A, commandId: 'cmd-a', delivery: 'delivered' }]);
    expect(result.failed).toEqual([{ deviceId: DEV_B, error: 'Device is decommissioned, cannot execute command' }]);
  });

  it('treats a cancelled command (row exists but will never run) as a failure', async () => {
    deviceRows([{ id: DEV_A, siteId: null, orgId: 'org-device' }]);
    mockAiQueue.mockResolvedValueOnce({
      command: { id: 'cmd-a', status: 'cancelled' },
      error: 'Command cancelled: device not eligible',
      refusal: 'cancelled',
    });

    const result = JSON.parse(await tool.handler({ action: 'scan', deviceIds: [DEV_A] }, baseAuth));

    expect(result.success).toBe(false);
    expect(result.queued).toEqual([]);
    expect(result.failed).toEqual([{ deviceId: DEV_A, error: 'Command cancelled: device not eligible' }]);
  });

  it('keeps going after a device throws and reports it as failed', async () => {
    deviceRows([
      { id: DEV_A, siteId: null, orgId: 'org-device' },
      { id: DEV_B, siteId: null, orgId: 'org-device' },
    ]);
    mockAiQueue
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(queued('cmd-b'));

    const result = JSON.parse(await tool.handler({ action: 'scan', deviceIds: [DEV_A, DEV_B] }, baseAuth));

    expect(result.success).toBe(false);
    expect(result.queued).toEqual([{ deviceId: DEV_B, commandId: 'cmd-b', delivery: 'delivered' }]);
    expect(result.failed).toEqual([{ deviceId: DEV_A, error: 'Failed to queue patch scan' }]);
  });

  it('refuses the whole request and dispatches nothing when a device is outside the caller scope', async () => {
    // DEV_B is not returned by the org-bounded lookup.
    deviceRows([{ id: DEV_A, siteId: null, orgId: 'org-device' }]);

    const result = JSON.parse(await tool.handler({ action: 'scan', deviceIds: [DEV_A, DEV_B] }, baseAuth));

    expect(result.error).toMatch(/not found or access denied/i);
    expect(result.success).toBeUndefined();
    expect(mockAiQueue).not.toHaveBeenCalled();
  });

  it('refuses a site-restricted caller for an out-of-site device and dispatches nothing', async () => {
    deviceRows([
      { id: DEV_A, siteId: 'site-ok', orgId: 'org-device' },
      { id: DEV_B, siteId: 'site-other', orgId: 'org-device' },
    ]);
    const restricted = {
      ...baseAuth,
      allowedSiteIds: ['site-ok'],
      canAccessSite: (id: string | null) => id === 'site-ok',
    };

    const result = JSON.parse(await tool.handler({ action: 'scan', deviceIds: [DEV_A, DEV_B] }, restricted));

    expect(result.error).toMatch(/not found or access denied/i);
    expect(mockAiQueue).not.toHaveBeenCalled();
  });

  it('refuses a device-bound caller for a device outside its allowlist', async () => {
    deviceRows([
      { id: DEV_A, siteId: null, orgId: 'org-device' },
      { id: DEV_B, siteId: null, orgId: 'org-device' },
    ]);
    const deviceBound = { ...baseAuth, allowedDeviceIds: [DEV_A] };

    const result = JSON.parse(await tool.handler({ action: 'scan', deviceIds: [DEV_A, DEV_B] }, deviceBound));

    expect(result.error).toBeDefined();
    expect(mockAiQueue).not.toHaveBeenCalled();
  });

  it('dedupes repeated device ids so a device is scanned once', async () => {
    deviceRows([{ id: DEV_A, siteId: null, orgId: 'org-device' }]);
    mockAiQueue.mockResolvedValueOnce(queued('cmd-a'));

    const result = JSON.parse(await tool.handler({ action: 'scan', deviceIds: [DEV_A, DEV_A] }, baseAuth));

    expect(mockAiQueue).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('still requires deviceIds', async () => {
    const result = JSON.parse(await tool.handler({ action: 'scan' }, baseAuth));
    expect(result.error).toMatch(/deviceIds is required/);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
