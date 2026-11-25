import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSelect, mockInsertValues } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsertValues: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('../db', () => ({
  db: {
    select: mockSelect,
    insert: vi.fn(() => ({ values: mockInsertValues })),
  },
}));

import { queuePatchRollbacks } from './patchRollback';

const PATCH_ID = '44444444-4444-4444-8444-444444444444';
const PATCH_ROW = { id: PATCH_ID, source: 'microsoft', externalId: 'KB5000001', title: 'Example update' };
const device = (id: string) => ({ id, orgId: 'org-1', siteId: null });

function patchLookup(rows: unknown[]) {
  mockSelect.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) });
}

const input = (queue: ReturnType<typeof vi.fn>) => ({
  patchId: PATCH_ID,
  deviceIds: ['dev-a', 'dev-b', 'dev-c'],
  reason: 'Bad update',
  initiatedBy: 'user-1',
  canAccess: () => true,
  queue: queue as Parameters<typeof queuePatchRollbacks>[0]['queue'],
});

beforeEach(() => {
  mockSelect.mockReset();
  mockInsertValues.mockClear();
});

describe('queuePatchRollbacks (#12492)', () => {
  it('returns null and queues nothing when the patch does not exist', async () => {
    patchLookup([]);
    const queue = vi.fn();

    expect(await queuePatchRollbacks(input(queue))).toBeNull();
    expect(queue).not.toHaveBeenCalled();
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('hands each device to the caller queue with the rollback command and records rows only for queued ones', async () => {
    patchLookup([PATCH_ROW]);
    mockSelect.mockReturnValueOnce({
      from: () => ({
        leftJoin: () => ({
          where: () => Promise.resolve(['dev-a', 'dev-b', 'dev-c'].map((id) => ({ ...device(id), observationId: `dp-${id}` }))),
        }),
      }),
    });
    const queue = vi.fn(async (d: { id: string }) => {
      if (d.id === 'dev-a') return { command: { id: 'cmd-a', status: 'sent' } };
      if (d.id === 'dev-b') return { error: 'Device is offline, cannot execute command' };
      throw new Error('insert into "device_commands" ... params: secret');
    });

    const result = await queuePatchRollbacks(input(queue));

    expect(queue).toHaveBeenCalledWith(
      device('dev-a'),
      'rollback_patches',
      { patchIds: [PATCH_ID], patches: [PATCH_ROW], reason: 'Bad update' },
    );
    expect(mockInsertValues).toHaveBeenCalledWith([
      { deviceId: 'dev-a', patchId: PATCH_ID, reason: 'Bad update', status: 'pending', initiatedBy: 'user-1' },
    ]);
    expect(result!.queued).toEqual([{ deviceId: 'dev-a', commandId: 'cmd-a', commandStatus: 'sent' }]);
    // A thrown error's text can carry the query and its parameters, so only a fixed message comes back.
    expect(result!.failed).toEqual([
      { deviceId: 'dev-b', error: 'Device is offline, cannot execute command' },
      { deviceId: 'dev-c', error: 'Rollback command was not queued' },
    ]);
  });

  it('queues one device at a time, never two queue calls in flight on the shared transaction', async () => {
    patchLookup([PATCH_ROW]);
    mockSelect.mockReturnValueOnce({
      from: () => ({
        leftJoin: () => ({
          where: () => Promise.resolve(['dev-a', 'dev-b', 'dev-c'].map((id) => ({ ...device(id), observationId: `dp-${id}` }))),
        }),
      }),
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const queue = vi.fn(async (d: { id: string }) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return { command: { id: `cmd-${d.id}`, status: 'sent' } };
    });

    const result = await queuePatchRollbacks(input(queue));

    expect(maxInFlight).toBe(1);
    expect(result!.queued.map((entry) => entry.deviceId)).toEqual(['dev-a', 'dev-b', 'dev-c']);
  });
});
