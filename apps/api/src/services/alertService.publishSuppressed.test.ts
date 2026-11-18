import { beforeEach, describe, expect, it, vi } from 'vitest';

// The single producer of `alert.suppressed` (#10573). Every suppress path calls
// it, so the payload contract is pinned here once.
vi.mock('../db', () => ({ db: {} }));
const publishEvent = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 'evt'));
vi.mock('./eventBus', () => ({ publishEvent: (...args: unknown[]) => publishEvent(...args) }));

import { publishAlertSuppressed } from './alertService';

const alert = { id: 'alert-1', orgId: 'org-1', ruleId: 'rule-1', deviceId: 'device-1' };
const now = new Date('2026-10-30T10:00:00.000Z');

beforeEach(() => {
  publishEvent.mockReset().mockResolvedValue('evt');
});

describe('publishAlertSuppressed', () => {
  it.each([
    ['an explicit duration wins over the derived one', new Date('2026-10-30T12:00:00.000Z'), 24, 24],
    ['an end-time suppress derives hours from now', new Date('2026-10-30T12:00:00.000Z'), undefined, 2],
    ['a derived duration is rounded to 2 decimals', new Date('2026-10-30T10:20:00.000Z'), undefined, 0.33],
    ['an indefinite suppress is null even when a duration is passed', null, 24, null],
  ] as const)('%s', async (_name, suppressedUntil, durationHours, expected) => {
    await expect(publishAlertSuppressed({
      alert, suppressedBy: 'user-1', suppressedUntil, durationHours, source: 'test-source', now,
    })).resolves.toBe(true);

    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]).toEqual([
      'alert.suppressed',
      'org-1',
      {
        alertId: 'alert-1', ruleId: 'rule-1', deviceId: 'device-1', suppressedBy: 'user-1',
        suppressedUntil: suppressedUntil ? suppressedUntil.toISOString() : null,
        durationHours: expected,
      },
      'test-source',
      { userId: 'user-1' },
    ]);
  });

  it('publishes alert.suppressed with deviceId null for an org-subject alert', async () => {
    const orgAlert = { ...alert, deviceId: null, ownerKind: 'backup_workload' as const, ownerRef: 'workload-1' };
    await expect(publishAlertSuppressed({
      alert: orgAlert, suppressedBy: 'user-1', suppressedUntil: null, source: 'alerts-route',
    })).resolves.toBe(true);

    expect(publishEvent).toHaveBeenCalledExactlyOnceWith(
      'alert.suppressed',
      'org-1',
      {
        alertId: 'alert-1', ruleId: 'rule-1', deviceId: null,
        suppressedBy: 'user-1', suppressedUntil: null, durationHours: null,
      },
      'alerts-route',
      { userId: 'user-1' },
    );
  });

  it('returns false and logs instead of throwing when the publish fails', async () => {
    publishEvent.mockRejectedValueOnce(new Error('redis down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(publishAlertSuppressed({
        alert, suppressedBy: 'user-1', suppressedUntil: null, source: 'alerts-route',
      })).resolves.toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('alert-1'), expect.any(Error));
      expect(error.mock.calls[0]![0]).toContain('alerts-route');
    } finally {
      error.mockRestore();
    }
  });
});
