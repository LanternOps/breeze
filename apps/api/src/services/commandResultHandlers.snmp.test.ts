import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMock, setMock, whereMock, returningMock } = vi.hoisted(() => ({
  updateMock: vi.fn(), setMock: vi.fn(), whereMock: vi.fn(), returningMock: vi.fn(),
}));
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return { ...actual, db: { ...actual.db, update: updateMock }, runOutsideDbContext: (fn: () => unknown) => fn() };
});
vi.mock('../jobs/discoveryWorker', () => ({ enqueueDiscoveryResults: vi.fn() }));
vi.mock('../jobs/snmpWorker', () => ({ enqueueSnmpPollResults: vi.fn() }));
vi.mock('./redis', () => ({ isRedisAvailable: vi.fn(() => true), getRedis: vi.fn(() => null) }));
import { commandResultHandlers, type CommandResultHandler } from './commandResultHandlers';
import { enqueueSnmpPollResults } from '../jobs/snmpWorker';
import { isRedisAvailable } from './redis';
import { snmpDevices } from '../db/schema';
import { eq } from 'drizzle-orm';

const SNMP_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const metrics = [{ oid: '1.3.6.1.2.1.1.3.0', name: 'uptime', value: 42, timestamp: '2026-09-16T12:00:00Z' }];
function input(result: Parameters<CommandResultHandler>[0]['result']): Parameters<CommandResultHandler>[0] {
  return { agentId: 'agent-1', commandId: '44444444-4444-4444-8444-444444444444',
    command: { type: 'snmp_poll', payload: { deviceId: SNMP_ID } } as never,
    resolvedDeviceId: DEVICE_ID, result, stdout: undefined };
}

describe('SNMP poll command outcomes', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockReturnValue({ set: setMock });
    setMock.mockReturnValue({ where: whereMock });
    whereMock.mockReturnValue({ returning: returningMock });
    returningMock.mockResolvedValue([{ orgId: ORG_ID }]);
    vi.mocked(isRedisAvailable).mockReturnValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each(['failed', 'timeout'] as const)('persists a %s result without metrics or a result payload', async (status) => {
    const error = `SNMP walk failed: ${'x'.repeat(600)}`;
    await commandResultHandlers.snmp_poll!(input({ status, error }));
    expect(updateMock).toHaveBeenCalledWith(snmpDevices);
    expect(setMock).toHaveBeenCalledWith({ lastError: error.slice(0, 500), lastErrorAt: expect.any(Date), lastStatus: 'warning' });
    expect(whereMock).toHaveBeenCalledWith(eq(snmpDevices.id, SNMP_ID));
    expect(console.warn).toHaveBeenCalledWith('[AgentWs] SNMP poll failed', {
      deviceId: DEVICE_ID, orgId: ORG_ID, snmpDeviceId: SNMP_ID, error: error.slice(0, 500),
    });
    expect(enqueueSnmpPollResults).not.toHaveBeenCalled();
  });

  it('handles an explicit success:false payload even if metrics are present', async () => {
    await commandResultHandlers.snmp_poll!(input({ status: 'completed', error: 'walk failed', result: { deviceId: SNMP_ID, success: false, metrics } }));
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ lastError: 'walk failed', lastStatus: 'warning' }));
    expect(enqueueSnmpPollResults).not.toHaveBeenCalled();
  });

  it.each([true, false])('clears the previous error on success (Redis available: %s)', async (redisAvailable) => {
    vi.mocked(isRedisAvailable).mockReturnValue(redisAvailable);
    await commandResultHandlers.snmp_poll!(input({ status: 'completed', result: { deviceId: SNMP_ID, metrics, protocol: 2 } }));
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ lastError: null, lastErrorAt: null }));
    if (redisAvailable) expect(enqueueSnmpPollResults).toHaveBeenCalledWith(SNMP_ID, metrics, undefined, 2);
  });

  it('provides a short fallback when a failure has no error string', async () => {
    await commandResultHandlers.snmp_poll!(input({ status: 'failed' }));
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ lastError: 'SNMP poll failed' }));
  });

  it('redacts recognized secrets before persisting or logging', async () => {
    await commandResultHandlers.snmp_poll!(input({ status: 'failed', error: 'SNMP password=abcdefgh failed' }));
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ lastError: 'SNMP password=[REDACTED] failed' }));
    expect(console.warn).toHaveBeenCalledWith('[AgentWs] SNMP poll failed', expect.objectContaining({ error: 'SNMP password=[REDACTED] failed' }));
  });

  it('does not report a persisted failure when the org-scoped update matches no row', async () => {
    returningMock.mockResolvedValueOnce([]);
    await commandResultHandlers.snmp_poll!(input({ status: 'failed', error: 'timeout' }));
    expect(whereMock).toHaveBeenCalledWith(eq(snmpDevices.id, SNMP_ID));
    expect(console.warn).not.toHaveBeenCalled();
    expect(enqueueSnmpPollResults).not.toHaveBeenCalled();
  });

  it('does not accept a failure for a different target', async () => {
    await commandResultHandlers.snmp_poll!(input({ status: 'failed', error: 'forged', result: { deviceId: DEVICE_ID } }));
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not persist a failure without a dispatched target', async () => {
    const params = input({ status: 'failed', error: 'timeout' });
    params.command.payload = {};
    await commandResultHandlers.snmp_poll!(params);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('clears a previous error for a successful empty poll', async () => {
    await commandResultHandlers.snmp_poll!(input({ status: 'completed', result: { deviceId: SNMP_ID, metrics: [] } }));
    expect(setMock).toHaveBeenCalledWith({ lastError: null, lastErrorAt: null });
    expect(enqueueSnmpPollResults).not.toHaveBeenCalled();
  });

  it('keeps an existing error when a completed result has no metrics payload', async () => {
    await commandResultHandlers.snmp_poll!(input({ status: 'completed', result: { deviceId: SNMP_ID } }));
    expect(updateMock).not.toHaveBeenCalled();
  });
});
