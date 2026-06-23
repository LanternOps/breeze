import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateMock = vi.fn();
const runOutsideDbContextMock = vi.fn(async (fn: () => Promise<unknown> | unknown) => fn());
const withSystemDbAccessContextMock = vi.fn(async (fn: () => Promise<unknown> | unknown) => fn());

function updateChain() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

vi.mock('../db', () => ({
  db: {
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  runOutsideDbContext: (...args: unknown[]) => runOutsideDbContextMock(...(args as [any])),
  withSystemDbAccessContext: (...args: unknown[]) => withSystemDbAccessContextMock(...(args as [any])),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    agentVersion: 'devices.agent_version',
    watchdogVersion: 'devices.watchdog_version',
    updatedAt: 'devices.updated_at',
  },
}));

import { applyCompletedComponentUpdateVersion } from './componentUpdateResults';

describe('applyCompletedComponentUpdateVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockReturnValue(updateChain());
    runOutsideDbContextMock.mockImplementation(async (fn: () => Promise<unknown> | unknown) => fn());
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown> | unknown) => fn());
  });

  it('stamps watchdogVersion after a completed watchdog reinstall/update', async () => {
    const applied = await applyCompletedComponentUpdateVersion({
      deviceId: 'device-1',
      type: 'update_watchdog',
      targetRole: 'agent',
      payload: { version: '0.82.1' },
    }, 'completed', { updated_to: '0.82.1' });

    expect(applied).toBe(true);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      watchdogVersion: 'devices.watchdog_version',
    }));
    const chain = updateMock.mock.results[0]?.value;
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({
      watchdogVersion: '0.82.1',
      updatedAt: expect.any(Date),
    }));
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
  });

  it('stamps agentVersion after a completed agent update executed by the watchdog', async () => {
    const applied = await applyCompletedComponentUpdateVersion({
      deviceId: 'device-1',
      type: 'update_agent',
      targetRole: 'watchdog',
      payload: { version: '0.82.1' },
    }, 'completed', { updated_to: '0.82.1' });

    expect(applied).toBe(true);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      agentVersion: 'devices.agent_version',
    }));
    const chain = updateMock.mock.results[0]?.value;
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({
      agentVersion: '0.82.1',
      updatedAt: expect.any(Date),
    }));
  });

  it('does not stamp versions for failed or role-mismatched commands', async () => {
    await expect(applyCompletedComponentUpdateVersion({
      deviceId: 'device-1',
      type: 'update_watchdog',
      targetRole: 'agent',
      payload: { version: '0.82.1' },
    }, 'failed', { updated_to: '0.82.1' })).resolves.toBe(false);

    await expect(applyCompletedComponentUpdateVersion({
      deviceId: 'device-1',
      type: 'update_watchdog',
      targetRole: 'watchdog',
      payload: { version: '0.82.1' },
    }, 'completed', { updated_to: '0.82.1' })).resolves.toBe(false);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not stamp versions when the executor does not confirm the installed target', async () => {
    await expect(applyCompletedComponentUpdateVersion({
      deviceId: 'device-1',
      type: 'update_watchdog',
      targetRole: 'agent',
      payload: { version: '0.82.1' },
    }, 'completed')).resolves.toBe(false);

    await expect(applyCompletedComponentUpdateVersion({
      deviceId: 'device-1',
      type: 'update_watchdog',
      targetRole: 'agent',
      payload: { version: '0.82.1' },
    }, 'completed', { updated_to: '0.82.0' })).resolves.toBe(false);

    expect(updateMock).not.toHaveBeenCalled();
  });
});
