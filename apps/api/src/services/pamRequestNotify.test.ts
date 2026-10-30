import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insertQueuedCommandInTransaction: vi.fn(),
  captureException: vi.fn(),
  resolveTechnicianName: vi.fn(),
}));

vi.mock('./commandQueueInsert', () => ({
  insertQueuedCommandInTransaction: mocks.insertQueuedCommandInTransaction,
}));

vi.mock('./sentry', () => ({ captureException: mocks.captureException }));

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
    mocks.captureException.mockReset();
    mocks.insertQueuedCommandInTransaction.mockReset();
    mocks.insertQueuedCommandInTransaction.mockResolvedValue({ id: 'cmd-1' });
    mocks.resolveTechnicianName.mockReset();
    mocks.resolveTechnicianName.mockResolvedValue(null);
  });

  it('returns unsupported and inserts nothing when the device reports capability 0', async () => {
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 0 });
    await expect(enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'denied', 'no'))
      .resolves.toBe('unsupported');
    expect(mocks.insertQueuedCommandInTransaction).not.toHaveBeenCalled();
  });

  it('returns unsupported when the device row is not visible, and logs it apart from an old agent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tx } = makeTx(undefined);
    await expect(enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'expired'))
      .resolves.toBe('unsupported');
    expect(mocks.insertQueuedCommandInTransaction).not.toHaveBeenCalled();
    // Zero rows under the caller's context is a context bug, not an old agent.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('device row not visible');
    expect(String(warn.mock.calls[0]![0])).toContain(DEVICE_ID);
    warn.mockRestore();
  });

  it('logs nothing for a device that simply lacks the capability', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 0 });
    await enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'denied');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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
      decidedBy: { technicianName: null },
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
      requestId: REQUEST_ID, outcome: 'denied', decidedBy: { technicianName: null },
    });
  });

  it('never sends a reason with an expired notice', async () => {
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    await enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'expired', 'ignored');
    const payload = mocks.insertQueuedCommandInTransaction.mock.calls[0]![1].payload;
    expect(payload).toEqual({ requestId: REQUEST_ID, outcome: 'expired', decidedBy: { technicianName: null } });
    expect('reason' in payload).toBe(false);
  });

  it('carries decidedBy.technicianName for a technician deny, resolved for the device after the capability check (#10190 W07)', async () => {
    mocks.resolveTechnicianName.mockResolvedValue('Dana Tech');
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    await enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'denied', 'no', mocks.resolveTechnicianName);
    expect(mocks.resolveTechnicianName).toHaveBeenCalledTimes(1);
    const payload = mocks.insertQueuedCommandInTransaction.mock.calls[0]![1].payload;
    expect(payload.decidedBy).toEqual({ technicianName: 'Dana Tech' });
    // email never present, anywhere in the payload
    expect(JSON.stringify(payload)).not.toMatch(/email/i);
  });

  it('technicianName null at generic level (the resolver decides) and for an expiry, which never resolves a name', async () => {
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    await enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'expired', undefined, mocks.resolveTechnicianName);
    expect(mocks.resolveTechnicianName).not.toHaveBeenCalled();
    expect(mocks.insertQueuedCommandInTransaction.mock.calls[0]![1].payload.decidedBy).toEqual({ technicianName: null });
  });

  it('a resolver that throws skips the notice like any enqueue failure; the deny still commits', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.resolveTechnicianName.mockRejectedValue(new Error('boom'));
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    await expect(enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'denied', 'no', mocks.resolveTechnicianName))
      .resolves.toBe('skipped');
    error.mockRestore();
  });

  it('queues for capability 2 (#10190 W07) and refuses an unknown capability 3', async () => {
    const two = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 2 });
    await expect(enqueuePamRequestNotify(two.tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'expired')).resolves.toBe('queued');
    const three = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 3 });
    await expect(enqueuePamRequestNotify(three.tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'expired')).resolves.toBe('unsupported');
  });

  it('never resolves a name for a device that cannot take the notice', async () => {
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 0 });
    await enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'denied', 'no', mocks.resolveTechnicianName);
    expect(mocks.resolveTechnicianName).not.toHaveBeenCalled();
  });

  it('parked device: deny commits, no command — the expected refusal is logged at info, not reported', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    mocks.insertQueuedCommandInTransaction.mockRejectedValueOnce(new ParkedDeviceCommandRefusedError(DEVICE_ID, 'pam_request_notify'));
    await expect(enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'denied', 'x'))
      .resolves.toBe('skipped');
    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
    info.mockRestore();
    error.mockRestore();
  });

  it('any other enqueue failure is skipped (never thrown to the deciding transaction) but logged as an error and sent to Sentry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    const failure = Object.assign(new Error('column "pam_user_notify_protocol_version" does not exist'), { code: '42703' });
    mocks.insertQueuedCommandInTransaction.mockRejectedValueOnce(failure);
    await expect(enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'expired'))
      .resolves.toBe('skipped');
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls[0]!.map(String).join(' ');
    expect(logged).toContain(REQUEST_ID);
    expect(logged).toContain(DEVICE_ID);
    expect(logged).toContain('42703');
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledWith(failure, undefined, expect.objectContaining({
      errorId: 'pam_request_notify_enqueue_failed',
      requestId: REQUEST_ID,
      deviceId: DEVICE_ID,
      outcome: 'expired',
      pg_code: '42703',
    }));
    error.mockRestore();
  });

  it('a failure that is not an Error is still reported as one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tx } = makeTx({ orgId: ORG_ID, pamUserNotifyProtocolVersion: 1 });
    mocks.insertQueuedCommandInTransaction.mockRejectedValueOnce('boom');
    await expect(enqueuePamRequestNotify(tx as never, { id: REQUEST_ID, deviceId: DEVICE_ID }, 'denied'))
      .resolves.toBe('skipped');
    expect(mocks.captureException.mock.calls[0]![0]).toBeInstanceOf(Error);
    error.mockRestore();
  });
});
