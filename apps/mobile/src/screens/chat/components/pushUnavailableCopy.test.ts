import { describe, it, expect } from 'vitest';

import { pushUnavailableCopy } from './pushUnavailableCopy';

describe('pushUnavailableCopy', () => {
  it('names Android for the not-built-yet reason (#3118)', () => {
    const copy = pushUnavailableCopy('android_push_not_configured');
    expect(copy.notificationsRow).toMatch(/Android/);
    expect(copy.notificationsRow).toMatch(/aren't available/i);
    expect(copy.pairedDevicesHint).toMatch(/Android/);
  });

  it('names the simulator for not_physical_device', () => {
    const copy = pushUnavailableCopy('not_physical_device');
    expect(copy.notificationsRow).toMatch(/simulator/i);
    expect(copy.pairedDevicesHint).toMatch(/simulator/i);
  });

  it('falls back to a generic device message for unknown reasons and null', () => {
    for (const reason of ['something_new', null]) {
      const copy = pushUnavailableCopy(reason);
      expect(copy.notificationsRow).toMatch(/this device/i);
      expect(copy.pairedDevicesHint.length).toBeGreaterThan(0);
    }
  });

  it('never phrases the paired-devices hint as an error or a user mistake', () => {
    for (const reason of ['android_push_not_configured', 'not_physical_device', null]) {
      const copy = pushUnavailableCopy(reason);
      expect(copy.pairedDevicesHint).not.toMatch(/error|failed|wrong/i);
    }
  });
});
