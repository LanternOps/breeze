import { describe, it, expect } from 'vitest';

import {
  notificationsRowCopy,
  pushUnavailableCopy,
  type PushRowStatus,
} from './pushUnavailableCopy';

describe('pushUnavailableCopy', () => {
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
    for (const reason of ['not_physical_device', null]) {
      const copy = pushUnavailableCopy(reason);
      expect(copy.pairedDevicesHint).not.toMatch(/error|failed|wrong/i);
    }
  });
});

describe('notificationsRowCopy (#3143)', () => {
  const REASONS = ['not_physical_device', 'permission_denied', 'something_new', null];
  const STATUSES: PushRowStatus[] = ['idle', 'ok', 'failed', 'unsupported'];

  it("only 'ok' may claim pushes are being delivered", () => {
    // The false-assurance pin: every non-ok state must not assert delivery.
    for (const status of STATUSES) {
      for (const reason of REASONS) {
        const copy = notificationsRowCopy(status, reason);
        if (status === 'ok') {
          expect(copy.description).toMatch(/delivered/i);
        } else {
          expect(copy.description).not.toMatch(/delivered|arriving/i);
        }
      }
    }
  });

  it("'ok' points at system Settings as the real control", () => {
    const copy = notificationsRowCopy('ok', null);
    expect(copy.opensSystemSettings).toBe(true);
    expect(copy.description).toMatch(/Settings/);
    expect(copy.pairedDevicesHint).toBeNull();
  });

  it("'unsupported' reuses the reason-specific #3118 copy verbatim", () => {
    for (const reason of ['not_physical_device', null]) {
      const copy = notificationsRowCopy('unsupported', reason);
      const base = pushUnavailableCopy(reason);
      expect(copy.description).toBe(base.notificationsRow);
      expect(copy.pairedDevicesHint).toBe(base.pairedDevicesHint);
      expect(copy.opensSystemSettings).toBe(false);
    }
  });

  it("'failed' says pushes aren't registered and never contradicts the ApprovalGate banner", () => {
    // The banner says "Push notifications aren't registered … sign in again".
    // This row is what remains after the banner is dismissed, so it must carry
    // the same truth.
    for (const reason of ['permission_denied', 'some network error', null]) {
      const copy = notificationsRowCopy('failed', reason);
      expect(copy.description).toMatch(/aren't registered/);
      expect(copy.description).toMatch(/sign in again/i);
    }
  });

  it("'failed' + permission_denied names Settings as the fix and links there", () => {
    const copy = notificationsRowCopy('failed', 'permission_denied');
    expect(copy.description).toMatch(/turned off for Breeze in Settings/);
    expect(copy.opensSystemSettings).toBe(true);
  });

  it("'failed' with a non-permission reason does not send the user to Settings", () => {
    for (const reason of ['some network error', null]) {
      const copy = notificationsRowCopy('failed', reason);
      expect(copy.opensSystemSettings).toBe(false);
      expect(copy.description).toMatch(/won't reach this phone/);
    }
  });

  it("'idle' is a neutral in-progress state", () => {
    const copy = notificationsRowCopy('idle', null);
    expect(copy.description).toMatch(/checking/i);
    expect(copy.opensSystemSettings).toBe(false);
    expect(copy.pairedDevicesHint).toBeNull();
  });

  it('only unsupported overrides the paired-devices hint', () => {
    for (const status of STATUSES) {
      for (const reason of REASONS) {
        const copy = notificationsRowCopy(status, reason);
        if (status === 'unsupported') {
          expect(copy.pairedDevicesHint).not.toBeNull();
        } else {
          expect(copy.pairedDevicesHint).toBeNull();
        }
      }
    }
  });
});
