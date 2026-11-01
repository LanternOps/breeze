import { describe, it, expect, vi, beforeEach } from 'vitest';

// #9075 W4a (OD8 B): the one resolver for the agreement-request defaults.
const queued: unknown[][] = [];
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(queued.shift() ?? []).then(resolve, reject);
  return { db: chain };
});

import {
  BUILT_IN_AGREEMENT_REQUEST_DEFAULTS,
  autoReminderDueAt,
  defaultAgreementRequestExpiresAt,
  isAutoReminderDue,
  loadAgreementRequestDefaults,
  resolveAgreementRequestDefaults,
} from './agreementRequestDefaults';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-25T12:00:00.000Z');

beforeEach(() => { queued.length = 0; });

describe('resolveAgreementRequestDefaults', () => {
  it('no readable partner row → the built-in defaults (30 days, reminders off)', () => {
    expect(resolveAgreementRequestDefaults(null)).toEqual({ defaultExpiryDays: 30, autoReminder: null });
    expect(BUILT_IN_AGREEMENT_REQUEST_DEFAULTS).toEqual({ defaultExpiryDays: 30, autoReminder: null });
  });

  it('reads the partner columns; a NULL interval means automatic reminders are off', () => {
    expect(resolveAgreementRequestDefaults({
      agreementDefaultExpiryDays: 14, agreementReminderIntervalDays: null, agreementMaxReminders: 5,
    })).toEqual({ defaultExpiryDays: 14, autoReminder: null });
    expect(resolveAgreementRequestDefaults({
      agreementDefaultExpiryDays: 14, agreementReminderIntervalDays: 3, agreementMaxReminders: 5,
    })).toEqual({ defaultExpiryDays: 14, autoReminder: { intervalDays: 3, maxReminders: 5 } });
  });

  it('an out-of-range stored value (CHECK bypassed) falls back per field, never throws, and is logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveAgreementRequestDefaults({
      agreementDefaultExpiryDays: 14, agreementReminderIntervalDays: null, agreementMaxReminders: 3,
    }, 'p-1')).toEqual({ defaultExpiryDays: 14, autoReminder: null });
    expect(warn).not.toHaveBeenCalled(); // a NULL interval is "off", not corruption
    expect(resolveAgreementRequestDefaults({
      agreementDefaultExpiryDays: 0, agreementReminderIntervalDays: 3, agreementMaxReminders: 3,
    }, 'p-1')).toMatchObject({ defaultExpiryDays: 30 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('partner p-1 has out-of-range agreementDefaultExpiryDays=0'));
    warn.mockClear();
    expect(resolveAgreementRequestDefaults({
      agreementDefaultExpiryDays: 0, agreementReminderIntervalDays: 99, agreementMaxReminders: 2,
    })).toEqual({ defaultExpiryDays: 30, autoReminder: null });
    expect(resolveAgreementRequestDefaults({
      agreementDefaultExpiryDays: 10, agreementReminderIntervalDays: 2, agreementMaxReminders: 0,
    })).toEqual({ defaultExpiryDays: 10, autoReminder: { intervalDays: 2, maxReminders: 3 } });
    expect(warn).toHaveBeenCalledTimes(3); // expiry 0, interval 99, cap 0
    warn.mockRestore();
  });
});

describe('loadAgreementRequestDefaults', () => {
  it('resolves the partner row it reads', async () => {
    queued.push([{ agreementDefaultExpiryDays: 7, agreementReminderIntervalDays: 2, agreementMaxReminders: 4 }]);
    await expect(loadAgreementRequestDefaults('p-1')).resolves.toEqual({
      defaultExpiryDays: 7, autoReminder: { intervalDays: 2, maxReminders: 4 },
    });
  });

  it('a partner row RLS hides (org-scoped token) resolves to the built-in defaults', async () => {
    queued.push([]);
    await expect(loadAgreementRequestDefaults('p-1')).resolves.toEqual(BUILT_IN_AGREEMENT_REQUEST_DEFAULTS);
  });
});

describe('defaultAgreementRequestExpiresAt', () => {
  it('is now + the resolved default days', () => {
    expect(defaultAgreementRequestExpiresAt({ defaultExpiryDays: 14, autoReminder: null }, NOW))
      .toEqual(new Date(NOW.getTime() + 14 * DAY));
  });
});

describe('automatic reminder due-ness (one helper for the job selector re-check)', () => {
  const sentAt = new Date(NOW.getTime() - 10 * DAY);
  const base = {
    status: 'sent' as const, expiresAt: new Date(NOW.getTime() + 10 * DAY), publicLinkRevokedAt: null,
    sentAt, lastRemindedAt: null, reminderCount: 0,
  };
  const on = { defaultExpiryDays: 30, autoReminder: { intervalDays: 3, maxReminders: 2 } };

  it('anchors on the later of sent_at and last_reminded_at', () => {
    expect(autoReminderDueAt(base, 3)).toEqual(new Date(sentAt.getTime() + 3 * DAY));
    const lastRemindedAt = new Date(NOW.getTime() - DAY);
    expect(autoReminderDueAt({ ...base, lastRemindedAt }, 3)).toEqual(new Date(lastRemindedAt.getTime() + 3 * DAY));
    expect(autoReminderDueAt({ ...base, sentAt: null }, 3)).toBeNull();
  });

  it('due at the instant boundary, not a millisecond before', () => {
    const lastRemindedAt = new Date(NOW.getTime() - 3 * DAY);
    expect(isAutoReminderDue({ ...base, lastRemindedAt }, on, NOW)).toBe(true);
    expect(isAutoReminderDue({ ...base, lastRemindedAt: new Date(lastRemindedAt.getTime() + 1) }, on, NOW)).toBe(false);
  });

  it('never when reminders are off, the cap is reached, or the request is not open', () => {
    expect(isAutoReminderDue(base, on, NOW)).toBe(true);
    expect(isAutoReminderDue(base, { defaultExpiryDays: 30, autoReminder: null }, NOW)).toBe(false);
    expect(isAutoReminderDue({ ...base, reminderCount: 2 }, on, NOW)).toBe(false);
    expect(isAutoReminderDue({ ...base, status: 'viewed' }, on, NOW)).toBe(true);
    for (const status of ['draft', 'signed', 'declined', 'voided', 'expired'] as const) {
      expect(isAutoReminderDue({ ...base, status }, on, NOW)).toBe(false);
    }
  });

  it('never once the request has expired (instant boundary) or its link was revoked', () => {
    expect(isAutoReminderDue({ ...base, expiresAt: NOW }, on, NOW)).toBe(false);
    expect(isAutoReminderDue({ ...base, publicLinkRevokedAt: new Date(NOW.getTime() - DAY) }, on, NOW)).toBe(false);
  });
});
