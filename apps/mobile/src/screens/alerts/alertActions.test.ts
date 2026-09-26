import { describe, expect, it } from 'vitest';

import type { Alert } from '../../services/api';
import { canRebootFromAlert, rebootConfirmMessage, REBOOT_PENDING_SOURCE } from './alertActions';

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

  it('hides it on a resolved alert', () => {
    expect(canRebootFromAlert(alert({ acknowledged: true, metadata: { status: 'resolved' } }))).toBe(false);
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

describe('rebootConfirmMessage', () => {
  it('names the device', () => {
    expect(rebootConfirmMessage(alert())).toContain('Restart host-1 now?');
  });

  it('falls back when the device name is missing', () => {
    expect(rebootConfirmMessage(alert({ deviceName: undefined }))).toContain('Restart this device now?');
  });
});
