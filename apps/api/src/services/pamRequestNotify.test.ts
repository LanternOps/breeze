import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insertQueuedCommandInTransaction: vi.fn(),
}));

vi.mock('./commandQueueInsert', () => ({
  insertQueuedCommandInTransaction: mocks.insertQueuedCommandInTransaction,
}));

import { ParkedDeviceCommandRefusedError } from './unassignedPool/deliveryEligibility';
import {
  PAM_REQUEST_NOTIFY_DELIVER_MS,
  PAM_USER_REASON_MAX,
  enqueuePamRequestNotify,
  sanitizePamUserReason,
} from './pamRequestNotify';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';

/**
 * A caller transaction whose `transaction()` opens a savepoint `sp`. The
 * capability read and the insert must both run on `sp`, never on the outer
 * tx, so a failed statement rolls back to the savepoint only.
 */
function makeTx(deviceRow: { orgId: string; pamUserNotifyProtocolVersion: number } | undefined) {
  const limit = vi.fn().mockResolvedValue(deviceRow ? [deviceRow] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const sp = { select: vi.fn().mockReturnValue({ from }) };
  const outerSelect = vi.fn();
  const tx = {
    select: outerSelect,
    transaction: vi.fn(async (fn: (s: typeof sp) => Promise<unknown>) => fn(sp)),
  };
  return { tx, sp, outerSelect };
}

describe('sanitizePamUserReason (#8928)', () => {
  it('sanitizes and caps reason', () => {
    expect(sanitizePamUserReason('a\u0007b\r\nc')).toBe('ab\nc');
    expect(sanitizePamUserReason('a\n\n\n\nb')).toBe('a\n\nb');
    const long = sanitizePamUserReason('x'.repeat(2000))!;
    expect(Array.from(long)).toHaveLength(PAM_USER_REASON_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(sanitizePamUserReason('  ')).toBeUndefined();
    expect(sanitizePamUserReason('')).toBeUndefined();
    expect(sanitizePamUserReason(null)).toBeUndefined();
    expect(sanitizePamUserReason(undefined)).toBeUndefined();
  });

  it('cuts by code points, never splitting a surrogate pair', () => {
    const out = sanitizePamUserReason('😀'.repeat(600))!;
    const points = Array.from(out);
    expect(points).toHaveLength(PAM_USER_REASON_MAX);
    expect(points.slice(0, -1).every((p) => p === '😀')).toBe(true);
    expect(points.at(-1)).toBe('…');
  });

  it('keeps a reason at exactly the cap untouched', () => {
    const exact = 'y'.repeat(PAM_USER_REASON_MAX);
    expect(sanitizePamUserReason(exact)).toBe(exact);
  });

  it('turns a tab into a space and drops a lone CR and DEL', () => {
    expect(sanitizePamUserReason('a\tb\rc\u007fd')).toBe('a bcd');
  });
});

describe('enqueuePamRequestNotify (#8928)', () => {
  beforeEach(() => {
    mocks.insertQueuedCommandInTransaction.mockReset();
    mocks.insertQueuedCommandInTransaction.mockResolvedValue({ id: 'cmd-1' });
  });

  it('returns unsupported and inserts nothing when the device reports capability 0', async () => {
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 0 });
    await expect(enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'denied', 'no'))
      .resolves.toBe('unsupported');
    expect(mocks.insertQueuedCommandInTransaction).not.toHaveBeenCalled();
  });

  it('returns unsupported when the device row is not visible', async () => {
    const { tx } = makeTx(undefined);
    await expect(enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'expired'))
      .resolves.toBe('unsupported');
    expect(mocks.insertQueuedCommandInTransaction).not.toHaveBeenCalled();
  });

  it('queues a denied notice with exactly requestId, outcome and the sanitized reason, inside a savepoint', async () => {
    const { tx, sp, outerSelect } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    const before = Date.now();
    await expect(enqueuePamRequestNotify(
      tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'denied', 'Not approved\r\n\r\n\r\nAsk your manager',
    )).resolves.toBe('queued');

    expect(tx.transaction).toHaveBeenCalledTimes(1);
    expect(outerSelect).not.toHaveBeenCalled();
    expect(mocks.insertQueuedCommandInTransaction).toHaveBeenCalledTimes(1);
    const [insertTx, input] = mocks.insertQueuedCommandInTransaction.mock.calls[0]!;
    expect(insertTx).toBe(sp);
    expect(input.deviceId).toBe(DEVICE_ID);
    expect(input.type).toBe('pam_request_notify');
    expect(input.createdBy).toBeNull();
    expect(input.submittedOrgId).toBe(ORG_ID);
    expect(input.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(input.payload).toEqual({
      requestId: REQUEST_ID,
      outcome: 'denied',
      reason: 'Not approved\n\nAsk your manager',
    });
    const deliverBy = (input.deliverBy as Date).getTime();
    expect(deliverBy).toBeGreaterThanOrEqual(before + PAM_REQUEST_NOTIFY_DELIVER_MS);
    expect(deliverBy).toBeLessThanOrEqual(Date.now() + PAM_REQUEST_NOTIFY_DELIVER_MS);
    expect(PAM_REQUEST_NOTIFY_DELIVER_MS).toBe(60 * 60 * 1000);
  });

  it('omits the reason key for a denied notice whose reason is blank', async () => {
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    await enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'denied', '   ');
    expect(mocks.insertQueuedCommandInTransaction.mock.calls[0]![1].payload).toEqual({
      requestId: REQUEST_ID, outcome: 'denied',
    });
  });

  it('never sends a reason with an expired notice', async () => {
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    await enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'expired', 'ignored');
    const payload = mocks.insertQueuedCommandInTransaction.mock.calls[0]![1].payload;
    expect(payload).toEqual({ requestId: REQUEST_ID, outcome: 'expired' });
    expect('reason' in payload).toBe(false);
  });

  it('parked device: deny commits, no command — a refused insert is swallowed as skipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    mocks.insertQueuedCommandInTransaction.mockRejectedValueOnce(new ParkedDeviceCommandRefusedError(DEVICE_ID, 'pam_request_notify'));
    await expect(enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'denied', 'x'))
      .resolves.toBe('skipped');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('any other enqueue failure is also skipped, never thrown to the deciding transaction', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    mocks.insertQueuedCommandInTransaction.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'expired'))
      .resolves.toBe('skipped');
    warn.mockRestore();
  });
});
