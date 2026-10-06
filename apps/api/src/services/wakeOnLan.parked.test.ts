import { beforeEach, describe, expect, it, vi } from 'vitest';

// Devices parked in a holding org, by id. The helper's query is proven against
// Postgres in parkedCommandDelivery.integration.test.ts.
const parkedDeviceIds = vi.hoisted(() => new Set<string>());
vi.mock('./unassignedPool/deliveryEligibility', async () => ({
  ...(await vi.importActual<typeof import('./unassignedPool/deliveryEligibility')>(
    './unassignedPool/deliveryEligibility',
  )),
  isParkedDevice: vi.fn(async (_reader: unknown, deviceId: string) => parkedDeviceIds.has(deviceId)),
}));

const { selectMock, insertMock } = vi.hoisted(() => ({ selectMock: vi.fn(), insertMock: vi.fn() }));
vi.mock('../db', () => ({
  db: {
    select: (...a: unknown[]) => selectMock(...(a as [])),
    insert: (...a: unknown[]) => insertMock(...(a as [])),
  },
}));
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn(),
  releaseClaimedCommandDelivery: vi.fn(),
}));
vi.mock('../routes/agentWs', () => ({ isAgentConnected: vi.fn(() => true), sendCommandToAgent: vi.fn() }));
vi.mock('./commandQueue', () => ({ CommandTypes: { WAKE_ON_LAN: 'wake_on_lan' } }));

import { dispatchWake } from './wakeOnLan';
import { sendCommandToAgent } from '../routes/agentWs';

const TARGET = '11111111-1111-4111-8111-111111111111';

describe('dispatchWake for a device parked in a holding org', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parkedDeviceIds.clear();
    selectMock.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: TARGET, orgId: 'pool-org', siteId: 'pool-site', hostname: 'h' }],
        }),
      }),
    });
  });

  it('refuses before resolving a relay or writing a command', async () => {
    parkedDeviceIds.add(TARGET);

    const result = await dispatchWake(TARGET, 'user-1');

    expect(result).toMatchObject({ ok: false, code: 'DEVICE_PENDING_ASSIGNMENT' });
    // Only the target lookup ran: no MAC, subnet or relay reads.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });
  it('refuses when the chosen relay is parked, before the relay row is written', async () => {
    const RELAY = '22222222-2222-4222-8222-222222222222';
    /** One select chain answering `rows` however it is terminated. */
    const chain = (rows: unknown[]) => {
      const where = () => Object.assign(Promise.resolve(rows), {
        limit: async () => rows,
        orderBy: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
      });
      return { from: () => ({ where }) };
    };
    selectMock
      .mockReturnValueOnce(chain([{ id: TARGET, orgId: 'org-1', siteId: 'site-1', hostname: 'target' }]))
      .mockReturnValueOnce(chain([{ mac: 'aa:bb:cc:dd:ee:ff', isPrimary: true, updatedAt: new Date() }]))
      .mockReturnValueOnce(chain([{ ip: '192.168.1.20', mask: '255.255.255.0', lastSeen: new Date() }]))
      .mockReturnValueOnce(chain([{ id: RELAY, agentId: 'relay-agent', hostname: 'relay', siteId: 'site-1', status: 'online' }]));
    parkedDeviceIds.add(RELAY);

    const result = await dispatchWake(TARGET, 'user-1', { relayDeviceIdOverride: RELAY });

    expect(result).toMatchObject({ ok: false, code: 'DEVICE_PENDING_ASSIGNMENT' });
    expect(insertMock).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });
});

describe('dispatchWake when the push claim cancels the wake command', () => {
  it('reports COMMAND_CANCELLED with the reason and sends nothing', async () => {
    const { claimPendingCommandForDelivery, releaseClaimedCommandDelivery } = await import('./commandDispatch');
    vi.clearAllMocks();
    parkedDeviceIds.clear();
    const RELAY = '22222222-2222-4222-8222-222222222222';
    const chain = (rows: unknown[]) => {
      const where = () => Object.assign(Promise.resolve(rows), {
        limit: async () => rows,
        orderBy: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
      });
      return { from: () => ({ where }) };
    };
    selectMock
      .mockReturnValueOnce(chain([{ id: TARGET, orgId: 'org-1', siteId: 'site-1', hostname: 'target' }]))
      .mockReturnValueOnce(chain([{ mac: 'aa:bb:cc:dd:ee:ff', isPrimary: true, updatedAt: new Date() }]))
      .mockReturnValueOnce(chain([{ ip: '192.168.1.20', mask: '255.255.255.0', lastSeen: new Date() }]))
      .mockReturnValueOnce(chain([{ id: RELAY, agentId: 'relay-agent', hostname: 'relay', siteId: 'site-1', status: 'online' }]));
    insertMock.mockReturnValue({
      values: () => Object.assign(Promise.resolve(undefined), {
        returning: async () => [{ id: 'wake-cmd' }],
      }),
    });
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({
      status: 'cancelled', id: 'wake-cmd', reason: 'requester_inactive',
    });

    const result = await dispatchWake(TARGET, 'user-1', { relayDeviceIdOverride: RELAY });

    expect(result).toMatchObject({
      ok: false,
      code: 'COMMAND_CANCELLED',
      message: expect.stringContaining('requester_inactive'),
    });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(releaseClaimedCommandDelivery).not.toHaveBeenCalled();
  });
});
