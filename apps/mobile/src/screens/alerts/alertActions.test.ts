import { describe, expect, it } from 'vitest';

import type { Alert } from '../../services/api';
import {
  canRebootFromAlert,
  needsAlertLookup,
  rebootConfirmMessage,
  rebootPlan,
  REBOOT_PENDING_SOURCE,
} from './alertActions';

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'alert-1',
    title: 'Reboot pending on host-1',
    message: 'host-1 has needed a restart for 9 day(s).',
    severity: 'medium',
    type: 'alert',
    source: REBOOT_PENDING_SOURCE,
    deviceId: '11111111-2222-4333-8444-555555555555',
    deviceName: 'host-1',
    acknowledged: false,
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z',
    metadata: { orgId: 'org-1', status: 'active' },
    ...overrides,
  };
}

describe('canRebootFromAlert', () => {
  it('offers reboot on an active reboot-pending alert for a device', () => {
    expect(canRebootFromAlert(alert())).toBe(true);
  });

  it('still offers it once acknowledged, since acknowledging does not restart anything', () => {
    expect(canRebootFromAlert(alert({ acknowledged: true, metadata: { status: 'acknowledged' } }))).toBe(true);
  });

  it('hides it on a resolved, dismissed, suppressed or unknown-status alert', () => {
    for (const status of ['resolved', 'dismissed', 'suppressed', 'something-new']) {
      expect(canRebootFromAlert(alert({ metadata: { status } }))).toBe(false);
    }
    expect(canRebootFromAlert(alert({ metadata: {} }))).toBe(false);
  });

  it('hides it on any other alert, even one that names a device', () => {
    expect(canRebootFromAlert(alert({ source: undefined }))).toBe(false);
    expect(canRebootFromAlert(alert({ source: 'patch-job-finalizer' }))).toBe(false);
  });

  it('does not match on the title alone', () => {
    expect(canRebootFromAlert(alert({ source: undefined, title: 'Reboot pending on host-1' }))).toBe(false);
  });

  it('hides it when the alert has no device', () => {
    expect(canRebootFromAlert(alert({ deviceId: undefined }))).toBe(false);
  });
});

describe('needsAlertLookup', () => {
  it('re-reads a reboot-pending alert, since its list status may be stale', () => {
    expect(needsAlertLookup(alert())).toBe(true);
  });

  it('looks up an alert that arrived without a source, with or without a device', () => {
    expect(needsAlertLookup(alert({ source: undefined }))).toBe(true);
    // The server's copy supplies the device a chat payload may leave out.
    expect(needsAlertLookup(alert({ source: undefined, deviceId: undefined }))).toBe(true);
  });

  it('skips the lookup for other alerts or when there is no alert id', () => {
    expect(needsAlertLookup(alert({ source: 'patch-job-finalizer' }))).toBe(false);
    expect(needsAlertLookup(alert({ id: '' }))).toBe(false);
  });
});

describe('rebootPlan', () => {
  it('targets the device on the fetched alert', () => {
    expect(rebootPlan(alert({ deviceId: 'dev-server', deviceName: 'server-host' }))).toEqual({
      deviceId: 'dev-server',
      message: expect.stringContaining('Restart server-host now?'),
    });
  });

  it('offers nothing before the fetch lands or for a resolved alert', () => {
    expect(rebootPlan(null)).toBeNull();
    expect(rebootPlan(alert({ metadata: { status: 'resolved' } }))).toBeNull();
    expect(rebootPlan(alert({ source: undefined }))).toBeNull();
  });
});

describe('rebootConfirmMessage', () => {
  it('names the device', () => {
    expect(rebootConfirmMessage(alert())).toContain('Restart host-1 now?');
  });

  it('falls back when the device name is missing', () => {
    expect(rebootConfirmMessage(alert({ deviceName: undefined }))).toContain('Restart this device now?');
  });
});
