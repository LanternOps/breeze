import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #12492: `manage_patches action=rollback` used to insert one `patch_rollbacks`
 * row for `deviceIds[0]` only and queue no device command, so nothing ever
 * rolled back and the model reported "Rollback initiated". It now goes through
 * the same rollback service as POST /patches/:id/rollback for every listed
 * device, reaching each device through aiDispatch.
 */

const { mockAiQueue, mockSelect, mockInsertValues } = vi.hoisted(() => ({
  mockAiQueue: vi.fn(),
  mockSelect: vi.fn(),
  // `returning` only lets the old single-row insert run through to the
  // assertions; the rollback service awaits `values(...)` directly.
  mockInsertValues: vi.fn(() =>
    Object.assign(Promise.resolve(undefined), { returning: () => Promise.resolve([{ id: 'rb-1' }]) }),
  ),
}));

vi.mock('../db', () => ({
  hasDbAccessContext: () => false,
  withDbTransaction: (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: mockSelect,
    insert: vi.fn(() => ({ values: mockInsertValues })),
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

const PATCH_ID = '44444444-4444-4444-8444-444444444444';
const DEV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEV_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEV_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PATCH_ROW = { id: PATCH_ID, source: 'microsoft', externalId: 'KB5000001', title: 'Example update' };
const REASON = 'Initiated via AI assistant';

const baseAuth = {
  user: { id: 'u1', email: 'tech@example.com', name: 'Tech' },
  token: { mfa: true },
  orgId: null,
  partnerId: 'partner-1',
  scope: 'partner',
  accessibleOrgIds: ['org-first', 'org-device'],
  partnerOrgAccess: 'all',
  canAccessOrg: (id: string) => id !== 'org-other',
  orgCondition: () => undefined,
  aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
} as any;

type DeviceRow = { id: string; orgId: string; siteId: string | null; observationId: string | null };

/** The two reads the rollback makes: the patch, then the devices joined to their `installed` observation. */
function lookups(devices: DeviceRow[]) {
  mockSelect.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([PATCH_ROW]) }) }) });
  mockSelect.mockReturnValueOnce({ from: () => ({ leftJoin: () => ({ where: () => Promise.resolve(devices) }) }) });
}

const installed = (id: string, siteId: string | null = null): DeviceRow => ({ id, orgId: 'org-device', siteId, observationId: `dp-${id}` });
const queued = (id: string) => ({ command: { id, status: 'sent' }, delivery: 'delivered', deliverBy: null });
const row = (deviceId: string) => ({ deviceId, patchId: PATCH_ID, reason: REASON, status: 'pending', initiatedBy: 'u1' });

const rollback = (deviceIds: string[], auth = baseAuth) =>
  tool.handler({ action: 'rollback', patchId: PATCH_ID, deviceIds }, auth).then((out) => JSON.parse(out));

beforeEach(() => {
  mockAiQueue.mockReset();
  mockSelect.mockReset();
  mockInsertValues.mockClear();
});

describe('manage_patches:rollback queues the rollback command for every listed device (#12492)', () => {
  it('queues one rollback_patches command per device through aiDispatch and records a row for each', async () => {
    lookups([installed(DEV_A), installed(DEV_B)]);
    mockAiQueue.mockResolvedValueOnce(queued('cmd-a')).mockResolvedValueOnce(queued('cmd-b'));

    const result = await rollback([DEV_A, DEV_B]);

    expect(mockAiQueue).toHaveBeenCalledTimes(2);
    for (const deviceId of [DEV_A, DEV_B]) {
      expect(mockAiQueue).toHaveBeenCalledWith(
        baseAuth,
        'manage_patches',
        deviceId,
        'rollback_patches',
        { patchIds: [PATCH_ID], patches: [PATCH_ROW], reason: REASON },
        // The device's own org, not accessibleOrgIds[0] (#7827).
        expect.objectContaining({ userId: 'u1', expectedOrgId: 'org-device' }),
      );
    }
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith([row(DEV_A), row(DEV_B)]);
    expect(result.success).toBe(true);
    expect(result.queued.map((q: { commandId: string }) => q.commandId)).toEqual(['cmd-a', 'cmd-b']);
    expect(result.failed).toEqual([]);
  });

  it('reports a refused or cancelled device as failed and records no row for it', async () => {
    lookups([installed(DEV_A), installed(DEV_B)]);
    mockAiQueue.mockResolvedValueOnce(queued('cmd-a')).mockResolvedValueOnce({
      command: { id: 'cmd-b', status: 'cancelled' },
      error: 'Command cancelled: device not eligible',
      refusal: 'cancelled',
    });

    const result = await rollback([DEV_A, DEV_B]);

    expect(mockInsertValues).toHaveBeenCalledWith([row(DEV_A)]);
    expect(result.success).toBe(false);
    expect(result.queued).toHaveLength(1);
    expect(result.failed).toEqual([{ deviceId: DEV_B, error: 'Command cancelled: device not eligible' }]);
  });

  it('skips out-of-site, not-installed and unknown devices without queueing them, and says which', async () => {
    lookups([
      installed(DEV_A, 'site-ok'),
      installed(DEV_B, 'site-other'),
      { id: DEV_C, orgId: 'org-device', siteId: 'site-ok', observationId: null },
    ]);
    mockAiQueue.mockResolvedValueOnce(queued('cmd-a'));
    const restricted = { ...baseAuth, allowedSiteIds: ['site-ok'], canAccessSite: (id: string | null) => id === 'site-ok' };

    const result = await rollback([DEV_A, DEV_B, DEV_C, DEV_D], restricted);

    expect(mockAiQueue).toHaveBeenCalledTimes(1);
    expect(mockAiQueue.mock.calls[0]![2]).toBe(DEV_A);
    expect(mockInsertValues).toHaveBeenCalledWith([row(DEV_A)]);
    expect(result.skipped).toEqual({
      missingDeviceIds: [DEV_D],
      notInstalledDeviceIds: [DEV_C],
      inaccessibleDeviceIds: [DEV_B],
    });
  });

  it('refuses with nothing queued when no listed device is reachable', async () => {
    lookups([{ ...installed(DEV_A), orgId: 'org-other' }]);

    const result = await rollback([DEV_A]);

    expect(result.error).toMatch(/not found or access denied/i);
    expect(result.skipped.inaccessibleDeviceIds).toEqual([DEV_A]);
    expect(mockAiQueue).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('returns an error and records nothing when every device refused the command', async () => {
    lookups([installed(DEV_A), installed(DEV_B)]);
    mockAiQueue.mockResolvedValue({ error: 'Remote tools disabled by policy' });

    const result = await rollback([DEV_A, DEV_B]);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No rollback was queued/);
    expect(result.failed).toHaveLength(2);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});
