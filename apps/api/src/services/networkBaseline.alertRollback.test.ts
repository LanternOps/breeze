import { beforeEach, describe, expect, it, vi } from 'vitest';

// createNetworkChangeAlert used to insert the alert row, link the change event
// to it, and only then publish — so a failed publish left a change event
// pointing at an alert nobody was ever notified about (#5325). It now delegates
// the insert+publish to the guarded createSourcedAlert and only records the link
// once that returns an id.
const { dbMock, createSourcedAlertMock, updateSet } = vi.hoisted(() => {
  const updateSet = vi.fn(() => ({ where: vi.fn(() => Promise.resolve(undefined)) }));
  return {
    updateSet,
    createSourcedAlertMock: vi.fn(),
    dbMock: {
      select: vi.fn(() => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      })),
      update: vi.fn(() => ({ set: updateSet })),
    },
  };
});

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('./alertService', () => ({ createSourcedAlert: createSourcedAlertMock }));

import { createNetworkChangeAlert } from './networkBaseline';

const DETECTED_AT = new Date('2026-03-04T05:06:07.000Z');

const CHANGE_EVENT = {
  id: 'change-1',
  orgId: 'org-1',
  baselineId: 'baseline-1',
  linkedDeviceId: 'device-1',
  ipAddress: '192.168.1.50',
  macAddress: 'aa:bb:cc:dd:ee:ff',
  hostname: 'printer-1',
  assetType: 'printer',
  eventType: 'new_device',
  currentState: {},
  previousState: {},
  detectedAt: DETECTED_AT,
} as never;

const SETTINGS = { alertSettings: { newDevice: true } };

describe('createNetworkChangeAlert alert rollback (#5325)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the alert through createSourcedAlert and links the change event on success', async () => {
    createSourcedAlertMock.mockResolvedValue('alert-3');

    await createNetworkChangeAlert('new_device', CHANGE_EVENT, SETTINGS);

    expect(createSourcedAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        orgId: 'org-1',
        publisher: 'network-baseline',
        context: expect.objectContaining({ source: 'network_baseline', networkChangeEventId: 'change-1' }),
        triggeredAt: DETECTED_AT,
      }),
    );
    expect(updateSet).toHaveBeenCalledWith({ alertId: 'alert-3', linkedDeviceId: 'device-1' });
  });

  it('leaves the change event unlinked when the alert was rolled back', async () => {
    createSourcedAlertMock.mockResolvedValue(null);

    await createNetworkChangeAlert('new_device', CHANGE_EVENT, SETTINGS);

    // Linking to a deleted alert id would strand the change event pointing at
    // nothing; leaving it unlinked lets a later run retry.
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});
