import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  assertCommandDeliverable,
  isParkedDeliverableCommandType,
  isParkedDevice,
  ParkedDeviceCommandRefusedError,
  PARKED_DELIVERABLE_COMMAND_TYPES,
  PARKED_DEVICE_COMMAND_REFUSAL_CODE,
  type DeliveryEligibilityReader,
} from './deliveryEligibility';
import { DRAIN_CLAIM_TYPE_ALLOWLIST } from '../drainClaimAllowlist';

/** A reader whose one resolver call answers `parked` (null = no row at all). */
function readerReturning(parked: boolean | null) {
  const execute = vi.fn().mockResolvedValue(parked === null ? [] : [{ parked }]);
  return { reader: { execute } as unknown as DeliveryEligibilityReader, execute };
}
describe('isParkedDevice', () => {
  it('asks the SECURITY DEFINER resolver, so the answer does not depend on what the caller can see', async () => {
    const { reader, execute } = readerReturning(true);
    await expect(isParkedDevice(reader, 'device-1')).resolves.toBe(true);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toContain('public.breeze_device_is_pending_assignment(');
    expect(query.params).toEqual(['device-1']);
  });

  it('is false when the resolver says so', async () => {
    const { reader } = readerReturning(false);
    await expect(isParkedDevice(reader, 'device-1')).resolves.toBe(false);
  });

  it('is false (not parked) when the resolver returns no row', async () => {
    const { reader } = readerReturning(null);
    await expect(isParkedDevice(reader, 'device-missing')).resolves.toBe(false);
  });
});

describe('assertCommandDeliverable', () => {
  it('refuses every non-lifecycle type for a parked device', async () => {
    const { reader } = readerReturning(true);
    const refusal = assertCommandDeliverable(reader, { deviceId: 'device-1', commandType: 'script' });
    await expect(refusal).rejects.toBeInstanceOf(ParkedDeviceCommandRefusedError);
    await expect(refusal).rejects.toMatchObject({
      code: 'DEVICE_PENDING_ASSIGNMENT',
      status: 409,
      deviceId: 'device-1',
      commandType: 'script',
    });
  });

  it('allows lifecycle removal for a parked device without reading the device', async () => {
    const { reader, execute } = readerReturning(true);
    await expect(
      assertCommandDeliverable(reader, { deviceId: 'device-1', commandType: 'self_uninstall' }),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows any type for a device in an ordinary org', async () => {
    const { reader } = readerReturning(false);
    await expect(
      assertCommandDeliverable(reader, { deviceId: 'device-1', commandType: 'script' }),
    ).resolves.toBeUndefined();
  });

  it('renders a 409 body carrying the machine-readable code', async () => {
    const err = new ParkedDeviceCommandRefusedError('device-1', 'script');
    const res = err.getResponse();
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'DEVICE_PENDING_ASSIGNMENT' });
  });
});

describe('parked-deliverable command types', () => {
  it('is the drain allowlist itself, not a restatement', () => {
    expect(PARKED_DELIVERABLE_COMMAND_TYPES).toBe(DRAIN_CLAIM_TYPE_ALLOWLIST);
    expect(PARKED_DEVICE_COMMAND_REFUSAL_CODE).toBe('DEVICE_PENDING_ASSIGNMENT');
  });

  it.each([
    ['self_uninstall', true],
    ['script', false],
    ['desktop_stream_stop', false],
    ['reboot', false],
  ] as const)('isParkedDeliverableCommandType(%s) is %s', (type, expected) => {
    expect(isParkedDeliverableCommandType(type)).toBe(expected);
  });
});
