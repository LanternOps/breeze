/**
 * #4630 — dynamic device group membership never re-evaluated on device
 * change because this module's handlers were registered nowhere. Covers:
 *   - initializeDeviceEventHandlers wires one handler per DeviceChangeEventType
 *     to the correct groupMembership.ts function.
 *   - emitDeviceChange fans out to every registered handler and never lets one
 *     handler's rejection stop another (Promise.allSettled).
 *   - mapChangedFieldsToFilterFields's field-name mapping used by the
 *     heartbeat/enrollment/provision emit sites.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockUpdateDeviceMemberships,
  mockEvaluateDeviceMembershipForGroup,
  mockRemoveDeviceFromAllGroups,
  mockSelect,
} = vi.hoisted(() => ({
  mockUpdateDeviceMemberships: vi.fn().mockResolvedValue({ evaluatedGroups: 0, added: 0, removed: 0 }),
  mockEvaluateDeviceMembershipForGroup: vi.fn().mockResolvedValue({ evaluatedGroups: 1, added: 0, removed: 0 }),
  mockRemoveDeviceFromAllGroups: vi.fn().mockResolvedValue(undefined),
  mockSelect: vi.fn(),
}));

vi.mock('../services/groupMembership', () => ({
  updateDeviceMemberships: mockUpdateDeviceMemberships,
  evaluateDeviceMembershipForGroup: mockEvaluateDeviceMembershipForGroup,
  removeDeviceFromAllGroups: mockRemoveDeviceFromAllGroups,
}));

vi.mock('../db', () => ({
  db: { select: mockSelect },
}));

vi.mock('../db/schema', () => ({
  deviceGroups: { id: 'id', orgId: 'orgId', type: 'type', filterConditions: 'filterConditions', filterFieldsUsed: 'filterFieldsUsed' },
}));

import {
  createDeviceChangeEvent,
  emitDeviceChange,
  initializeDeviceEventHandlers,
  mapChangedFieldsToFilterFields,
  onDeviceChange,
  resetDeviceEventHandlersForTests,
  type DeviceChangeEventType,
} from './deviceEvents';

const DEVICE_ID = 'dddd0001-dddd-dddd-dddd-dddddddddddd';
const ORG_ID = 'aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// The device.created group SELECT now ends in `.orderBy(deviceGroups.id)` (a
// lock-order contract, #4630 review finding 2), so `where` has to be
// thenable AND carry an orderBy that resolves to the same rows.
function chainSelect(rows: unknown[]) {
  const whereResult = {
    orderBy: vi.fn().mockResolvedValue(rows),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(whereResult),
    }),
  };
}

describe('deviceEvents', () => {
  // eventHandlers is a module-scope singleton. initializeDeviceEventHandlers is
  // now idempotent (see its own test below), but registering once here still
  // keeps the ad hoc handlers added by individual tests out of each other's way.
  beforeAll(() => {
    initializeDeviceEventHandlers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue(chainSelect([]));
  });

  it('wires device.updated to updateDeviceMemberships with mapped filter fields', async () => {
    await emitDeviceChange(createDeviceChangeEvent('device.updated', DEVICE_ID, ORG_ID, ['hostname', 'deviceRole']));

    expect(mockUpdateDeviceMemberships).toHaveBeenCalledWith(DEVICE_ID, ORG_ID, ['hostname', 'deviceRole']);
  });

  it('does not call updateDeviceMemberships for device.updated with no changed fields', async () => {
    await emitDeviceChange(createDeviceChangeEvent('device.updated', DEVICE_ID, ORG_ID, []));

    expect(mockUpdateDeviceMemberships).not.toHaveBeenCalled();
  });

  it('wires device.hardware_updated to updateDeviceMemberships with hardware-prefixed fields', async () => {
    await emitDeviceChange(createDeviceChangeEvent('device.hardware_updated', DEVICE_ID, ORG_ID, ['cpuModel']));

    expect(mockUpdateDeviceMemberships).toHaveBeenCalledWith(DEVICE_ID, ORG_ID, ['hardware.cpuModel']);
  });

  it('wires device.network_updated to updateDeviceMemberships with network-prefixed fields', async () => {
    await emitDeviceChange(createDeviceChangeEvent('device.network_updated', DEVICE_ID, ORG_ID, ['ipAddress']));

    expect(mockUpdateDeviceMemberships).toHaveBeenCalledWith(DEVICE_ID, ORG_ID, ['network.ipAddress']);
  });

  it('wires device.software_changed to updateDeviceMemberships with the fixed software fields', async () => {
    await emitDeviceChange(createDeviceChangeEvent('device.software_changed', DEVICE_ID, ORG_ID, []));

    expect(mockUpdateDeviceMemberships).toHaveBeenCalledWith(
      DEVICE_ID,
      ORG_ID,
      ['software.installed', 'software.notInstalled'],
    );
  });

  it('wires device.created to evaluate every dynamic group with a filter in the org', async () => {
    mockSelect.mockReturnValue(chainSelect([{ id: 'group-1' }, { id: 'group-2' }]));

    await emitDeviceChange(createDeviceChangeEvent('device.created', DEVICE_ID, ORG_ID, []));

    expect(mockEvaluateDeviceMembershipForGroup).toHaveBeenCalledWith('group-1', DEVICE_ID);
    expect(mockEvaluateDeviceMembershipForGroup).toHaveBeenCalledWith('group-2', DEVICE_ID);
  });

  it('wires device.deleted to removeDeviceFromAllGroups', async () => {
    await emitDeviceChange(createDeviceChangeEvent('device.deleted', DEVICE_ID, ORG_ID, []));

    expect(mockRemoveDeviceFromAllGroups).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('runs every handler for an event type and does not let one rejection stop another', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    const succeeding = vi.fn().mockResolvedValue(undefined);
    const eventType: DeviceChangeEventType = 'device.updated';
    onDeviceChange(eventType, failing);
    onDeviceChange(eventType, succeeding);

    await emitDeviceChange(createDeviceChangeEvent(eventType, DEVICE_ID, ORG_ID, ['hostname']));

    expect(failing).toHaveBeenCalled();
    expect(succeeding).toHaveBeenCalled();
    // The pre-existing initializeDeviceEventHandlers handler for device.updated
    // also ran, alongside both of these ad hoc ones.
    expect(mockUpdateDeviceMemberships).toHaveBeenCalled();
  });

  it('is a no-op for an event type with no registered handlers', async () => {
    await expect(
      emitDeviceChange(createDeviceChangeEvent('device.metrics_updated', DEVICE_ID, ORG_ID, ['cpuPercent'])),
    ).resolves.toBeUndefined();
  });

  // #4630 review finding 5: a permanently-throwing handler used to be swallowed
  // whole by Promise.allSettled, so a dynamic group could go stale forever with
  // nothing in the logs.
  it('logs every rejected handler at error level', async () => {
    const boom = new Error('evaluation exploded');
    onDeviceChange('device.metrics_updated', vi.fn().mockRejectedValue(boom));
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await emitDeviceChange(createDeviceChangeEvent('device.metrics_updated', DEVICE_ID, ORG_ID, []));
    } finally {
      console.error = original;
    }

    expect(errors).toHaveLength(1);
    expect(String(errors[0]![0])).toContain('device.metrics_updated');
    expect(String(errors[0]![0])).toContain(DEVICE_ID);
    expect(errors[0]![1]).toBe(boom);
  });

  it('does not log when every handler resolves', async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await emitDeviceChange(createDeviceChangeEvent('device.deleted', DEVICE_ID, ORG_ID, []));
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(0);
  });
});

describe('initializeDeviceEventHandlers idempotency (#4630)', () => {
  // The BullMQ re-evaluation worker calls this on every job so a worker-role
  // process (which never runs index.ts's bootstrap) has handlers at all. Without
  // the guard that would stack a duplicate handler per job and evaluate each
  // device N times.
  beforeEach(() => {
    resetDeviceEventHandlersForTests();
    vi.clearAllMocks();
    mockSelect.mockReturnValue(chainSelect([]));
  });

  it('registers each handler exactly once no matter how many times it is called', async () => {
    initializeDeviceEventHandlers();
    initializeDeviceEventHandlers();
    initializeDeviceEventHandlers();

    await emitDeviceChange(createDeviceChangeEvent('device.updated', DEVICE_ID, ORG_ID, ['hostname']));

    expect(mockUpdateDeviceMemberships).toHaveBeenCalledTimes(1);
  });
});

describe('mapChangedFieldsToFilterFields', () => {
  it('maps known device fields to their filter field names unprefixed', () => {
    expect(mapChangedFieldsToFilterFields(['hostname', 'tags'], 'device')).toEqual(['hostname', 'tags']);
  });

  it('prefixes unmapped fields by source', () => {
    expect(mapChangedFieldsToFilterFields(['someNewField'], 'hardware')).toEqual(['hardware.someNewField']);
  });

  it('leaves already-prefixed fields untouched', () => {
    expect(mapChangedFieldsToFilterFields(['hardware.cpuModel'], 'device')).toEqual(['hardware.cpuModel']);
  });
});
